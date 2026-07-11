/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Platform adapter interface.
 *
 * One VSIX ships per vendor (kiro, vscodium). Build-time flags
 * (HAS_KIRO_ADAPTER / HAS_VSCODIUM_ADAPTER) gate which adapter compiles in;
 * esbuild tree-shakes the other.
 */

export interface PlatformAdapter {
  /** Human-readable IDE name (e.g. "Kiro"). */
  readonly name: string;

  /** Client data folder name (e.g. ".kiro"). */
  readonly dataFolderName: string;

  /** Remote server data folder name (e.g. ".kiro-server"). */
  readonly serverDataFolderName: string;

  /** Remote server application name (e.g. "kiro-server"). */
  readonly serverApplicationName: string;

  /**
   * Build the server download URL for the given commit, OS, and arch.
   * Used as the fallback when no custom template is configured via
   * `zygos.serverDownload.template` (mode="custom").
   */
  getServerDownloadUrl(
    commit: string,
    quality: string,
    os: string,
    arch: string,
  ): string | Promise<string>;

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
export interface ProductInfo {
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
  serverApplicationName: string;
  serverDataFolderName: string;
  /**
   * If set, takes precedence over the adapter's getServerDownloadUrl().
   * Sourced from `zygos.serverDownload.template` when mode="custom".
   */
  serverDownloadUrlTemplate?: string;
}
