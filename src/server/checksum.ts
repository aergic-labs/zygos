/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Server tarball checksum verification.
 *
 * Two checksum source types:
 *   1. Sidecar: `resolvedDownloadUrl + "." + algo` (VSCodium, Trae, Qoder)
 *   2. Manifest: JSON file with a named hash field (Devin)
 *
 * Sidecar format varies:
 *   - Bare hash: `bc6372...`
 *   - Sumfile:   `bc6372...  filename.tar.gz`
 * Both are parsed by splitting on whitespace and taking the first token.
 *
 * MD5 is collision-broken but not preimage-broken. For integrity
 * verification (detecting accidental corruption or naive substitution),
 * MD5 is sufficient. For defending against a determined attacker who
 * can craft a collision, it is not. The threat model assumes the
 * attacker cannot modify both the tarball and the sidecar on the CDN.
 */

import { createHash } from "node:crypto";
import { resolveTemplateUrl } from "./url";
import type { ProductInfo } from "../platform/types";
import type { Logger } from "../common/logger";

export interface ChecksumResult {
  /** The expected hash from the sidecar or manifest. */
  expectedHash: string;
  /** The algorithm used. */
  algo: "sha256" | "md5";
  /** Where the hash came from. */
  source: "sidecar" | "manifest";
}

export interface NoChecksumResult {
  reason: "no-source" | "fetch-failed" | "parse-failed";
  detail?: string;
}

/**
 * Parse a checksum sidecar body. Handles both bare hash and sumfile
 * format by splitting on whitespace and taking the first token.
 */
export function parseChecksumBody(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  const firstToken = trimmed.split(/\s+/)[0];
  return firstToken || undefined;
}

/**
 * Fetch a sidecar checksum from `downloadUrl + "." + algo`.
 * Returns the hash string, or undefined on 404/403 (not available).
 */
async function fetchSidecarChecksum(
  downloadUrl: string,
  algo: "sha256" | "md5",
): Promise<string | undefined> {
  const sidecarUrl = `${downloadUrl}.${algo}`;
  const res = await fetch(sidecarUrl, {
    signal: AbortSignal.timeout(15_000),
  });
  // 403/404 = no sidecar available (Kiro CDN returns 403 for missing objects)
  if (res.status === 404 || res.status === 403) return undefined;
  if (!res.ok) {
    throw new Error(
      `Checksum sidecar fetch failed: HTTP ${res.status} for ${sidecarUrl}`,
    );
  }
  const body = await res.text();
  return parseChecksumBody(body);
}

/**
 * Fetch a manifest JSON and extract a hash field.
 * Returns the hash string, or undefined on 404/403.
 */
async function fetchManifestChecksum(
  manifestUrl: string,
  field: string,
): Promise<string | undefined> {
  const res = await fetch(manifestUrl, {
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404 || res.status === 403) return undefined;
  if (!res.ok) {
    throw new Error(
      `Manifest fetch failed: HTTP ${res.status} for ${manifestUrl}`,
    );
  }
  const json = (await res.json()) as Record<string, unknown>;
  const hash = json[field];
  return typeof hash === "string" ? hash.trim() : undefined;
}

/**
 * Attempt to fetch the expected checksum for a server tarball.
 *
 * Tries sidecar first (if `checksumAlgo` is set), then manifest (if
 * `manifestTemplate` is set). Returns the first successful result.
 */
export async function fetchExpectedChecksum(
  downloadUrl: string,
  info: ProductInfo,
  os: string,
  arch: string,
  logger: Logger,
): Promise<ChecksumResult | NoChecksumResult> {
  if (info.checksumMethod === "manifest") {
    // Manifest method: fetch JSON and extract hash field.
    if (info.manifestTemplate && info.manifestField) {
      try {
        const { url, unresolved } = await resolveTemplateUrl(
          info.manifestTemplate,
          info,
          os,
          arch,
        );
        if (unresolved.length > 0) {
          logger.info(`[checksum] manifest template has unresolved vars: ${unresolved.join(", ")}`);
          return { reason: "parse-failed", detail: "unresolved manifest template variables" };
        }
        const hash = await fetchManifestChecksum(url, info.manifestField);
        if (hash) {
          const algo = info.checksumAlgo ?? "sha256";
          logger.info(`[checksum] manifest ${algo}=${hash}`);
          return { expectedHash: hash, algo, source: "manifest" };
        }
        logger.info(`[checksum] manifest not available (404/403)`);
      } catch (err) {
        logger.info(`[checksum] manifest fetch failed: ${err}`);
      }
    }
  } else {
    // Sidecar method: fetch downloadUrl + "." + algo.
    if (info.checksumAlgo) {
      try {
        const hash = await fetchSidecarChecksum(downloadUrl, info.checksumAlgo);
        if (hash) {
          logger.info(`[checksum] sidecar ${info.checksumAlgo}=${hash}`);
          return { expectedHash: hash, algo: info.checksumAlgo, source: "sidecar" };
        }
        logger.info(`[checksum] sidecar not available (404/403)`);
      } catch (err) {
        logger.info(`[checksum] sidecar fetch failed: ${err}`);
      }
    }
  }

  return { reason: "no-source" };
}

/**
 * Compute the hash of a buffer using the given algorithm.
 */
export function computeHash(data: Buffer, algo: "sha256" | "md5"): string {
  return createHash(algo).update(data).digest("hex");
}

/**
 * Verify a tarball buffer against an expected hash.
 * Returns true if the hash matches, false otherwise.
 */
export function verifyHash(
  data: Buffer,
  expectedHash: string,
  algo: "sha256" | "md5",
): boolean {
  const actual = computeHash(data, algo);
  // Constant-time comparison to avoid timing side-channels.
  if (actual.length !== expectedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  }
  return diff === 0;
}
