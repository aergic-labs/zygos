/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Server tarball downloader (client-side).
 *
 * Downloads the server tarball into a Buffer, following redirects, with an
 * inactivity timeout so a stalled download fails fast. The remote makes no
 * HTTP request - the client downloads, the remote extracts.
 */

import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";

/** Inactivity timeout for the server download (ms). */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Max HTTP redirects to follow. */
const MAX_REDIRECTS = 5;

/** Progress callback: (downloadedBytes, totalBytes | undefined). */
export type DownloadProgressFn = (
  downloaded: number,
  total: number | undefined,
) => void;

/**
 * Download a URL into a Buffer, following up to MAX_REDIRECTS redirects.
 * Rejects on HTTP error, redirect loop, or inactivity timeout.
 *
 * If `onProgress` is provided, it's called on each `data` chunk with the
 * running byte count and total size (from Content-Length, if sent). Only
 * fires when the integer percentage changes by at least 1%.
 */
export function downloadToBuffer(
  url: string,
  onProgress?: DownloadProgressFn,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let received = 0;
    let lastPct = -1;
    // If the download starts over HTTPS, every hop must stay HTTPS. A redirect
    // to plain HTTP would silently downgrade a tarball that is extracted and
    // executed on the remote - a MITM foothold for remote code execution.
    const httpsOnly = url.startsWith("https:");

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const attempt = (u: string, redirectsLeft: number): void => {
      const getter = u.startsWith("https:") ? httpsGet : httpGet;
      const req = getter(u, (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers?.location;

        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (redirectsLeft <= 0) {
            fail(new Error("Too many redirects fetching server"));
            return;
          }
          // Resolve relative redirects against the current URL.
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
          fail(new Error(`HTTP ${status} fetching server from ${u}`));
          return;
        }

        const contentLength = res.headers?.["content-length"];
        const total = contentLength ? parseInt(contentLength, 10) : undefined;

        res.on("data", (c: Buffer) => {
          chunks.push(c);
          received += c.length;
          if (onProgress) {
            if (total) {
              const pct = Math.floor((received / total) * 100);
              // Only fire when the integer percentage changes.
              if (pct !== lastPct) {
                lastPct = pct;
                onProgress(received, total);
              }
            } else {
              // No Content-Length - just report bytes received.
              onProgress(received, undefined);
            }
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
