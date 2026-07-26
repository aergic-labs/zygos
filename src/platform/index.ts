/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { PlatformAdapter, ProductInfo } from "./types";
import { mergeServerDownloadConfig, type RawProductFields } from "./mergeConfig";

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
  const raw: RawProductFields = {
    commit: String(product.commit ?? ""),
    quality: String(product.quality ?? "stable"),
    version: String(product.version ?? ""),
    productVersion:
      typeof product.productVersion === "string" ? product.productVersion : "",
    windsurfVersion:
      typeof product.windsurfVersion === "string" ? product.windsurfVersion : "",
    ideVersion:
      typeof product.ideVersion === "string" ? product.ideVersion : "",
    serverApplicationName:
      typeof product.serverApplicationName === "string"
        ? product.serverApplicationName
        : adapter.serverApplicationName,
    serverDataFolderName:
      typeof product.serverDataFolderName === "string"
        ? product.serverDataFolderName
        : adapter.serverDataFolderName,
  };
  return mergeServerDownloadConfig(
    raw,
    adapter.getChecksumConfig?.(),
    "zygos",
  );
}

export type { PlatformAdapter, ProductInfo } from "./types";
