/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Shared download-stack types. Designed to be copied verbatim into
 * sibling projects (e.g. artizo) - contains only the interfaces the
 * download stack (url.ts, checksum.ts, mergeConfig.ts, configPanel.ts)
 * depends on. Project-specific adapter/product-info types live in
 * `types.ts` and extend these.
 */

/**
 * Minimal logger interface that the download stack (url.ts, checksum.ts,
 * configPanel.ts) calls. Project loggers satisfy this structurally, so
 * files that depend on MinimalLogger can be copied verbatim across
 * projects.
 */
export interface MinimalLogger {
  info(msg: string): void;
  error(msg: string): void;
}

/**
 * Structural adapter subset: just the name and the server download URL
 * method. PlatformAdapter extends this; other projects' adapters that
 * provide these two members satisfy it structurally.
 */
export interface DownloadAdapter {
  /** Human-readable IDE name (e.g. "Kiro"). */
  readonly name: string;

  /**
   * Build the server download URL for the given commit, OS, and arch.
   * Used as the fallback when no custom template is configured via
   * `<ns>.serverDownload.template` (mode="custom").
   */
  getServerDownloadUrl(
    commit: string,
    quality: string,
    os: string,
    arch: string,
  ): string | Promise<string>;
}

/**
 * Structural subset of product info that the download stack (url.ts,
 * checksum.ts, configPanel.ts) reads. Defined separately so the same
 * url.ts/checksum.ts/configPanel.ts files can be copied into sibling
 * projects whose product-info type has a different shape but satisfies
 * this interface structurally.
 */
export interface DownloadTemplateInfo {
  commit: string;
  quality: string;
  version: string;
  /** Release tag - same as version for VSCodium; commit for Kiro. */
  release: string;
  /** product.json productVersion - Qoder server tarball version. */
  productVersion?: string;
  /** product.json windsurfVersion - Devin server tarball version. */
  windsurfVersion?: string;
  /** product.json ideVersion - Antigravity server tarball version. */
  ideVersion?: string;
  /**
   * If set, takes precedence over the adapter's getServerDownloadUrl().
   * Sourced from `<ns>.serverDownload.template` when mode="custom".
   */
  serverDownloadUrlTemplate?: string;
  /** Which checksum method to use. */
  checksumMethod?: "sidecar" | "manifest";
  /** Checksum algorithm for sidecar verification. If set, sidecar URL
   * is `resolvedDownloadUrl + "." + algo`. */
  checksumAlgo?: "sha256" | "md5";
  /** Full URL template for a JSON manifest. Uses the same variables as
   * the download URL template. */
  manifestTemplate?: string;
  /** Field name in the manifest JSON containing the hash. */
  manifestField?: string;
  /** Whether to verify checksums. Default true. */
  verifyChecksum: boolean;
  /** Policy when no checksum source is available:
   * "warn" (proceed with warning), "allow" (proceed silently),
   * "abort" (block installation). Default "warn". */
  onNoChecksum: "warn" | "allow" | "abort";
}
