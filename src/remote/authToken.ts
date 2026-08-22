/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Forward the IDE's auth files (e.g. Kiro SSO token + refresh-registration
 * sibling) from the client to the remote, so the server can authenticate
 * against the IDE's backend services and refresh its own tokens without
 * making the user sign in again.
 *
 * Files are streamed over SSH stdin as path/base64 pairs (one pair per
 * line, blank-line terminator) into a single busybox-sh invocation that
 * writes each with an atomic temp+mv, non-fatal on read-only mounts.
 */

import type { SshConnection } from "../ssh/connection";
import type { Logger } from "../common/logger";
import type { PlatformAdapter } from "../platform/types";
import { bbExecWithStdin } from "./busybox";

/**
 * Copy the adapter's auth files to the remote, if the adapter supports it.
 * No-op when the adapter doesn't declare `readAuthFiles` or returns an
 * empty array (the remote will then require sign-in).
 *
 * Single SSH call regardless of file count. Writes are atomic (temp file
 * in the same dir, then `mv -f`) and non-fatal: a read-only bind-mount of
 * `~/.aws` on the remote (which already provides the files) won't abort
 * the call; the temp write fails silently and the mounted file stays.
 */
export async function copyAuthFiles(
  conn: SshConnection,
  home: string,
  adapter: PlatformAdapter,
  logger: Logger,
): Promise<void> {
  if (!adapter.readAuthFiles) {
    logger.info(
      "[auth-token] adapter does not provide auth files, skipping",
    );
    return;
  }

  const files = adapter.readAuthFiles();
  if (files.length === 0) {
    logger.info(
      "[auth-token] no local auth files found; remote may require sign-in",
    );
    return;
  }

  // Remote sh script: read path/b64 pairs from stdin, write each via
  // temp+mv (atomic, non-fatal). Blank line terminates the auth section.
  // All paths are shell-quoted; file contents never reach argv (they
  // arrive on stdin as base64, decoded on the remote).
  const script = `
while IFS= read -r AUTH_PATH; do
  [ -z "$AUTH_PATH" ] && break
  IFS= read -r AUTH_B64
  DEST="$HOME/$AUTH_PATH"
  DIR=$(dirname "$DEST")
  mkdir -p "$DIR" 2>/dev/null || true
  TMP="$DIR/.auth.$$"
  if printf '%s' "$AUTH_B64" | base64 -d > "$TMP" 2>/dev/null; then
    chmod 600 "$TMP" 2>/dev/null || true
    mv -f "$TMP" "$DEST" 2>/dev/null || rm -f "$TMP" 2>/dev/null
  fi
done
`;

  // Build the stdin payload: path\nb64\n per file, then a blank line.
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(Buffer.from(`${f.path}\n`));
    chunks.push(
      Buffer.from(
        `${Buffer.from(f.content, "utf-8").toString("base64")}\n`,
      ),
    );
  }
  chunks.push(Buffer.from("\n"));
  const stdin = Buffer.concat(chunks);

  logger.info(
    `[auth-token] copying ${files.length} auth file${files.length === 1 ? "" : "s"} to ${home}`,
  );
  const result = await bbExecWithStdin(
    conn,
    home,
    script,
    stdin,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to copy auth files (exit ${result.exitCode}): ${result.stderr}`,
    );
  }
  logger.info("[auth-token] auth files copied");
}
