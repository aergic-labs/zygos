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
 * client-side and streamed over SSH stdin - the remote makes no HTTP
 * requests and needs no wget/curl.
 *
 * Install path layout (MS/Kiro convention):
 *   $HOME/.<serverDataFolderName>/bin/<commit>/
 *     node, <server-app>, ...
 */

import type { SshConnection } from "../ssh/connection";
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
  normalizeArch,
  remoteShPath,
} from "./busybox";

export type { normalizeArch };

export interface InstallResult {
  installPath: string;
  commit: string;
  arch: string;
  /** True if the server was already installed (skipped download). */
  alreadyInstalled: boolean;
  /** True if busybox was bootstrapped this run (vs already present). */
  busyboxBootstrapped: boolean;
}

export interface InstallOptions {
  /** OS to download for. Defaults to "linux" (macOS reserved - see research/08). */
  os?: string;
  /** Called with download progress (bytes received, total bytes). */
  onDownloadProgress?: DownloadProgressFn;
  /** Called at each install phase (extracting, verifying, etc.). */
  onPhase?: (phase: string) => void;
}

/**
 * Ensure the server is installed on the remote.
 *
 * Flow:
 *  1. probe: HOME, arch, busybox present?
 *  2. bootstrap busybox if missing
 *  3. check if server already installed (test -f node)
 *  4. mkdir -p install path
 *  5. client: download tarball into Buffer
 *  6. stream tarball over stdin -> gzip -d | tar -xC
 *  7. verify
 *
 * Steps 3-7 all run via the vendored busybox sh.
 */
export async function ensureServerInstalled(
  conn: SshConnection,
  adapter: PlatformAdapter,
  productInfo: ProductInfo,
  logger: Logger,
  extensionPath: string,
  home?: string,
  options?: InstallOptions,
): Promise<InstallResult> {
  const os = options?.os ?? "linux";

  // --- 1. Probe (raw login shell) ---
  // Batch HOME + arch + busybox check into a single ssh call when HOME is
  // unknown (the resolver probes it separately and passes it through).
  // Each ssh exec is a full handshake + auth, so batching avoids repeated
  // password prompts for protected keys.
  if (!home) {
    logger.info(`[install] probing HOME + arch + busybox in one call...`);
    const probeResult = await conn.exec(
      `printenv HOME; echo ":::$("; uname -m; echo ":::"; test -x \${HOME}/.ssh-remote/bin/sh && echo BB_YES || echo BB_NO`,
    );
    const lines = probeResult.stdout.trim().split("\n");
    home = lines[0]?.trim() || "/tmp";
    logger.info(`[install] HOME=${home}`);
    const arch = normalizeArch(lines[1] ?? "");
    logger.info(`[install] arch=${arch}`);
    const alreadyBootstrapped = lines.includes("BB_YES");
    logger.info(`[install] busybox present=${alreadyBootstrapped}`);

    return installWithKnownHome(
      conn,
      adapter,
      productInfo,
      logger,
      extensionPath,
      home,
      arch,
      alreadyBootstrapped,
      os,
      options,
    );
  }

  // HOME already known (resolver probed it). Still need arch + busybox -
  // batch those two into one call.
  logger.info(`[install] HOME=${home} (from resolver)`);
  const shCheckPath = remoteShPath(home);
  const probeResult = await conn.exec(
    `uname -m; test -x ${shellQuote(shCheckPath)} && echo BB_YES || echo BB_NO`,
  );
  const arch = normalizeArch(probeResult.stdout.trim().split("\n")[0] ?? "");
  logger.info(`[install] arch=${arch}`);
  const alreadyBootstrapped = probeResult.stdout.includes("BB_YES");
  logger.info(`[install] busybox present=${alreadyBootstrapped}`);

  return installWithKnownHome(
    conn,
    adapter,
    productInfo,
    logger,
    extensionPath,
    home,
    arch,
    alreadyBootstrapped,
    os,
    options,
  );
}

/**
 * Continue the install flow once HOME, arch, and busybox status are known.
 */
async function installWithKnownHome(
  conn: SshConnection,
  adapter: PlatformAdapter,
  productInfo: ProductInfo,
  logger: Logger,
  extensionPath: string,
  home: string,
  arch: string,
  alreadyBootstrapped: boolean,
  os: string,
  options: InstallOptions | undefined,
): Promise<InstallResult> {
  // --- 2. Bootstrap busybox if needed ---
  let bootstrapped = false;
  if (!alreadyBootstrapped) {
    logger.info(`[install] bootstrapping busybox...`);
    await bootstrapBusybox(conn, home, arch, extensionPath, logger);
    bootstrapped = true;
  }

  // --- 3. Check existing install + mkdir in one call (via busybox sh) ---
  const installRoot = `${home}/${productInfo.serverDataFolderName}`;
  const installPath = `${installRoot}/bin/${productInfo.commit}`;

  logger.info(
    `[install] checking existing install + mkdir at ${installPath}...`,
  );
  const nodePath = shellQuote(`${installPath}/node`);
  const checkAndMkdir = `test -f ${nodePath} && echo ALREADY_INSTALLED || { mkdir -p ${shellQuote(installPath)} && echo NEEDS_INSTALL; }`;
  const checkResult = await bbExec(conn, home, checkAndMkdir);
  if (checkResult.exitCode !== 0) {
    throw new Error(
      `Install check/mkdir failed (exit ${checkResult.exitCode}): ${checkResult.stderr || checkResult.stdout}`,
    );
  }
  if (checkResult.stdout.includes("ALREADY_INSTALLED")) {
    logger.info(`[install] already installed, skipping download`);
    return {
      installPath,
      commit: productInfo.commit,
      arch,
      alreadyInstalled: true,
      busyboxBootstrapped: bootstrapped,
    };
  }

  // --- 4. mkdir already done in step 3 ---

  // --- 5. Download tarball (client-side) ---
  const url = await buildServerDownloadUrl(productInfo, adapter, os, arch);
  logger.info(`[install] downloading server from ${url}...`);
  const tarball = await downloadToBuffer(url, options?.onDownloadProgress);
  logger.info(`[install] downloaded ${tarball.length} bytes`);

  // --- 5b. Verify checksum (client-side, before extraction) ---
  if (productInfo.verifyChecksum) {
    options?.onPhase?.("verifying-checksum");
    const result = await fetchExpectedChecksum(
      url,
      productInfo,
      os,
      arch,
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
      // No checksum source available
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
      // "allow": proceed silently
    }
  } else {
    logger.info(`[install] checksum verification disabled by setting`);
  }

  // --- 6. Extract (stream over stdin via busybox sh) ---
  options?.onPhase?.("extracting");
  logger.info(`[install] extracting to ${installPath}...`);
  // --strip-components=1 drops the top-level <server-app>-<os>-<arch>/ dir.
  const extractCmd = `gzip -d | tar -xC ${shellQuote(installPath)} --strip-components=1`;
  const extractResult = await bbExecWithStdin(conn, home, extractCmd, tarball);
  if (extractResult.exitCode !== 0) {
    throw new Error(
      `Tarball extraction failed (exit ${extractResult.exitCode}): ${extractResult.stderr || extractResult.stdout}`,
    );
  }

  // --- 6b. Patch the extracted product.json commit to match the IDE. ---
  // VS Code's client/server commit check fails when the tarball's commit
  // differs from the IDE's (always the case for vscode-oss using VSCodium
  // tarballs, and for any cross-fork custom download). The install dir is
  // already named after the IDE commit, so only the tarball's product.json
  // needs aligning. No-op when the commits already match.
  const productJsonPath = `${installPath}/product.json`;
  const sedCmd =
    `sed -i 's/"commit": "[0-9a-f]*"/"commit": "${productInfo.commit}"/' ` +
    shellQuote(productJsonPath);
  logger.info(`[install] patching commit in ${productJsonPath}...`);
  const patchResult = await bbExec(conn, home, sedCmd);
  if (patchResult.exitCode !== 0) {
    throw new Error(
      `Commit patch failed (exit ${patchResult.exitCode}): ${patchResult.stderr || patchResult.stdout}`,
    );
  }

  // --- 7. Verify (via busybox) ---
  options?.onPhase?.("verifying");
  logger.info(`[install] verifying...`);
  const verifyResult = await bbExec(
    conn,
    home,
    `test -f ${shellQuote(`${installPath}/node`)}`,
  );
  if (verifyResult.exitCode !== 0) {
    const listing = await bbExec(
      conn,
      home,
      `ls -la ${shellQuote(installPath)}`,
    );
    throw new Error(
      `Install verification failed: node binary not found at ${installPath}/node. ` +
        `Directory listing:\n${listing.stdout}`,
    );
  }

  logger.info(`[install] done: ${installPath}`);
  return {
    installPath,
    commit: productInfo.commit,
    arch,
    alreadyInstalled: false,
    busyboxBootstrapped: bootstrapped,
  };
}
