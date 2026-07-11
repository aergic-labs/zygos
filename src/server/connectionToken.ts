/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Connection-token file handling.
 *
 * The VS Code server binary validates a connection token on every client
 * connection. Passing it via `--connection-token <token>` exposes it in `ps`
 * on the remote; instead it is written to a `chmod 600` file and passed via
 * `--connection-token-file <path>`. Same approach as MS Remote-SSH and Trae.
 */

import type { SshConnection } from "../ssh/connection";
import type { Logger } from "../common/logger";
import { REMOTE_DIR_NAME, bbExecWithStdin, bbExec, shellQuote } from "./busybox";

/**
 * Write the connection token to a file on the remote with mode 600.
 * The file lives under $HOME/.ssh-remote/ (which is created during busybox
 * bootstrap, before this is called).
 *
 * Returns the absolute remote path the caller should pass to
 * `--connection-token-file`.
 */
export async function writeConnectionTokenFile(
  conn: SshConnection,
  home: string,
  token: string,
  logger: Logger,
): Promise<string> {
  const tokenFile = `${home}/${REMOTE_DIR_NAME}/conn-token`;
  // umask 077 -> file is created mode 600 regardless of the remote's default.
  const cmd = `mkdir -p ${shellQuote(`${home}/${REMOTE_DIR_NAME}`)} && umask 077 && cat > ${shellQuote(tokenFile)}`;
  logger.info(`[conn-token] writing token file at ${tokenFile}`);
  const result = await bbExecWithStdin(
    conn,
    home,
    cmd,
    Buffer.from(token, "utf-8"),
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to write connection token file (exit ${result.exitCode}): ${result.stderr}`,
    );
  }
  return tokenFile;
}

/**
 * Read the existing connection token from the remote token file.
 * Used when reusing a server started by another window.
 */
export async function readConnectionTokenFile(
  conn: SshConnection,
  home: string,
  logger: Logger,
): Promise<string | undefined> {
  const tokenFile = `${home}/${REMOTE_DIR_NAME}/conn-token`;
  logger.info(`[conn-token] reading token file at ${tokenFile}`);
  const result = await bbExec(
    conn,
    home,
    `cat ${shellQuote(tokenFile)} 2>/dev/null`,
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    logger.info("[conn-token] no existing token file or empty");
    return undefined;
  }
  return result.stdout.trim();
}

/**
 * Remove the connection token file on the remote. Best-effort - failures are
 * logged, not thrown, since this runs during cleanup. `rm` is universal, so
 * no need to route through busybox.
 */
export async function removeConnectionTokenFile(
  conn: SshConnection,
  tokenFile: string,
  logger: Logger,
): Promise<void> {
  try {
    const result = await conn.exec(`rm -f ${shellQuote(tokenFile)}`);
    if (result.exitCode !== 0) {
      logger.info(`[conn-token] rm failed (exit ${result.exitCode}), ignoring`);
    }
  } catch (err) {
    logger.info(
      `[conn-token] rm threw ${err instanceof Error ? err.message : err}, ignoring`,
    );
  }
}
