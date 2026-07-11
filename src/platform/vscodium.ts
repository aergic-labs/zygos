/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import type { PlatformAdapter } from "./types";
import { readProductJson } from "./index";

const VSCODIUM_GITHUB_BASE =
  "https://github.com/VSCodium/vscodium/releases/download";
const DEVIN_CDN_BASE = "https://windsurf-stable.codeiumdata.com";
const ANTIGRAVITY_CDN_BASE =
  "https://dl.google.com/edgedl/release2/j0qc3/antigravity";
const QODER_CDN_BASE = "https://download.qoder.com";
const TRAE_CDN_FALLBACK = "https://lf-cdn.trae.ai/obj/trae-ai-sg";
const TRAE_GUIDANCE_API =
  "https://api.trae.ai/cloudide/api/v3/trae/GetLoginGuidanceForBytedance";

/** Fork config detected at runtime from product.json applicationName. */
interface ForkConfig {
  name: string;
  dataFolderName: string;
  serverDataFolderName: string;
  serverApplicationName: string;
  argvDataFolderNames: string[];
  remoteExtensionsDirs: string[];
  needsArgvPatch: boolean;
}

const VSCODIUM_CONFIG: ForkConfig = {
  name: "VSCodium",
  dataFolderName: ".vscode-oss",
  serverDataFolderName: ".vscodium-server",
  serverApplicationName: "codium-server",
  argvDataFolderNames: [".vscode-oss", ".vscodium", ".code-oss", ".vscode"],
  remoteExtensionsDirs: [
    ".vscodium-server/extensions",
    ".vscode-oss-server/extensions",
  ],
  needsArgvPatch: true,
};

const TRAE_CONFIG: ForkConfig = {
  name: "Trae",
  dataFolderName: ".trae",
  serverDataFolderName: ".trae-server",
  serverApplicationName: "trae-server",
  argvDataFolderNames: [".trae"],
  remoteExtensionsDirs: [".trae-server/extensions"],
  needsArgvPatch: false,
};

const DEVIN_CONFIG: ForkConfig = {
  name: "Devin",
  dataFolderName: ".devin",
  serverDataFolderName: ".devin-server",
  serverApplicationName: "devin-server",
  argvDataFolderNames: [".devin"],
  remoteExtensionsDirs: [".devin-server/extensions"],
  needsArgvPatch: true,
};

const ANTIGRAVITY_CONFIG: ForkConfig = {
  name: "Antigravity",
  dataFolderName: ".antigravity-ide",
  serverDataFolderName: ".antigravity-ide-server",
  serverApplicationName: "antigravity-ide-server",
  argvDataFolderNames: [".antigravity-ide"],
  remoteExtensionsDirs: [".antigravity-ide-server/extensions"],
  needsArgvPatch: true,
};

const QODER_CONFIG: ForkConfig = {
  name: "Qoder",
  dataFolderName: ".qoder",
  serverDataFolderName: ".qoder-server",
  serverApplicationName: "qoder-server",
  argvDataFolderNames: [".qoder"],
  remoteExtensionsDirs: [".qoder-server/extensions"],
  needsArgvPatch: true,
};

function detectFork(): ForkConfig {
  try {
    const product = readProductJson();
    const name = String(product.applicationName ?? "").toLowerCase();
    if (name.includes("trae") || name.includes("byte")) return TRAE_CONFIG;
    if (name.includes("devin") || name.includes("windsurf"))
      return DEVIN_CONFIG;
    if (name.includes("antigravity")) return ANTIGRAVITY_CONFIG;
    if (name.includes("qoder")) return QODER_CONFIG;
  } catch {
    // fall through to vscodium default
  }
  return VSCODIUM_CONFIG;
}

// --- Trae CDN region detection ---

/** Read the Trae CDN base map from product.json bootConfig.cdn. */
function readTraeCdnConfig(): Record<string, string> {
  try {
    const product = readProductJson() as Record<string, unknown>;
    const bootConfig = product?.bootConfig as
      { cdn?: Record<string, string> } | undefined;
    return bootConfig?.cdn ?? {};
  } catch {
    return {};
  }
}

/** Detect the user's Trae CDN region via the public guidance API. */
async function detectTraeRegion(): Promise<string> {
  try {
    const res = await fetch(TRAE_GUIDANCE_API, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { Result?: { Region?: string } };
      const region = data?.Result?.Region;
      if (region) return region.toUpperCase();
    }
  } catch {
    // fall through to US default
  }
  return "US";
}

/** Resolve the Trae CDN base for the auto-detected region. */
async function traeCdnBase(): Promise<string> {
  const region = await detectTraeRegion();
  const cdn = readTraeCdnConfig();
  let base: string | undefined;
  if (region === "US") {
    // US users may need the USTTP CDN over the US one.
    base = cdn.USTTP || cdn.US || cdn.SG;
  } else if (region === "CN") {
    base = cdn.CN || cdn.SG;
  } else {
    base = cdn[region] || cdn.SG;
  }
  return (base || TRAE_CDN_FALLBACK).replace(/\/$/, "");
}

/** Fetch the Trae server version from the CDN version file. Falls back to
 * the commit on failure (matches artizo). */
async function fetchTraeVersion(
  versionUrl: string,
  commit: string,
): Promise<string> {
  try {
    const response = await fetch(versionUrl, {
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) {
      const version = (await response.text()).trim();
      if (version) return version;
    }
  } catch {
    // fall through to commit fallback
  }
  return commit;
}

// --- Adapter ---

/**
 * VSCodium adapter with runtime fork detection.
 *
 * One VSIX, multiple forks. Detects the running IDE from product.json's
 * applicationName at construction time and selects the appropriate fork
 * config (data folders, argv patching, server names, download URL logic).
 *
 * Supported: VSCodium, code-oss, VSCodium-OSS, Trae, Devin,
 * Antigravity, Qoder. The `zygos.serverDownload` object setting overrides
 * automatic detection when mode="custom" (handled in getProductInfo).
 */
export class VscodiumAdapter implements PlatformAdapter {
  private readonly fork: ForkConfig = detectFork();
  readonly name = this.fork.name;
  readonly dataFolderName = this.fork.dataFolderName;
  readonly serverDataFolderName = this.fork.serverDataFolderName;
  readonly serverApplicationName = this.fork.serverApplicationName;

  getServerDownloadUrl(
    commit: string,
    quality: string,
    os: string,
    arch: string,
  ): string | Promise<string> {
    switch (this.fork) {
      case TRAE_CONFIG:
        return this.traeDownloadUrl(commit, arch);
      case DEVIN_CONFIG:
        return this.devinDownloadUrl(commit, quality, os, arch);
      case ANTIGRAVITY_CONFIG:
        return this.antigravityDownloadUrl(commit, quality, os, arch);
      case QODER_CONFIG:
        return this.qoderDownloadUrl(commit, os, arch);
      default:
        return this.vscodiumDownloadUrl(os, arch);
    }
  }

  private vscodiumDownloadUrl(os: string, arch: string): string {
    const version = this.readVersion() || "0.0.0";
    return `${VSCODIUM_GITHUB_BASE}/${version}/vscodium-reh-${os}-${arch}-${version}.tar.gz`;
  }

  private async traeDownloadUrl(commit: string, arch: string): Promise<string> {
    const cdnBase = await traeCdnBase();
    // CDN dir uses linux-debian10, tarball filename uses linux.
    const versionUrl = `${cdnBase}/pkg/server/releases/stable/${commit}/linux-debian10/version`;
    const version = await fetchTraeVersion(versionUrl, commit);
    return `${cdnBase}/pkg/server/releases/stable/${commit}/linux-debian10/Trae-linux-${arch}-${version}.tar.gz`;
  }

  private devinDownloadUrl(
    commit: string,
    quality: string,
    os: string,
    arch: string,
  ): string {
    const version = this.readWindsurfVersion() || "0.0.0";
    return `${DEVIN_CDN_BASE}/${os}-reh-${arch}/${quality}/${commit}/devin-reh-${os}-${arch}-${version}.tar.gz`;
  }

  private antigravityDownloadUrl(
    commit: string,
    quality: string,
    os: string,
    arch: string,
  ): string {
    const version = this.readIdeVersion() || "0.0.0";
    return `${ANTIGRAVITY_CDN_BASE}/${quality}/${version}-${commit}/${os}-${arch}/Antigravity%20IDE-reh.tar.gz`;
  }

  private qoderDownloadUrl(commit: string, os: string, arch: string): string {
    const version = this.readProductVersion() || "0.0.0";
    return `${QODER_CDN_BASE}/server/${version}/${commit}/qoder-reh-${os}-${arch}-${version}.tar.gz`;
  }

  private readVersion(): string | undefined {
    return this.readProductField("version");
  }

  private readWindsurfVersion(): string | undefined {
    return this.readProductField("windsurfVersion");
  }

  private readIdeVersion(): string | undefined {
    return this.readProductField("ideVersion");
  }

  private readProductVersion(): string | undefined {
    return this.readProductField("productVersion");
  }

  private readProductField(field: string): string | undefined {
    try {
      const product = readProductJson();
      const value = (product as Record<string, unknown>)[field];
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  getArgvDataFolderNames(): string[] {
    const fromProduct = this.readProductField("dataFolderName");
    const primary = fromProduct ?? this.fork.dataFolderName;
    const rest = this.fork.argvDataFolderNames.filter((f) => f !== primary);
    return [primary, ...rest];
  }

  getRemoteExtensionsDirCandidates(): string[] {
    // Derive from product.json serverDataFolderName if available.
    const serverFolder = this.readProductField("serverDataFolderName");
    if (serverFolder) {
      return [`${serverFolder}/extensions`];
    }
    return this.fork.remoteExtensionsDirs;
  }

  needsArgvPatch(): boolean {
    return this.fork.needsArgvPatch;
  }

  isValidRuntime(): boolean {
    // VSCodium build allows any runtime. Detection happens for download
    // URL selection, not activation gating.
    return true;
  }

  getConflictingSshExtensionIds(): string[] {
    const ownId = "aergic.zygos-vscodium";
    const ids: string[] = [];
    for (const ext of vscode.extensions.all) {
      if (ext.id === ownId) continue;
      const pj = ext.packageJSON as
        | {
            activationEvents?: string[];
            contributes?: { activationEvents?: string[] };
          }
        | undefined;
      // activationEvents is a top-level field in package.json, not
      // under contributes. Check both for compatibility.
      const events = pj?.activationEvents ?? pj?.contributes?.activationEvents;
      if (!Array.isArray(events)) continue;
      if (events.some((e) => e === "onResolveRemoteAuthority:ssh-remote")) {
        ids.push(ext.id);
      }
    }
    return ids;
  }
}
