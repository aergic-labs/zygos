/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Busybox bootstrap on the remote.
 *
 * Vendored static busybox binaries (x64, arm64) ship in tools/busybox/.
 * On first connect the binary is streamed over SSH stdin using only `cat`,
 * `chmod`, `mkdir` (all universal POSIX utilities). After that every
 * command runs through the vendored sh with busybox at the front of PATH.
 *
 * Two phases:
 *   1. Probe (raw login shell): printenv HOME, uname -m, test -x
 *   2. Bootstrap (if needed): cat > busybox, chmod, --install -s
 *   3. Post-bootstrap: everything via busybox sh
 *
 * Install location: $HOME/.ssh-remote/bin/ (persists across reboots,
 * avoids /tmp noexec).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SshConnection, ExecResult } from "../ssh/connection";
import type { Logger } from "../common/logger";

/** Subdirectory under $HOME for the vendored toolset. */
export const REMOTE_DIR_NAME = ".ssh-remote";
/** Full path to the busybox tools dir on the remote. */
export function remoteToolsDir(home: string): string {
  return `${home}/${REMOTE_DIR_NAME}/bin`;
}
/** Path to the busybox binary itself on the remote. */
export function remoteBusyboxPath(home: string): string {
  return `${remoteToolsDir(home)}/busybox`;
}
/** Path to the vendored sh on the remote. */
export function remoteShPath(home: string): string {
  return `${remoteToolsDir(home)}/sh`;
}

/** Local path to the bundled busybox binary for a given arch. */
export function localBusyboxPath(extensionPath: string, arch: string): string {
  return path.join(extensionPath, "tools", "busybox", `bb-${arch}`);
}

/**
 * Shell-quote a string for safe embedding inside single quotes.
 * Produces 'foo'\''bar' for a string containing foo'bar.
 */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Run a command via the vendored busybox sh, with busybox tools at the
 * front of PATH. Use this for anything after bootstrap - gives a known
 * POSIX environment regardless of the remote's login shell or utilities.
 */
export async function bbExec(
  conn: SshConnection,
  home: string,
  command: string,
): Promise<ExecResult> {
  const toolsDir = remoteToolsDir(home);
  const sh = remoteShPath(home);
  const wrapped = `export PATH=${shellQuote(toolsDir)}:$PATH; ${command}`;
  return conn.exec(`${sh} -c ${shellQuote(wrapped)}`);
}

/** Same as bbExec but streams stdin data into the command. */
export async function bbExecWithStdin(
  conn: SshConnection,
  home: string,
  command: string,
  stdin: Buffer,
): Promise<ExecResult> {
  const toolsDir = remoteToolsDir(home);
  const sh = remoteShPath(home);
  const wrapped = `export PATH=${shellQuote(toolsDir)}:$PATH; ${command}`;
  return conn.execWithStdin(`${sh} -c ${shellQuote(wrapped)}`, stdin);
}

// --- Probe phase (raw login shell, minimal assumptions) ---

/** Detect $HOME on the remote. Falls back to /tmp if unset (broken box). */
export async function probeHome(conn: SshConnection): Promise<string> {
  const result = await conn.exec("printenv HOME");
  const home = result.stdout.trim();
  return home || "/tmp";
}

/** Detect architecture via uname -m. Maps to x64/arm64. */
export async function probeArch(conn: SshConnection): Promise<string> {
  const result = await conn.exec("uname -m");
  if (result.exitCode !== 0) {
    throw new Error(`Failed to detect architecture: ${result.stderr}`);
  }
  return normalizeArch(result.stdout);
}

/** Map uname -m output to our arch identifier. */
export function normalizeArch(unameArch: string): string {
  const trimmed = unameArch.trim();
  switch (trimmed) {
    case "x86_64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      throw new Error(`Unsupported remote architecture: "${trimmed}"`);
  }
}

/** Check whether busybox is already bootstrapped on the remote. */
export async function isBootstrapped(
  conn: SshConnection,
  home: string,
): Promise<boolean> {
  const sh = remoteShPath(home);
  const result = await conn.exec(`test -x ${shellQuote(sh)}`);
  return result.exitCode === 0;
}

// --- Bootstrap phase (cat, chmod, mkdir only) ---

/**
 * Install the vendored busybox on the remote. Uses only cat (write binary
 * via stdin), chmod (make executable), and busybox's own --install -s to
 * create symlinks for all applets (sh, tar, gzip, mkdir, test, etc.).
 */
export async function bootstrapBusybox(
  conn: SshConnection,
  home: string,
  arch: string,
  extensionPath: string,
  logger: Logger,
): Promise<void> {
  const toolsDir = remoteToolsDir(home);
  const bbPath = remoteBusyboxPath(home);

  // Read the local binary.
  const localPath = localBusyboxPath(extensionPath, arch);
  const busyboxBuf = fs.readFileSync(localPath);
  logger.info(`[busybox] read ${busyboxBuf.length} bytes from ${localPath}`);

  // 1. mkdir -p the tools dir (mkdir is universal).
  logger.info(`[busybox] mkdir -p ${toolsDir}...`);
  const mkdirResult = await conn.exec(`mkdir -p ${shellQuote(toolsDir)}`);
  if (mkdirResult.exitCode !== 0) {
    throw new Error(`Failed to create ${toolsDir}: ${mkdirResult.stderr}`);
  }

  // 2. Write the binary via cat (cat is universal).
  logger.info(`[busybox] writing busybox binary via cat...`);
  const writeResult = await conn.execWithStdin(
    `cat > ${shellQuote(bbPath)}`,
    busyboxBuf,
  );
  if (writeResult.exitCode !== 0) {
    throw new Error(`Failed to write busybox: ${writeResult.stderr}`);
  }

  // 3. chmod +x (chmod is universal).
  logger.info(`[busybox] chmod +x...`);
  const chmodResult = await conn.exec(`chmod +x ${shellQuote(bbPath)}`);
  if (chmodResult.exitCode !== 0) {
    throw new Error(`Failed to chmod busybox: ${chmodResult.stderr}`);
  }

  // 4. Verify it runs (catches /tmp noexec, corrupted binary, etc.).
  const verifyResult = await conn.exec(`${shellQuote(bbPath)} true`);
  if (verifyResult.exitCode !== 0) {
    throw new Error(
      `Busybox binary won't execute at ${bbPath} - check for noexec mount ` +
        `(exit ${verifyResult.exitCode}): ${verifyResult.stderr}`,
    );
  }

  // 5. Install all applets as symlinks.
  logger.info(`[busybox] installing applets to ${toolsDir}...`);
  const installResult = await conn.exec(
    `${shellQuote(bbPath)} --install -s ${shellQuote(toolsDir)}`,
  );
  if (installResult.exitCode !== 0) {
    throw new Error(
      `Failed to install busybox applets: ${installResult.stderr}`,
    );
  }

  logger.info(`[busybox] bootstrap complete`);
}
