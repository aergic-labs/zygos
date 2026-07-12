/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Build-time flag selects which fork templates ship. The Kiro build
// includes only the Kiro template + Custom; the VSCodium build includes
// all forks except Kiro.
declare const HAS_VSCODIUM_ADAPTER: boolean;

/**
 * Fork template definitions shared between the platform adapter and the
 * config webview. Each entry has a display name and a URL template using
 * ${commit}, ${version}, ${os}, ${arch}, ${quality} and per-fork version
 * variables (${productVersion}, ${windsurfVersion}, ${ideVersion},
 * ${cdnVersion}).
 *
 * Checksum fields are optional. When `checksumAlgo` is set, the sidecar URL
 * is derived as `downloadUrl + "." + algo`. When `manifestTemplate` is set,
 * a JSON manifest is fetched and `manifestField` is extracted.
 */
export interface ForkTemplate {
  id: string;
  name: string;
  /** URL template. Empty for the "Custom" entry. */
  template: string;
  /** Which checksum method to use. */
  checksumMethod?: "sidecar" | "manifest";
  /** Hash algorithm for sidecar checksum. If set, sidecar URL is
   * derived as `resolvedDownloadUrl + "." + algo`. */
  checksumAlgo?: "sha256" | "md5";
  /** Full URL template for a JSON manifest. Uses the same variables as
   * `template`. If set, the manifest is fetched and `manifestField` is
   * extracted. */
  manifestTemplate?: string;
  /** Field name in the manifest JSON containing the hash. */
  manifestField?: string;
}

/**
 * Fork templates for the config webview.
 *
 * VSCodium build: all forks except Kiro (Kiro URLs are useless in a
 * VSCodium build, and guard-bundle would reject the "kiro" string).
 * Kiro build: just Kiro + Custom.
 *
 * Each fork keys its tarball off a different "version" source, probed from
 * the installed fork's CDN:
 *   VSCodium     -> ${version}            (product.json version)
 *   Trae         -> ${cdnVersion}         (fetched from a CDN version file)
 *   Devin        -> ${windsurfVersion}    (product.json windsurfVersion)
 *   Antigravity  -> ${ideVersion}         (product.json ideVersion)
 *   Qoder        -> ${productVersion}     (product.json productVersion)
 */
export const FORK_TEMPLATES: ForkTemplate[] = HAS_VSCODIUM_ADAPTER
  ? [
      {
        id: "vscodium",
        name: "VSCodium",
        template:
          "https://github.com/VSCodium/vscodium/releases/download/${version}/vscodium-reh-${os}-${arch}-${version}.tar.gz",
        checksumMethod: "sidecar",
        checksumAlgo: "sha256",
      },
      {
        id: "trae-us",
        name: "Trae (US)",
        template:
          "https://lf-static.traecdn.us/obj/trae-ai-tx/pkg/server/releases/stable/${commit}/linux-debian10/Trae-linux-${arch}-${cdnVersion}.tar.gz",
        checksumMethod: "sidecar",
        checksumAlgo: "md5",
      },
      {
        id: "trae-sg",
        name: "Trae (SG)",
        template:
          "https://lf-cdn.trae.ai/obj/trae-ai-sg/pkg/server/releases/stable/${commit}/linux-debian10/Trae-linux-${arch}-${cdnVersion}.tar.gz",
        checksumMethod: "sidecar",
        checksumAlgo: "md5",
      },
      {
        id: "trae-cn",
        name: "Trae (CN)",
        template:
          "https://lf-cdn.trae.com.cn/obj/trae-com-cn/pkg/server/releases/stable/${commit}/linux-debian10/Trae-linux-${arch}-${cdnVersion}.tar.gz",
        checksumMethod: "sidecar",
        checksumAlgo: "md5",
      },
      {
        id: "devin",
        name: "Devin",
        template:
          "https://windsurf-stable.codeiumdata.com/${os}-reh-${arch}/${quality}/${commit}/devin-reh-${os}-${arch}-${windsurfVersion}.tar.gz",
        checksumMethod: "manifest",
        manifestTemplate:
          "https://windsurf-stable.codeiumdata.com/${os}-reh-${arch}/${quality}/manifest-${commit}.json",
        manifestField: "sha256hash",
        checksumAlgo: "sha256",
      },
      {
        id: "antigravity",
        name: "Antigravity",
        template:
          "https://dl.google.com/edgedl/release2/j0qc3/antigravity/${quality}/${ideVersion}-${commit}/${os}-${arch}/Antigravity%20IDE-reh.tar.gz",
      },
      {
        id: "qoder",
        name: "Qoder",
        template:
          "https://download.qoder.com/server/${productVersion}/${commit}/qoder-reh-${os}-${arch}-${productVersion}.tar.gz",
        checksumAlgo: "md5",
      },
      {
        id: "custom",
        name: "Custom",
        template: "",
      },
    ]
  : [
      {
        id: "kiro",
        name: "Kiro",
        template:
          "https://prod.download.desktop.kiro.dev/releases/remotes/${commit}/kiro-reh-${os}-${arch}.tar.gz",
      },
      {
        id: "custom",
        name: "Custom",
        template: "",
      },
    ];
