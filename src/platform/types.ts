/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Zygos-specific platform adapter and product info types.
 *
 * The shared download-stack interfaces (MinimalLogger, DownloadAdapter,
 * DownloadTemplateInfo) live in `downloadTypes.ts` and are re-exported
 * here for backward compatibility. Sibling projects copy
 * `downloadTypes.ts` verbatim and define their own adapter/product-info
 * types that extend those interfaces.
 */

export type {
  DownloadAdapter,
  DownloadTemplateInfo,
} from "./downloadTypes";

import type { DownloadAdapter, DownloadTemplateInfo } from "./downloadTypes";

/**
 * Platform adapter interface.
 *
 * One VSIX ships per vendor (kiro, vscodium). Build-time flags
 * (HAS_KIRO_ADAPTER / HAS_VSCODIUM_ADAPTER) gate which adapter compiles in;
 * esbuild tree-shakes the other.
 */
export interface PlatformAdapter extends DownloadAdapter {
  /** Client data folder name (e.g. ".kiro"). */
  readonly dataFolderName: string;

  /** Remote server data folder name (e.g. ".kiro-server"). */
  readonly serverDataFolderName: string;

  /** Remote server application name (e.g. "kiro-server"). */
  readonly serverApplicationName: string;

  /** Whether the client's argv.json needs patching for proposed APIs. */
  needsArgvPatch(): boolean;

  /** Validate that the runtime is the expected IDE. */
  isValidRuntime(): boolean;

  /**
   * IDs of extensions that declare onResolveRemoteAuthority:ssh-remote,
   * conflicting with zygos. Scans installed extensions at activation.
   * Empty array if none found.
   */
  getConflictingSshExtensionIds?(): string[];

  /**
   * Checksum configuration for the detected fork. Returns undefined if
   * the fork provides no checksum source (Antigravity, Kiro).
   *
   * - `checksumAlgo`: if set, sidecar URL is derived as
   *   `resolvedDownloadUrl + "." + algo`.
   * - `manifestTemplate`: full URL template for a JSON manifest.
   * - `manifestField`: field name in the manifest JSON.
   */
  getChecksumConfig?(): {
    checksumMethod?: "sidecar" | "manifest";
    checksumAlgo?: "sha256" | "md5";
    manifestTemplate?: string;
    manifestField?: string;
  };

  /**
   * Candidate client data folder names to probe for argv.json.
   * Defaults to `[dataFolderName]`. VSCodium overrides this because
   * different builds use `.vscodium` / `.code-oss` / `.vscode`.
   */
  getArgvDataFolderNames?(): string[];

  /**
   * Candidate remote extensions directory names (relative to $HOME).
   * Used to locate `~/.<dir>/extensions` for extension mirroring.
   * Defaults to `[serverDataFolderName/extensions]`.
   */
  getRemoteExtensionsDirCandidates?(): string[];

  /**
   * Read the IDE's auth token from the client (e.g. Kiro SSO token).
   * Returns the raw token contents, or undefined if not present/supported.
   */
  readAuthToken?(): string | undefined;

  /**
   * Path (relative to the remote $HOME) where the auth token should be
   * written. Only meaningful when readAuthToken is implemented.
   */
  getAuthTokenPath?(): string;
}

/**
 * Product info read from product.json at runtime, merged with user settings.
 */
export interface ProductInfo extends DownloadTemplateInfo {
  serverApplicationName: string;
  serverDataFolderName: string;
}
