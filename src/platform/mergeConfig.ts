/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Settings-merge helper shared between sibling projects.
 *
 * Merges raw product.json fields with the `<ns>.serverDownload` user
 * settings object and adapter-provided checksum defaults. This file
 * is designed to be copied verbatim across projects - it depends only
 * on `vscode` and the structural types from `./types`.
 */

import * as vscode from "vscode";
import type { DownloadTemplateInfo } from "./downloadTypes";

/** Fields read from product.json, already resolved with adapter fallbacks. */
export interface RawProductFields {
  commit: string;
  quality: string;
  version: string;
  productVersion?: string;
  windsurfVersion?: string;
  ideVersion?: string;
  serverApplicationName: string;
  serverDataFolderName: string;
}

/** Checksum defaults from the platform adapter (fork-specific). */
export interface ChecksumDefaults {
  checksumMethod?: "sidecar" | "manifest";
  checksumAlgo?: "sha256" | "md5";
  manifestTemplate?: string;
  manifestField?: string;
}

/**
 * Merge raw product.json fields with `<ns>.serverDownload` user settings
 * and adapter checksum defaults. Returns the full download template info
 * plus serverApplicationName (with binaryName override applied) and
 * serverDataFolderName.
 */
export function mergeServerDownloadConfig(
  raw: RawProductFields,
  checksumDefaults: ChecksumDefaults | undefined,
  configNamespace: string,
): DownloadTemplateInfo & {
  serverApplicationName: string;
  serverDataFolderName: string;
} {
  const config = vscode.workspace.getConfiguration(configNamespace);
  const sd = config.get<Record<string, unknown>>("serverDownload", {});
  const downloadMode = typeof sd.mode === "string" ? sd.mode : "auto";

  let serverDownloadUrlTemplate: string | undefined;
  if (downloadMode === "custom") {
    const t = typeof sd.template === "string" ? sd.template.trim() : "";
    if (t) serverDownloadUrlTemplate = t;
  }

  const userBinaryName =
    typeof sd.binaryName === "string" ? sd.binaryName.trim() : "";
  const finalServerApp = userBinaryName || raw.serverApplicationName;

  const userChecksumAlgo =
    typeof sd.checksumAlgo === "string" ? sd.checksumAlgo : "";
  const userManifestTemplate =
    typeof sd.manifestTemplate === "string" ? sd.manifestTemplate.trim() : "";
  const userManifestField =
    typeof sd.manifestField === "string" ? sd.manifestField.trim() : "";

  const userChecksumMethod =
    typeof sd.checksumMethod === "string" ? sd.checksumMethod : "";
  const checksumMethod =
    userChecksumMethod === "sidecar" || userChecksumMethod === "manifest"
      ? (userChecksumMethod as "sidecar" | "manifest")
      : checksumDefaults?.checksumMethod;
  const checksumAlgo =
    userChecksumAlgo === "sha256" || userChecksumAlgo === "md5"
      ? (userChecksumAlgo as "sha256" | "md5")
      : checksumDefaults?.checksumAlgo;
  const manifestTemplate =
    userManifestTemplate || checksumDefaults?.manifestTemplate;
  const manifestField = userManifestField || checksumDefaults?.manifestField;

  const verifyChecksum = sd.verifyChecksum !== false;
  const onNoChecksumRaw =
    typeof sd.onNoChecksum === "string" ? sd.onNoChecksum : "warn";
  const onNoChecksum =
    onNoChecksumRaw === "allow" || onNoChecksumRaw === "abort"
      ? (onNoChecksumRaw as "allow" | "abort")
      : "warn";

  return {
    commit: raw.commit,
    quality: raw.quality,
    version: raw.version,
    release: raw.version || raw.commit,
    productVersion: raw.productVersion,
    windsurfVersion: raw.windsurfVersion,
    ideVersion: raw.ideVersion,
    serverApplicationName: finalServerApp,
    serverDataFolderName: raw.serverDataFolderName,
    serverDownloadUrlTemplate,
    checksumMethod,
    checksumAlgo,
    manifestTemplate,
    manifestField,
    verifyChecksum,
    onNoChecksum,
  };
}
