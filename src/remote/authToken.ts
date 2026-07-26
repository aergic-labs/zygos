/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Forward the IDE's auth token (e.g. Kiro SSO token) from the client to
 * the remote, so the server can authenticate against the IDE's backend
 * services without making the user sign in again.
 *
 * The token is read locally (see PlatformAdapter#readAuthToken) and streamed
 * over SSH stdin into the destination path on the remote. Parent directories
 * are created with `mkdir -p`; the file is written with `umask 077` so only
 * the remote user can read it.
 */

import * as nodePath from "node:path";
import type { SshConnection } from "../ssh/connection";
import type { Logger } from "../common/logger";
import type { PlatformAdapter } from "../platform/types";
import { bbExecWithStdin, shellQuote } from "./busybox";

/**
 * Copy the adapter's auth token to the remote, if the adapter supports it.
 * No-op when the adapter doesn't declare `readAuthToken`/`getAuthTokenPath`
 * or when no local token is present (the remote will then require sign-in).
 */
export async function copyAuthToken(
  conn: SshConnection,
  home: string,
  adapter: PlatformAdapter,
  logger: Logger,
): Promise<void> {
  if (!adapter.readAuthToken || !adapter.getAuthTokenPath) {
    logger.info(
      "[auth-token] adapter does not provide an auth token, skipping",
    );
    return;
  }

  const token = adapter.readAuthToken();
  if (!token) {
    logger.info(
      "[auth-token] no local auth token found; remote may require sign-in",
    );
    return;
  }

  const relPath = adapter.getAuthTokenPath();
  const remoteAbs = `${home}/${relPath}`;
  // POSIX dirname (the remote is always Linux for now).
  const remoteDir = nodePath.posix.dirname(remoteAbs);

  // mkdir -p the parent, then write the token with mode 600. Runs under
  // the vendored busybox sh so mkdir/cat/umask are guaranteed.
  const cmd = `mkdir -p ${shellQuote(remoteDir)} && umask 077 && cat > ${shellQuote(remoteAbs)}`;
  logger.info(`[auth-token] copying token to ${remoteAbs}`);
  const result = await bbExecWithStdin(
    conn,
    home,
    cmd,
    Buffer.from(token, "utf-8"),
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to copy auth token to ${remoteAbs} (exit ${result.exitCode}): ${result.stderr}`,
    );
  }
  logger.info("[auth-token] token copied");
}
