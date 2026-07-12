/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { PlatformAdapter, ProductInfo } from "./types";

// Build-time flags. esbuild substitutes these as literal booleans, then
// dead-code-eliminates the unused branch - only one adapter's code ships
// in each VSIX.
declare const HAS_KIRO_ADAPTER: boolean;
declare const HAS_VSCODIUM_ADAPTER: boolean;

let _adapter: PlatformAdapter | undefined;

/**
 * Read product.json from the running IDE's appRoot.
 */
export function readProductJson(): Record<string, unknown> {
  const productPath = path.join(vscode.env.appRoot, "product.json");
  return JSON.parse(fs.readFileSync(productPath, "utf-8"));
}

/**
 * Return the platform adapter for the current build target.
 * Synchronous - selection happens at build time, not runtime.
 */
export function detectPlatform(): PlatformAdapter {
  if (_adapter) return _adapter;
  if (HAS_KIRO_ADAPTER) {
    const { KiroAdapter } = require("./kiro");
    _adapter = new KiroAdapter();
    return _adapter!;
  }
  if (HAS_VSCODIUM_ADAPTER) {
    const { VscodiumAdapter } = require("./vscodium");
    _adapter = new VscodiumAdapter();
    return _adapter!;
  }
  throw new Error(
    "No platform adapter compiled in. Rebuild with a valid --target.",
  );
}

/**
 * Get product info (commit, version, server names, download template)
 * from product.json, merged with the `zygos.serverDownload` object setting.
 *
 * `zygos.serverDownload.mode`:
 *   - "auto" (default): use adapter detection.
 *   - "custom": use `zygos.serverDownload.template`.
 *
 * `zygos.serverDownload.binaryName` overrides serverApplicationName when set.
 */
export function getProductInfo(adapter: PlatformAdapter): ProductInfo {
  const product = readProductJson();
  const commit = String(product.commit ?? "");
  const quality = String(product.quality ?? "stable");
  const version = String(product.version ?? "");
  const productVersion =
    typeof product.productVersion === "string" ? product.productVersion : "";
  const windsurfVersion =
    typeof product.windsurfVersion === "string" ? product.windsurfVersion : "";
  const ideVersion =
    typeof product.ideVersion === "string" ? product.ideVersion : "";

  const serverApplicationName =
    typeof product.serverApplicationName === "string"
      ? product.serverApplicationName
      : adapter.serverApplicationName;
  const serverDataFolderName =
    typeof product.serverDataFolderName === "string"
      ? product.serverDataFolderName
      : adapter.serverDataFolderName;

  // Server download config is a single object: { mode, template, binaryName }.
  // mode "auto" (default) = use adapter detection. "custom" = use template.
  const config = vscode.workspace.getConfiguration("zygos");
  const sd = config.get<Record<string, unknown>>("serverDownload", {});
  const downloadMode = typeof sd.mode === "string" ? sd.mode : "auto";

  let serverDownloadUrlTemplate: string | undefined;
  if (downloadMode === "custom") {
    const t = typeof sd.template === "string" ? sd.template.trim() : "";
    if (t) serverDownloadUrlTemplate = t;
  }

  // Optional server binary name override.
  const userBinaryName = typeof sd.binaryName === "string" ? sd.binaryName.trim() : "";
  const finalServerApp = userBinaryName || serverApplicationName;

  // Checksum config: user settings override adapter defaults.
  // In custom mode, only user settings apply (no fork default).
  const adapterChecksum = adapter.getChecksumConfig?.();
  const userChecksumAlgo = typeof sd.checksumAlgo === "string" ? sd.checksumAlgo : "";
  const userManifestTemplate = typeof sd.manifestTemplate === "string" ? sd.manifestTemplate.trim() : "";
  const userManifestField = typeof sd.manifestField === "string" ? sd.manifestField.trim() : "";

  // User overrides take precedence; fall back to adapter defaults.
  const userChecksumMethod = typeof sd.checksumMethod === "string" ? sd.checksumMethod : "";
  const checksumMethod =
    userChecksumMethod === "sidecar" || userChecksumMethod === "manifest"
      ? (userChecksumMethod as "sidecar" | "manifest")
      : adapterChecksum?.checksumMethod;
  const checksumAlgo =
    userChecksumAlgo === "sha256" || userChecksumAlgo === "md5"
      ? (userChecksumAlgo as "sha256" | "md5")
      : adapterChecksum?.checksumAlgo;
  const manifestTemplate = userManifestTemplate || adapterChecksum?.manifestTemplate;
  const manifestField = userManifestField || adapterChecksum?.manifestField;

  const verifyChecksum = sd.verifyChecksum !== false;
  const onNoChecksumRaw = typeof sd.onNoChecksum === "string" ? sd.onNoChecksum : "warn";
  const onNoChecksum =
    onNoChecksumRaw === "allow" || onNoChecksumRaw === "abort"
      ? (onNoChecksumRaw as "allow" | "abort")
      : "warn";

  return {
    commit,
    quality,
    version,
    release: version || commit,
    productVersion,
    windsurfVersion,
    ideVersion,
    serverApplicationName: finalServerApp,
    serverDataFolderName,
    serverDownloadUrlTemplate,
    checksumMethod,
    checksumAlgo,
    manifestTemplate,
    manifestField,
    verifyChecksum,
    onNoChecksum,
  };
}

export type { PlatformAdapter, ProductInfo } from "./types";
