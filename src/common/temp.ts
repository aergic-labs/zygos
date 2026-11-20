/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Centralized secure temporary file/directory utility.
 *
 * Threat model: local attacker on the same machine (same or different
 * user). Defends against symlink attacks, TOCTOU races, permission
 * leakage, and cleanup failure.
 *
 * Design:
 *   - Temp dir is a subdirectory of the OS temp dir, named with
 *     crypto.randomBytes(16) (128 bits of entropy). fs.mkdtempSync only
 *     provides ~36 bits, which is insufficient for a security context.
 *   - Directory creation uses mkdirSync(recursive: false), which fails
 *     with EEXIST if the path exists. This is TOCTOU-safe (no
 *     existsSync + mkdir gap).
 *   - On Unix, the temp base is fs.realpathSync(os.tmpdir()) to resolve
 *     any symlinks (defends against /tmp being a symlink).
 *   - On Windows, process.env.TEMP || os.tmpdir() is already user-
 *     specific (AppData\Local\Temp, ACL-protected).
 *   - Permissions: 0o700 on Unix (owner-only), 0o600 on Windows (toggles
 *     the write bit; read access is ACL-controlled and already
 *     user-only in AppData\Local\Temp).
 *   - Cleanup is via fs.rmSync in a finally block. Always runs, even on
 *     error.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const isWin = process.platform === "win32";

/** Max retries on EEXIST (collision with 128 bits is astronomically
 * unlikely, but handle it gracefully). */
const MAX_RETRIES = 3;

/**
 * Directory for unix sockets that must stay under the `sun_path` limit.
 *
 * macOS `TMPDIR` is a long per-user path (`/var/folders/xx/<hash>/T/`, ~49
 * chars), and a socket name on top of it can exceed the 104-byte limit
 * (zygos issue #13). POSIX uses a short directory under `/tmp` instead.
 *
 * The name is random per process (`mkdtemp`), so another local user cannot
 * pre-create it and block connections. `mkdtemp` creates it 0700, and the
 * prefix is literal `/tmp`, so `TMPDIR` is never consulted. The OS temp dir
 * is only used on Windows, where it holds named pipes.
 */
export function socketDirPrefix(platform: NodeJS.Platform): string {
  // Windows uses named pipes, not filesystem sockets.
  if (platform === "win32") return os.tmpdir();
  return "/tmp/zygos-";
}

let cachedSocketDir: string | undefined;

/**
 * Remove the socket directory created by {@link socketDir}. Best effort, and
 * only for a directory we created: literal `/tmp/zygos-` prefix, a real
 * directory, not a symlink.
 */
export function disposeSocketDir(): void {
  const dir = cachedSocketDir;
  cachedSocketDir = undefined;
  if (!dir || !dir.startsWith("/tmp/zygos-")) return;
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return;
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: the OS tmp cleaner handles anything left behind.
  }
}

/** {@link socketDirPrefix} for this process, created once and reused. */
export function socketDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return socketDirPrefix(platform);
  if (cachedSocketDir) return cachedSocketDir;
  const dir = fs.mkdtempSync(socketDirPrefix(platform));
  try {
    // mkdtemp already uses 0700; the umask can only tighten it.
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort; the directory is ours and already 0700.
  }
  cachedSocketDir = dir;
  return dir;
}

/** Resolve the temp base dir, defending against symlink attacks on Unix. */
function tempBase(): string {
  if (isWin) {
    // AppData\Local\Temp - user-specific via ACLs.
    return process.env.TEMP || os.tmpdir();
  }
  // /tmp may be a symlink; resolve it to defend against symlink attacks.
  return fs.realpathSync(os.tmpdir());
}

/** Generate a 128-bit random dir name (32 hex chars), prefixed for
 * identification in temp dir listings. */
function randomName(): string {
  return `aergic-${crypto.randomBytes(16).toString("hex")}`;
}

/**
 * Create a locked-down temp directory and return its path.
 *
 * The caller must clean it up (use withTempDir for automatic cleanup).
 */
export function secureTempDir(): string {
  const base = tempBase();
  let lastErr: unknown;
  for (let i = 0; i < MAX_RETRIES; i++) {
    const dir = path.join(base, randomName());
    try {
      // recursive: false -> TOCTOU-safe, fails on EEXIST.
      fs.mkdirSync(dir, { recursive: false });
      if (isWin) {
        // 0o600 on Windows sets S_IRUSR | S_IWUSR (write-owner-only).
        // Read is ACL-controlled; this is defense in depth.
        try { fs.chmodSync(dir, 0o600); } catch { /* ACLs suffice */ }
      } else {
        // mkdir creates with 0o777 & ~umask (typically 0o755).
        // Force 0o700 for owner-only access.
        fs.chmodSync(dir, 0o700);
      }
      return dir;
    } catch (err) {
      // EEXIST -> collision, retry with a new name.
      // Other errors (ENOSPC, EACCES) -> retry then surface.
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") break;
    }
  }
  throw new Error(`Failed to create secure temp dir: ${String(lastErr)}`);
}

/**
 * Create a temp dir, run fn(dir), always clean up.
 *
 * If fn throws, the error propagates after cleanup. If cleanup fails,
 * a warning is logged but the original result/error is preserved.
 */
export async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = secureTempDir();
  try {
    return await fn(dir);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort. Don't mask the original result/error.
    }
  }
}

/**
 * Create a temp dir with a single file inside, run fn(filePath), always
 * clean up the whole dir.
 */
export async function withTempFile<T>(
  fn: (file: string) => Promise<T>,
): Promise<T> {
  return withTempDir(async (dir) => {
    const file = path.join(dir, "file");
    return fn(file);
  });
}
