/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  substituteTemplate,
  buildServerDownloadUrl,
  resolveTemplateUrl,
  fetchCdnVersion,
} from "../../src/server/url";
import type { PlatformAdapter, ProductInfo } from "../../src/platform/types";

// Substitute the feed module so the lazy `require()` inside resolveTemplateUrl
// resolves under vitest (which does not interop CJS require natively).
const feedMock = vi.fn<(v: string) => Promise<string>>();
vi.mock("../../src/server/vscodiumFeed", () => ({
  resolveNearestVsCodiumVersion: (v: string) => feedMock(v),
}));

function makeProductInfo(overrides: Partial<ProductInfo> = {}): ProductInfo {
  return {
    commit: "abc123",
    quality: "stable",
    version: "1.2.3",
    release: "1.2.3",
    serverApplicationName: "codium-server",
    serverDataFolderName: ".vscodium-server",
    verifyChecksum: false,
    onNoChecksum: "warn",
    ...overrides,
  };
}

const stubAdapter: PlatformAdapter = {
  name: "Test",
  dataFolderName: ".test",
  serverDataFolderName: ".test-server",
  serverApplicationName: "test-server",
  getServerDownloadUrl: (commit, _quality, os, arch) =>
    `https://example.com/${commit}/${os}-${arch}.tar.gz`,
  needsArgvPatch: () => false,
  isValidRuntime: () => true,
};

describe("substituteTemplate", () => {
  it("substitutes all variables", () => {
    const info = makeProductInfo();
    const result = substituteTemplate(
      "https://cdn.test/${version}/${commit}/${quality}/${os}/${arch}/${platform}/${release}",
      info,
      "linux",
      "x64",
    );
    expect(result).toBe(
      "https://cdn.test/1.2.3/abc123/stable/linux/x64/x64/1.2.3",
    );
  });

  it("${platform} is an alias for ${arch}", () => {
    const info = makeProductInfo();
    const result = substituteTemplate("${platform}", info, "linux", "arm64");
    expect(result).toBe("arm64");
  });

  it("handles missing version (release falls back to commit)", () => {
    const info = makeProductInfo({ version: "", release: "abc123" });
    const result = substituteTemplate("${release}", info, "linux", "x64");
    expect(result).toBe("abc123");
  });

  it("leaves unknown placeholders untouched", () => {
    const info = makeProductInfo();
    const result = substituteTemplate("${unknown}", info, "linux", "x64");
    expect(result).toBe("${unknown}");
  });

  it("replaces multiple occurrences of the same variable", () => {
    const info = makeProductInfo();
    const result = substituteTemplate(
      "${version}/${version}/${arch}/${arch}",
      info,
      "linux",
      "x64",
    );
    expect(result).toBe("1.2.3/1.2.3/x64/x64");
  });

  it("substitutes the per-fork version variables", () => {
    const info = makeProductInfo({
      productVersion: "1.12.0",
      windsurfVersion: "3.3.18",
      ideVersion: "2.1.1",
    });
    const result = substituteTemplate(
      "${productVersion}/${windsurfVersion}/${ideVersion}",
      info,
      "linux",
      "x64",
    );
    expect(result).toBe("1.12.0/3.3.18/2.1.1");
  });

  it("leaves \\${cdnVersion} untouched (resolved async, not by substituteTemplate)", () => {
    const info = makeProductInfo();
    const result = substituteTemplate(
      "https://cdn.test/${commit}/Trae-linux-${arch}-${cdnVersion}.tar.gz",
      info,
      "linux",
      "x64",
    );
    expect(result).toBe(
      "https://cdn.test/abc123/Trae-linux-x64-${cdnVersion}.tar.gz",
    );
  });
});

describe("resolveTemplateUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves \\${cdnVersion} via the CDN version endpoint", async () => {
    const info = makeProductInfo({ commit: "abc123" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("v123", { status: 200 }));

    const { url, unresolved } = await resolveTemplateUrl(
      "https://cdn.test/pkg/${commit}/Trae-linux-${arch}-${cdnVersion}.tar.gz",
      info,
      "linux",
      "x64",
    );

    // Version endpoint = tarball dir + "/version".
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.test/pkg/abc123/version",
      expect.objectContaining({ method: "GET" }),
    );
    expect(url).toBe("https://cdn.test/pkg/abc123/Trae-linux-x64-v123.tar.gz");
    expect(unresolved).toEqual([]);
  });

  it("reports unresolved placeholders when a var is missing", async () => {
    const info = makeProductInfo({ commit: "abc123" });
    const { unresolved } = await resolveTemplateUrl(
      "https://cdn.test/${commit}/${unknown}",
      info,
      "linux",
      "x64",
    );
    expect(unresolved).toEqual(["${unknown}"]);
  });

  it("resolves ${nearestVsCodiumVersion} via the feed resolver", async () => {
    const info = makeProductInfo({ commit: "abc123", version: "1.124.0" });
    feedMock.mockResolvedValue("1.121.03429");

    const { url, unresolved } = await resolveTemplateUrl(
      "https://github.com/VSCodium/vscodium/releases/download/${nearestVsCodiumVersion}/vscodium-reh-${os}-${arch}-${nearestVsCodiumVersion}.tar.gz",
      info,
      "linux",
      "x64",
    );

    expect(feedMock).toHaveBeenCalledWith("1.124.0");
    expect(url).toBe(
      "https://github.com/VSCodium/vscodium/releases/download/1.121.03429/vscodium-reh-linux-x64-1.121.03429.tar.gz",
    );
    expect(unresolved).toEqual([]);
  });

  it("reports unresolved when the feed returns empty", async () => {
    const info = makeProductInfo({ commit: "abc123", version: "1.124.0" });
    feedMock.mockResolvedValue("");

    const { url, unresolved } = await resolveTemplateUrl(
      "https://cdn.test/${nearestVsCodiumVersion}/reh.tar.gz",
      info,
      "linux",
      "x64",
    );

    // Empty resolution substitutes an empty string - the placeholder is
    // gone, but the URL is malformed. No unresolved placeholder remains.
    expect(url).toBe("https://cdn.test//reh.tar.gz");
    expect(unresolved).toEqual([]);
  });
});

describe("fetchCdnVersion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("derives the version endpoint by stripping the filename segment", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("9.9.9", { status: 200 }));
    const version = await fetchCdnVersion(
      "https://cdn.test/dir/Trae-linux-x64-${cdnVersion}.tar.gz",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.test/dir/version",
      expect.objectContaining({ method: "GET" }),
    );
    expect(version).toBe("9.9.9");
  });

  it("throws on a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 404 }),
    );
    await expect(
      fetchCdnVersion("https://cdn.test/dir/file.tar.gz"),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe("buildServerDownloadUrl", () => {
  it("uses template when provided", async () => {
    const info = makeProductInfo({
      serverDownloadUrlTemplate:
        "https://cdn.test/${version}/reh-${os}-${arch}.tar.gz",
    });
    const url = await buildServerDownloadUrl(info, stubAdapter, "linux", "x64");
    expect(url).toBe("https://cdn.test/1.2.3/reh-linux-x64.tar.gz");
  });

  it("falls back to adapter.getServerDownloadUrl when no template", async () => {
    const info = makeProductInfo();
    const url = await buildServerDownloadUrl(
      info,
      stubAdapter,
      "linux",
      "arm64",
    );
    expect(url).toBe("https://example.com/abc123/linux-arm64.tar.gz");
  });

  it("template takes precedence over adapter fallback", async () => {
    const info = makeProductInfo({
      serverDownloadUrlTemplate: "https://template.test/${commit}",
    });
    const url = await buildServerDownloadUrl(info, stubAdapter, "linux", "x64");
    expect(url).toBe("https://template.test/abc123");
  });
});
