/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { FORK_TEMPLATES, type ForkTemplate } from "../../src/platform/forkTemplates";

describe("FORK_TEMPLATES", () => {
  it("has stable, ordered ids", () => {
    expect(FORK_TEMPLATES.map((t) => t.id)).toEqual([
      "vscodium",
      "vscode-oss",
      "kiro",
      "trae-us",
      "trae-sg",
      "trae-cn",
      "devin",
      "antigravity",
      "qoder",
      "custom",
    ]);
  });

  it("each entry has a unique id and a display name", () => {
    const ids = new Set<string>();
    for (const t of FORK_TEMPLATES) {
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
    }
  });

  it("all entries except custom have a non-empty template", () => {
    for (const t of FORK_TEMPLATES) {
      if (t.id === "custom") {
        expect(t.template).toBe("");
        continue;
      }
      expect(t.template.length).toBeGreaterThan(0);
      // Templates use template variables like ${commit}/${version}.
      expect(t.template).toMatch(/\$\{[a-zA-Z]+\}/);
    }
  });

  it("sidecar entries declare a checksumAlgo and no manifest fields", () => {
    const sidecar = FORK_TEMPLATES.filter((t) => t.checksumMethod === "sidecar");
    expect(sidecar.length).toBeGreaterThan(0);
    for (const t of sidecar) {
      expect(t.checksumAlgo).toMatch(/^(sha256|md5)$/);
      expect(t.manifestTemplate).toBeUndefined();
      expect(t.manifestField).toBeUndefined();
    }
  });

  it("manifest entries declare manifestTemplate, manifestField, and checksumAlgo", () => {
    const manifest = FORK_TEMPLATES.filter((t) => t.checksumMethod === "manifest");
    expect(manifest.length).toBeGreaterThan(0);
    for (const t of manifest) {
      expect(t.manifestTemplate).toBeTruthy();
      expect(t.manifestField).toBeTruthy();
      expect(t.checksumAlgo).toMatch(/^(sha256|md5)$/);
    }
  });

  it("entries without checksumMethod have no partial checksum fields", () => {
    for (const t of FORK_TEMPLATES) {
      if (!t.checksumMethod) {
        expect(t.manifestTemplate).toBeUndefined();
        expect(t.manifestField).toBeUndefined();
      }
    }
  });

  it("satisfies the ForkTemplate interface for every entry", () => {
    // Type-check plus structural sanity. Catches accidental field removal.
    for (const t of FORK_TEMPLATES as ForkTemplate[]) {
      expect(typeof t.id).toBe("string");
      expect(typeof t.name).toBe("string");
      expect(typeof t.template).toBe("string");
    }
  });
});
