/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Server tarball URL construction.
 *
 * Precedence (highest first):
 *   1. ProductInfo.serverDownloadUrlTemplate (from
 *      zygos.serverDownload.template when mode="custom")
 *   2. adapter.getServerDownloadUrl() fallback
 *
 * Template variables:
 *   sync:    ${commit} ${quality} ${version} ${release} ${os} ${arch}
 *            ${platform} (alias for arch) ${productVersion} ${windsurfVersion}
 *            ${ideVersion}
 *   async:   ${cdnVersion} (fetched from a "version" file in the same CDN
 *            directory as the tarball - Trae)
 */

import type { PlatformAdapter, ProductInfo } from "../platform/types";

/**
 * Substitute the synchronous template variables. Leaves async placeholders
 * (e.g. ${cdnVersion}) and unknown placeholders untouched.
 */
export function substituteTemplate(
  template: string,
  info: ProductInfo,
  os: string,
  arch: string,
): string {
  return template
    .replace(/\$\{commit\}/g, info.commit)
    .replace(/\$\{quality\}/g, info.quality)
    .replace(/\$\{version\}/g, info.version)
    .replace(/\$\{release\}/g, info.release)
    .replace(/\$\{productVersion\}/g, info.productVersion ?? "")
    .replace(/\$\{windsurfVersion\}/g, info.windsurfVersion ?? "")
    .replace(/\$\{ideVersion\}/g, info.ideVersion ?? "")
    .replace(/\$\{os\}/g, os)
    .replace(/\$\{arch\}/g, arch)
    .replace(/\$\{platform\}/g, arch);
}

/**
 * Fetch the CDN version string for a ${cdnVersion} placeholder.
 *
 * The tarball and its version file live in the same CDN directory; the
 * version file is named "version". Derive the version endpoint by stripping
 * the tarball filename (the last path segment) from the partially-resolved
 * URL and appending "/version".
 *
 * `partialUrl` is the template with all sync variables already substituted
 * (so ${cdnVersion} is the only remaining placeholder, sitting in the
 * filename segment).
 */
export async function fetchCdnVersion(partialUrl: string): Promise<string> {
  const slash = partialUrl.lastIndexOf("/");
  if (slash < 0) {
    throw new Error("Cannot derive CDN version endpoint from template");
  }
  const versionUrl = partialUrl.slice(0, slash) + "/version";
  const res = await fetch(versionUrl, {
    method: "GET",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(
      `CDN version fetch failed: HTTP ${res.status} for ${versionUrl}`,
    );
  }
  const version = (await res.text()).trim();
  if (!version) {
    throw new Error(`CDN version endpoint returned empty body: ${versionUrl}`);
  }
  return version;
}

/**
 * Resolve a template to a concrete URL: sync substitution first, then an
 * async fetch for ${cdnVersion} if present. Returns the resolved URL and any
 * placeholders that remain unresolved.
 */
export async function resolveTemplateUrl(
  template: string,
  info: ProductInfo,
  os: string,
  arch: string,
): Promise<{ url: string; unresolved: string[] }> {
  let url = substituteTemplate(template, info, os, arch);
  if (url.includes("${cdnVersion}")) {
    const cdnVersion = await fetchCdnVersion(url);
    url = url.replace(/\$\{cdnVersion\}/g, cdnVersion);
  }
  const unresolved = url.match(/\$\{[^}]+\}/g) ?? [];
  return { url, unresolved };
}

export async function buildServerDownloadUrl(
  info: ProductInfo,
  adapter: PlatformAdapter,
  os: string,
  arch: string,
): Promise<string> {
  if (info.serverDownloadUrlTemplate) {
    const { url } = await resolveTemplateUrl(
      info.serverDownloadUrlTemplate,
      info,
      os,
      arch,
    );
    return url;
  }
  return adapter.getServerDownloadUrl(info.commit, info.quality, os, arch);
}
