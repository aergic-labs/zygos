/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Server tarball downloader (client-side) with on-disk cache.
 *
 * Downloads the server tarball into a Buffer, following redirects, with an
 * inactivity timeout so a stalled download fails fast. The remote makes no
 * HTTP request - the client downloads, the remote extracts.
 *
 * Repeated installs of the same commit+arch skip the network entirely via
 * a permanent on-disk cache keyed on the original (pre-redirect) URL. REH
 * tarballs are commit-pinned and immutable, so there is no revalidation:
 * the cache is valid until the user clears it or the size cap prunes it.
 *
 * The cache is content-addressed (cacache, sha512). Corruption is
 * detected on every read. Existing checksum verification runs on every
 * returned buffer regardless of source, so cache hits are still verified
 * against the vendor's published sidecar/manifest when one exists.
 */

import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";
import * as cacache from "cacache";

/** Inactivity timeout for the server download (ms). */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Max HTTP redirects to follow. */
const MAX_REDIRECTS = 5;
/** Max on-disk cache size before we prune oldest entries. */
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
/** Max retry attempts on transient errors. */
const MAX_RETRIES = 2;
/** Base backoff between retries (ms). Doubled per attempt. */
const RETRY_BASE_MS = 500;
/** HTTP status codes that warrant a retry. */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
/** Network errors that warrant a retry. */
const RETRY_ERRORS = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"]);

/** Progress callback: (downloadedBytes, totalBytes | undefined). */
export type DownloadProgressFn = (
  downloaded: number,
  total: number | undefined,
) => void;

/** Optional logger sink for cache-status and retry diagnostics. */
export interface DownloadDiagnostics {
  /** Called with `hit` | `miss` | `updated` after each cache lookup. */
  onCacheStatus?: (status: string, url: string) => void;
  /** Called when a transient error triggers a retry. */
  onRetry?: (cause: unknown, url: string) => void;
}

let configuredCachePath: string | undefined;
let diagnostics: DownloadDiagnostics = {};

/**
 * Set the on-disk cache directory. Call once at activation with
 * `<globalStorageUri>/reh-cache`. When not called, downloads still work
 * but nothing is cached.
 */
export function configureDownloadCache(
  dir: string,
  diag?: DownloadDiagnostics,
): void {
  configuredCachePath = dir;
  if (diag) diagnostics = diag;
}

/**
 * Download a URL into a Buffer with on-disk caching.
 *
 * Rejects on HTTP error, HTTPS->HTTP downgrade (per redirect hop), redirect
 * loop, or inactivity timeout. On a cache hit, returns the cached body
 * without touching the network (cacache verifies the sha512 on read).
 *
 * The cache key is always the original URL passed here, never the
 * post-redirect URL. This matters for VSCodium: its GitHub-releases URL
 * redirects to a per-request signed Azure URL that changes every fetch,
 * which would defeat a post-redirect cache key.
 *
 * If `onProgress` is provided, it's called on each chunk with the running
 * byte count and total size (from Content-Length, if sent). Skipped on
 * cache hits - the body comes from disk in a few hundred ms and a
 * 100-update progress bar is just noise.
 */
export async function downloadToBuffer(
  url: string,
  onProgress?: DownloadProgressFn,
): Promise<Buffer> {
  const dir = configuredCachePath;
  if (dir) {
    try {
      const entry = await cacache.get(dir, url);
      diagnostics.onCacheStatus?.("hit", url);
      return Buffer.from(entry.data);
    } catch (err) {
      // cacache.get rejects with E_NOT_FOUND when the key is absent; any
      // other error is a cache corruption we fall through from (a fresh
      // download overwrites the corrupted entry on success).
      const code = (err as { code?: string }).code;
      if (code !== "E_NOT_FOUND") {
        // Surface non-missing errors to the log but don't abort: a fresh
        // download still produces a valid buffer.
        diagnostics.onCacheStatus?.("miss", url);
      } else {
        diagnostics.onCacheStatus?.("miss", url);
      }
    }
  }

  const body = await fetchWithRetries(url, onProgress);

  if (dir) {
    try {
      await cacache.put(dir, url, body);
      diagnostics.onCacheStatus?.("updated", url);
    } catch {
      // A failed cache write does not fail the install.
    }
  }
  return body;
}

/**
 * Raw node:https fetch with manual redirect loop, inactivity timeout, and
 * a small retry loop for transient errors. Per-hop HTTPS-only guard: if
 * the request started over HTTPS, every redirect hop must stay HTTPS.
 */
function fetchWithRetries(
  url: string,
  onProgress?: DownloadProgressFn,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let attempt = 0;
    const tryOnce = (u: string): void => {
      fetchOnce(u, onProgress).then(resolve, (err: unknown) => {
        const code = (err as { code?: string }).code;
        const status = (err as { status?: number }).status;
        const retryable =
          (code && RETRY_ERRORS.has(code)) ||
          (typeof status === "number" && RETRY_STATUS.has(status));
        if (!retryable || attempt >= MAX_RETRIES) {
          reject(err);
          return;
        }
        attempt += 1;
        const backoff = RETRY_BASE_MS * (1 << (attempt - 1));
        diagnostics.onRetry?.(err, u);
        setTimeout(() => tryOnce(u), backoff);
      });
    };
    tryOnce(url);
  });
}

/**
 * Single fetch attempt. Follows up to MAX_REDIRECTS redirects, rejecting
 * HTTPS->non-HTTPS downgrades. Reports progress only when at least 1 MiB
 * has been received or the integer percentage changes.
 */
function fetchOnce(
  url: string,
  onProgress?: DownloadProgressFn,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let received = 0;
    let lastPct = -1;
    // Start below the step so the first chunk always emits progress, even
    // for small bodies that never cross 1 MiB.
    let lastReportedBytes = -(1 << 20);
    const PROGRESS_BYTE_STEP = 1 << 20;
    // If the download starts over HTTPS, every hop must stay HTTPS. A
    // redirect to plain HTTP would silently downgrade a tarball that is
    // extracted and executed on the remote - a MITM foothold for RCE.
    const httpsOnly = url.startsWith("https:");

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const attempt = (u: string, redirectsLeft: number): void => {
      const getter = u.startsWith("https:") ? httpsGet : httpGet;
      const req = getter(
        u,
        { headers: { "User-Agent": "aergic-download/1.0" } },
        (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers?.location;

        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (redirectsLeft <= 0) {
            fail(new Error("Too many redirects fetching server"));
            return;
          }
          const next = new URL(location, u).href;
          if (httpsOnly && !next.startsWith("https:")) {
            fail(
              new Error(
                `Refusing to follow HTTPS->non-HTTPS redirect to ${next}`,
              ),
            );
            return;
          }
          attempt(next, redirectsLeft - 1);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          const err = new Error(
            `HTTP ${status} fetching server from ${u}`,
          ) as Error & { status?: number };
          err.status = status;
          fail(err);
          return;
        }

        const contentLength = res.headers?.["content-length"];
        const total = contentLength ? parseInt(contentLength, 10) : undefined;

        res.on("data", (c: Buffer) => {
          chunks.push(c);
          received += c.length;
          if (!onProgress) return;
          if (total) {
            const pct = Math.floor((received / total) * 100);
            if (pct !== lastPct || received - lastReportedBytes >= PROGRESS_BYTE_STEP) {
              lastPct = pct;
              lastReportedBytes = received;
              onProgress(received, total);
            }
          } else if (received - lastReportedBytes >= PROGRESS_BYTE_STEP) {
            lastReportedBytes = received;
            onProgress(received, undefined);
          }
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          if (onProgress) onProgress(received, total ?? received);
          resolve(Buffer.concat(chunks));
        });
        res.on("error", fail);
      });

      req.on("error", fail);
      // Inactivity timeout: fires if the connection stalls with no data.
      req.setTimeout?.(DOWNLOAD_TIMEOUT_MS, () => {
        req.destroy(
          new Error(`server download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`),
        );
      });
    };

    attempt(url, MAX_REDIRECTS);
  });
}

/**
 * Best-effort prune of the cache directory when it exceeds
 * MAX_CACHE_BYTES. Called at activation. Failures are swallowed; a
 * bloated cache is not fatal, just wasteful.
 */
export async function maybePruneCache(): Promise<void> {
  const dir = configuredCachePath;
  if (!dir) return;
  try {
    const entries = await cacache.ls(dir);
    let totalBytes = 0;
    const list: Array<{ key: string; time: number; size: number }> = [];
    for (const [key, entry] of Object.entries(entries)) {
      const size = entry.size ?? 0;
      const time = entry.time;
      totalBytes += size;
      list.push({ key, time, size });
    }
    if (totalBytes <= MAX_CACHE_BYTES) return;
    list.sort((a, b) => a.time - b.time); // oldest first
    while (totalBytes > MAX_CACHE_BYTES && list.length > 0) {
      const oldest = list.shift()!;
      await cacache.rm.entry(dir, oldest.key);
      totalBytes -= oldest.size;
    }
  } catch {
    // ignore
  }
}
