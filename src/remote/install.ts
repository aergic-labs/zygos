/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Server install flow over SSH.
 *
 * Three phases:
 *   1. Probe (raw login shell): detect HOME, arch, check if busybox exists.
 *   2. Bootstrap (if needed): stream vendored busybox binary via cat.
 *   3. Install (via busybox sh): known POSIX env, no guessing.
 *
 * After bootstrap, everything runs through the vendored busybox sh with
 * busybox tools at the front of PATH. The server tarball is downloaded
 * client-side and streamed over SSH stdin: the remote makes no HTTP
 * requests and needs no wget/curl.
 *
 * Install path layout (MS/Kiro convention):
 *   $HOME/.<serverDataFolderName>/bin/<commit>/
 *     node, <server-app>, ...
 */

import type { ISshConnection } from "../ssh/connection";
import type { Logger } from "../common/logger";
import type { PlatformAdapter, ProductInfo } from "../platform/types";
import { buildServerDownloadUrl } from "./url";
import { downloadToBuffer, type DownloadProgressFn } from "./download";
import { fetchExpectedChecksum, verifyHash, computeHash } from "./checksum";
import {
  bootstrapBusybox,
  bbExec,
  bbExecWithStdin,
  shellQuote,
  probeRemote,
} from "./busybox";

export interface InstallResult {
  installPath: string;
  commit: string;
  arch: string;
  home: string;
  /** True if the server was already installed (skipped download). */
  alreadyInstalled: boolean;
  /** True if busybox was bootstrapped this run (vs already present). */
  busyboxBootstrapped: boolean;
}

export interface InstallOptions {
  /** OS to download for. Defaults to "linux" (macOS reserved; see research/08). */
  os?: string;
  /** Called with download progress (bytes received, total bytes). */
  onDownloadProgress?: DownloadProgressFn;
  /** Called at each install phase (extracting, verifying, etc.). */
  onPhase?: (phase: string) => void;
  /** Called after the probe + busybox bootstrap, before the tarball
   *  upload. Lets the caller start the transport so the tarball rides it
   *  instead of base64-over-shell. */
  onProbed?: (info: { home: string; arch: string }) => Promise<void>;
}

/**
 * Ensure the server is installed on the remote.
 *
 * Flow (SSH call count):
 *  1. probe: HOME, arch, busybox present, install present (1 call)
 *  2. bootstrap busybox if missing (1 call, streams binary)
 *  3. download tarball (client-side, no SSH)
 *  4. mkdir + extract: stream tarball over stdin (1 call)
 *  5. patch commit + verify node (1 call)
 *
 * Best case (already installed): 1 SSH call (probe only).
 * Worst case (fresh install, no busybox): 4 SSH calls.
 */
export async function ensureServerInstalled(
  conn: ISshConnection,
  adapter: PlatformAdapter,
  productInfo: ProductInfo,
  logger: Logger,
  extensionPath: string,
  options?: InstallOptions,
): Promise<InstallResult> {
  const os = options?.os ?? "linux";

  // --- 1. Probe: HOME, arch, busybox, existing install (single call) ---
  logger.info(`[install] probing remote environment...`);
  const probe = await probeRemote(
    conn,
    productInfo.serverDataFolderName,
    productInfo.commit,
  );
  logger.info(
    `[install] HOME=${probe.home} arch=${probe.arch} busybox=${probe.busyboxPresent} installed=${probe.installPresent}`,
  );

  const installRoot = `${probe.home}/${productInfo.serverDataFolderName}`;
  const installPath = `${installRoot}/bin/${productInfo.commit}`;

  // --- 2. Bootstrap busybox if missing (single call) ---
  // Must run before the installPresent early return: every downstream
  // step (copyAuthFiles, acquireLock, startServer) goes through bbExec,
  // which needs ~/.ssh-remote/bin/sh. A host provisioned by another
  // extension (e.g. jeanp413.open-remote-ssh) can have the server already
  // installed but no busybox, breaking the rest of the resolve.
  // Start the transport first (before busybox) so the busybox copy and the
  // tarball both ride it instead of base64-over-shell.
  await options?.onProbed?.({ home: probe.home, arch: probe.arch });

  // --- 2. Bootstrap busybox if missing (single call) ---
  let bootstrapped = false;
  if (!probe.busyboxPresent) {
    logger.info(`[install] bootstrapping busybox...`);
    await bootstrapBusybox(conn, probe.home, probe.arch, extensionPath, logger);
    bootstrapped = true;
  }

  if (probe.installPresent) {
    logger.info(`[install] already installed, skipping download`);
    return {
      installPath,
      commit: productInfo.commit,
      arch: probe.arch,
      home: probe.home,
      alreadyInstalled: true,
      busyboxBootstrapped: bootstrapped,
    };
  }

  // --- 3. Download tarball (client-side) ---
  const url = await buildServerDownloadUrl(productInfo, adapter, os, probe.arch);
  logger.info(`[install] downloading server from ${url}...`);
  const tarball = await downloadToBuffer(url, options?.onDownloadProgress);
  logger.info(`[install] downloaded ${tarball.length} bytes`);

  // --- 3b. Verify checksum (client-side, before extraction) ---
  if (productInfo.verifyChecksum) {
    options?.onPhase?.("verifying-checksum");
    // Log a phase-entry line that matches the UI status text
    // ("Verifying server checksum...") so log-watchers see the same
    // transition the status bar shows.
    logger.info("[install] verifying server checksum...");
    const result = await fetchExpectedChecksum(
      url,
      productInfo,
      os,
      probe.arch,
      logger,
    );

    if ("expectedHash" in result) {
      const ok = verifyHash(tarball, result.expectedHash, result.algo);
      if (!ok) {
        const actual = computeHash(tarball, result.algo);
        throw new Error(
          `Server tarball checksum mismatch (${result.source}, ${result.algo}).\n` +
            `Expected: ${result.expectedHash}\n` +
            `Actual:   ${actual}\n` +
            `Aborting installation. Disable zygos.serverDownload.verifyChecksum to bypass.`,
        );
      }
      logger.info(`[install] checksum verified (${result.algo}, ${result.source})`);
    } else {
      const policy = productInfo.onNoChecksum;
      if (policy === "abort") {
        throw new Error(
          `Server tarball checksum not available (${result.reason}) and ` +
            `zygos.serverDownload.onNoChecksum is set to "abort".`,
        );
      }
      if (policy === "warn") {
        logger.info(
          `[install] warning: no checksum available (${result.reason}), proceeding with HTTPS-only protection`,
        );
      }
    }
  } else {
    logger.info(`[install] checksum verification disabled by setting`);
  }

  // --- 4. mkdir + extract ---
  options?.onPhase?.("extracting");
  // Log a phase-entry line that matches the UI status text
  // ("Extracting server tarball...") so log-watchers see the same
  // transition the status bar shows. Per-branch detail lines below
  // describe which transport path is in use.
  const tarMb = (tarball.length / 1_048_576).toFixed(1);
  logger.info(`[install] extracting server tarball (${tarMb} MB)...`);
  // --strip-components=1 drops the top-level <server-app>-<os>-<arch>/ dir.
  // mkdir is folded in so we don't need a separate call.
  //
  // Session path: conn.putFile (binary /put-file) uploads the tarball to
  // a temp path, then we exec the extract reading from that file. This
  // avoids base64-encoding the entire tarball through the control shell
  // (SshSession.execWithStdin), which stalls for 30-40s on a ~50MB
  // tarball with no log output.
  //
  // Raw SSH path: execWithStdin streams the tarball over SSH stdin
  // directly (fast). No putFile available, so we use bbExecWithStdin.
  if (conn.extract) {
    // Session path with a live Go transport: stream the tarball through
    // the transport, which extracts it natively (archive/tar + compress/gzip
    // in Go). No remote gzip/tar/busybox dependency, and upload + extract
    // pipeline in a single op.
    logger.info(`[install] streaming tarball (${tarMb} MB) to transport for extract to ${installPath}...`);
    const exStart = Date.now();
    let lastPct = -5;
    const extractResult = await conn.extract(installPath, 1, tarball, (sent, total) => {
      const pct = Math.floor((sent / total) * 100);
      if (pct < lastPct + 5 && pct < 100) return;
      lastPct = pct;
      logger.info(
        `[install] stream+extract ${pct}% (${(sent / 1_048_576).toFixed(1)}/${tarMb} MB)`,
      );
    });
    logger.info(`[install] streamed+extracted in ${Date.now() - exStart}ms`);
    if (extractResult.exitCode !== 0) {
      throw new Error(
        `Tarball extraction failed (exit ${extractResult.exitCode}): ${extractResult.stderr || extractResult.stdout}`,
      );
    }
  } else if (conn.putFile) {
    const tmpDir = `${probe.home}/.ssh-remote`;
    const tmpTarball = `${tmpDir}/server-${productInfo.commit}.tar.gz`;
    logger.info(
      `[install] uploading tarball (${tarMb} MB) to ${tmpTarball}...`,
    );
    const upStart = Date.now();
    let lastPct = -5;
    await conn.putFile(tmpTarball, tarball, "0600", (sent, total) => {
      const pct = Math.floor((sent / total) * 100);
      // Report every 5%, plus the final 100%.
      if (pct < lastPct + 5 && pct < 100) return;
      lastPct = pct;
      logger.info(
        `[install] upload ${pct}% (${(sent / 1_048_576).toFixed(1)}/${tarMb} MB)`,
      );
    });
    logger.info(`[install] tarball uploaded in ${Date.now() - upStart}ms`);
    logger.info(`[install] extracting to ${installPath}...`);
    const extractCmd =
      `mkdir -p ${shellQuote(installPath)} && ` +
      `gzip -dc ${shellQuote(tmpTarball)} | tar -xC ${shellQuote(installPath)} --strip-components=1 && ` +
      `rm -f ${shellQuote(tmpTarball)}`;
    const exStart = Date.now();
    const extractResult = await bbExec(conn, probe.home, extractCmd);
    logger.info(`[install] extracted in ${Date.now() - exStart}ms`);
    if (extractResult.exitCode !== 0) {
      throw new Error(
        `Tarball extraction failed (exit ${extractResult.exitCode}): ${extractResult.stderr || extractResult.stdout}`,
      );
    }
  } else {
    logger.info(`[install] extracting to ${installPath}... (${tarMb} MB)`);
    const extractCmd =
      `mkdir -p ${shellQuote(installPath)} && ` +
      `gzip -d | tar -xC ${shellQuote(installPath)} --strip-components=1`;
    const exStart = Date.now();
    const extractResult = await bbExecWithStdin(conn, probe.home, extractCmd, tarball);
    logger.info(`[install] extracted in ${Date.now() - exStart}ms`);
    if (extractResult.exitCode !== 0) {
      throw new Error(
        `Tarball extraction failed (exit ${extractResult.exitCode}): ${extractResult.stderr || extractResult.stdout}`,
      );
    }
  }

  // --- 5. Patch commit + verify node (single call) ---
  // VS Code's client/server commit check fails when the tarball's commit
  // differs from the IDE's. The install dir is already named after the IDE
  // commit, so only the tarball's product.json needs aligning. The patch is
  // skipped (inside the remote script) when the commits already match.
  if (!/^[0-9a-f]+$/.test(productInfo.commit)) {
    throw new Error(`Invalid commit id: ${productInfo.commit}`);
  }
  const productJsonPath = `${installPath}/product.json`;
  const nodePath = shellQuote(`${installPath}/node`);
  const patchVerifyCmd =
    `reh=$(sed -n 's/.*"commit": "\\([0-9a-f]*\\)".*/\\1/p' ${shellQuote(productJsonPath)}); ` +
    `if [ -n "$reh" ] && [ "$reh" != "${productInfo.commit}" ]; then ` +
    `sed -i 's/"commit": "[0-9a-f]*"/"commit": "${productInfo.commit}"/' ${shellQuote(productJsonPath)}; ` +
    `fi; ` +
    `test -f ${nodePath} || { echo VERIFY_FAILED; ls -la ${shellQuote(installPath)}; false; }`;

  options?.onPhase?.("verifying");
  logger.info(`[install] patching commit + verifying...`);
  const patchVerifyResult = await bbExec(conn, probe.home, patchVerifyCmd);
  if (patchVerifyResult.exitCode !== 0) {
    throw new Error(
      `Install verification failed: node binary not found at ${installPath}/node. ` +
        `Directory listing:\n${patchVerifyResult.stdout}`,
    );
  }

  logger.info(`[install] done: ${installPath}`);
  return {
    installPath,
    commit: productInfo.commit,
    arch: probe.arch,
    home: probe.home,
    alreadyInstalled: false,
    busyboxBootstrapped: bootstrapped,
  };
}
