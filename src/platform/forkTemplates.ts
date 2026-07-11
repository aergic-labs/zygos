/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Build-time flag gates whether fork detection templates are included.
// The Kiro build has a single hardcoded URL and does not need the fork list.
declare const HAS_VSCODIUM_ADAPTER: boolean;

/**
 * Fork template definitions shared between the platform adapter and the
 * config webview. Each entry has a display name and a URL template using
 * ${commit}, ${version}, ${os}, ${arch}, ${quality} and per-fork version
 * variables (${productVersion}, ${windsurfVersion}, ${ideVersion},
 * ${cdnVersion}).
 */
export interface ForkTemplate {
  id: string;
  name: string;
  /** URL template. Empty for the "Custom" entry. */
  template: string;
}

/**
 * Fork templates for the config webview. Empty in the Kiro build - Kiro has
 * a single hardcoded URL and guard-bundle strips competitor names.
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
      },
      {
        id: "trae-us",
        name: "Trae (US)",
        template:
          "https://lf-static.traecdn.us/obj/trae-ai-tx/pkg/server/releases/stable/${commit}/linux-debian10/Trae-linux-${arch}-${cdnVersion}.tar.gz",
      },
      {
        id: "trae-sg",
        name: "Trae (SG)",
        template:
          "https://lf-cdn.trae.ai/obj/trae-ai-sg/pkg/server/releases/stable/${commit}/linux-debian10/Trae-linux-${arch}-${cdnVersion}.tar.gz",
      },
      {
        id: "trae-cn",
        name: "Trae (CN)",
        template:
          "https://lf-cdn.trae.com.cn/obj/trae-com-cn/pkg/server/releases/stable/${commit}/linux-debian10/Trae-linux-${arch}-${cdnVersion}.tar.gz",
      },
      {
        id: "devin",
        name: "Devin",
        template:
          "https://windsurf-stable.codeiumdata.com/${os}-reh-${arch}/${quality}/${commit}/devin-reh-${os}-${arch}-${windsurfVersion}.tar.gz",
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
      },
      {
        id: "custom",
        name: "Custom",
        template: "",
      },
    ]
  : [];
