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
 * Phases:
 *   1. Probe (single call): HOME, arch, busybox present, install present.
 *   2. Bootstrap (if needed, single call): stream binary + mkdir/chmod/install.
 *   3. Post-bootstrap: everything via busybox sh.
 *
 * Install location: $HOME/.ssh-remote/bin/ (persists across reboots,
 * avoids /tmp noexec).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
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

// --- Probe phase (single call, raw login shell) ---

export interface RemoteProbe {
  home: string;
  arch: string;
  busyboxPresent: boolean;
  installPresent: boolean;
}

/**
 * Single-call probe: HOME, arch, busybox presence, and whether the server
 * is already installed for the given commit. Replaces the prior 2-4 call
 * sequence (probeHome + probeArch + isBootstrapped + check install).
 *
 * Output protocol: a per-invocation nonce marker line, then one field per
 * line (home, arch, busybox, installed). The parser anchors on the exact
 * nonce and ignores anything before it, so shell-init output (e.g. zsh
 * .zshenv echo lines, BASH_ENV scripts) can't corrupt the fields. A nonce
 * generated milliseconds ago on the client can't appear in rc noise.
 */
export async function probeRemote(
  conn: SshConnection,
  serverDataFolderName: string,
  commit: string,
): Promise<RemoteProbe> {
  const marker = `ZYPROBE-${crypto.randomBytes(8).toString("hex")}`;

  const cmd =
    `h=$(printenv HOME); ` +
    `a=$(uname -m); ` +
    `b=no; [ -x "$h/${REMOTE_DIR_NAME}/bin/sh" ] && b=yes; ` +
    `i=no; [ -f "$h/${serverDataFolderName}/bin/${commit}/node" ] && i=yes; ` +
    `printf '%s\\n' ${shellQuote(marker)}; ` +
    `printf '%s\\n' "$h" "$a" "$b" "$i"`;

  const result = await conn.exec(cmd);
  if (result.exitCode !== 0) {
    throw new Error(
      `Remote probe failed (exit ${result.exitCode}): ${result.stderr || result.stdout.slice(0, 200)}`,
    );
  }

  const lines = result.stdout.split("\n").map((l) => l.replace(/\r$/, ""));
  const markerIdx = lines.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error(
      `Remote probe: marker not found in output: ${result.stdout.slice(0, 200)}`,
    );
  }
  const fields = lines.slice(markerIdx + 1, markerIdx + 5);
  if (fields.length < 4) {
    throw new Error(
      `Remote probe: expected 4 fields after marker, got ${fields.length}: ${result.stdout.slice(0, 200)}`,
    );
  }

  const home = fields[0].trim();
  if (!home) {
    throw new Error("Remote HOME is empty; refusing to install into /tmp");
  }

  return {
    home,
    arch: normalizeArch(fields[1].trim()),
    busyboxPresent: fields[2].trim() === "yes",
    installPresent: fields[3].trim() === "yes",
  };
}

/** Detect $HOME on the remote. Throws if unset (security: /tmp is shared). */
export async function probeHome(conn: SshConnection): Promise<string> {
  const result = await conn.exec("printenv HOME");
  const home = result.stdout.trim();
  if (!home) {
    throw new Error("Remote HOME is empty; refusing to install into /tmp");
  }
  return home;
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
 * Install the vendored busybox on the remote in a single SSH call.
 *
 * The binary is streamed over stdin; `cat > bbPath` reads it, then the
 * && chain runs chmod, verify (catches noexec/corruption), and --install -s
 * (creates symlinks for all applets: sh, tar, gzip, mkdir, test, etc.).
 *
 * Prior implementation used 5 separate calls (mkdir, cat, chmod, verify,
 * install). Collapsing to 1 saves 4 SSH handshakes per first-connect.
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

  const localPath = localBusyboxPath(extensionPath, arch);
  const busyboxBuf = fs.readFileSync(localPath);
  logger.info(`[busybox] read ${busyboxBuf.length} bytes from ${localPath}`);

  const cmd =
    `mkdir -p ${shellQuote(toolsDir)} && ` +
    `cat > ${shellQuote(bbPath)} && ` +
    `chmod +x ${shellQuote(bbPath)} && ` +
    `${shellQuote(bbPath)} true && ` +
    `${shellQuote(bbPath)} --install -s ${shellQuote(toolsDir)}`;

  logger.info(`[busybox] streaming binary + bootstrap in one call...`);
  const result = await conn.execWithStdin(cmd, busyboxBuf);
  if (result.exitCode !== 0) {
    throw new Error(
      `Bootstrap failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }

  logger.info(`[busybox] bootstrap complete`);
}
