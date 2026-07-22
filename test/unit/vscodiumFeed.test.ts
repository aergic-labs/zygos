/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  initVscodiumFeed,
  resolveNearestVsCodiumVersion,
  parseVersion,
  compare,
} from "../../src/server/vscodiumFeed";

let tmpDir: string;
let bundledPath: string;
let cachePath: string;

function writeBundled(versions: string[]): void {
  fs.writeFileSync(bundledPath, JSON.stringify(versions, null, 2) + "\n");
}

function writeCache(versions: string[]): void {
  fs.writeFileSync(cachePath, JSON.stringify(versions, null, 2) + "\n");
}

function initPaths(): void {
  initVscodiumFeed({ bundledPath, cachePath });
}

/** Render a fake GitHub releases HTML page containing the given versions. */
function releasesHtml(versions: string[]): string {
  const links = versions
    .map(
      (v) =>
        `<a href="/VSCodium/vscodium/releases/tag/${v}">${v}</a>`,
    )
    .join("\n");
  return `<html><body>${links}</body></html>`;
}

describe("parseVersion", () => {
  it("pads 3-segment versions to 4 with build=0", () => {
    expect(parseVersion("1.124.0")).toEqual([1, 124, 0, 0]);
  });

  it("parses 4-segment versions", () => {
    expect(parseVersion("1.121.0.3429")).toEqual([1, 121, 0, 3429]);
  });

  it("pads 3-segment vscodium-style versions to [major,minor,patch,0]", () => {
    // VSCodium ships "1.121.03429" = VSCode 1.121 build 03429 (3 segments).
    expect(parseVersion("1.121.03429")).toEqual([1, 121, 3429, 0]);
  });

  it("rejects non-numeric segments", () => {
    expect(() => parseVersion("1.x.0")).toThrow(/bad version segment/);
  });

  it("rejects >4 segments", () => {
    expect(() => parseVersion("1.2.3.4.5")).toThrow(/unexpected version format/);
  });
});

describe("compare", () => {
  it("returns 0 for equal 4-tuples", () => {
    expect(compare([1, 124, 0, 0], [1, 124, 0, 0])).toBe(0);
  });

  it("returns negative when a < b", () => {
    expect(compare([1, 121, 0, 3429], [1, 124, 0, 0])).toBeLessThan(0);
  });

  it("returns positive when a > b", () => {
    expect(compare([1, 124, 0, 0], [1, 121, 0, 3429])).toBeGreaterThan(0);
  });

  it("compares build segments after major.minor.patch match", () => {
    expect(compare([1, 121, 0, 100], [1, 121, 0, 200])).toBeLessThan(0);
  });
});

describe("resolveNearestVsCodiumVersion", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zygos-feed-"));
    bundledPath = path.join(tmpDir, "bundled.json");
    cachePath = path.join(tmpDir, "cache.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the highest release <= local when cache has a >= entry", async () => {
    // Bundled list spans above and below the local 1.124.0.
    writeBundled([
      "1.126.04524",
      "1.125.03429",
      "1.124.0",
      "1.121.03429",
      "1.102.0",
    ]);
    initPaths();

    const result = await resolveNearestVsCodiumVersion("1.124.0");
    // 1.124.0 itself is <= and the set has >= entries (1.126.*, 1.125.*).
    expect(result).toBe("1.124.0");
  });

  it("skips a missing exact match and picks the next lower release", async () => {
    // VSCodium skipped 1.124 entirely; nearest below is 1.121.03429.
    writeBundled([
      "1.126.04524",
      "1.125.03429",
      "1.121.03429",
      "1.102.0",
    ]);
    initPaths();

    const result = await resolveNearestVsCodiumVersion("1.124.0");
    expect(result).toBe("1.121.03429");
  });

  it("returns empty string when the version list is empty", async () => {
    writeBundled([]);
    initPaths();
    // No bundled versions and fetch is mocked to return no versions.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(releasesHtml([]), { status: 200 }),
    );
    const result = await resolveNearestVsCodiumVersion("1.124.0");
    expect(result).toBe("");
  });

  it("does not return a <= match when fetch returns empty pages", async () => {
    // Cache only has versions below local; no visibility above. Fetch
    // returns empty pages (exhausted), so the resolver returns empty.
    writeBundled(["1.121.03429", "1.102.0"]);
    initPaths();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(releasesHtml([]), { status: 200 }),
    );
    const result = await resolveNearestVsCodiumVersion("1.124.0");
    expect(result).toBe("");
  });

  it("returns highest available when local is newer than all vscodium releases", async () => {
    // vscode-oss 1.130.0 is newer than every vscodium release. Page 1
    // (sorted descending) confirms no version >= local exists. The
    // highest available is the correct answer, not empty string.
    writeBundled([]);
    initPaths();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("page=1")) {
        return new Response(
          releasesHtml(["1.126.04524", "1.125.03429", "1.121.03429"]),
          { status: 200 },
        );
      }
      return new Response(releasesHtml([]), { status: 200 });
    });
    const result = await resolveNearestVsCodiumVersion("1.130.0");
    expect(result).toBe("1.126.04524");
  });

  it("fetches page 1 and returns the <= match when visibility is reached", async () => {
    // Bundled list is empty; page 1 (sorted descending by GitHub)
    // contains versions spanning above and below local. One fetch
    // suffices - sawGe is true, and the union has a <= match.
    writeBundled([]);
    initPaths();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: any) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("page=1")) {
          return new Response(
            releasesHtml(["1.126.04524", "1.125.03429", "1.121.03429", "1.102.0"]),
            { status: 200 },
          );
        }
        return new Response(releasesHtml([]), { status: 200 });
      });

    const result = await resolveNearestVsCodiumVersion("1.124.0");
    expect(result).toBe("1.121.03429");
    // Only page 1 needed - it has both >= and <= entries.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Cache should contain the fetched versions.
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    expect(cached).toEqual(expect.arrayContaining([
      "1.121.03429",
      "1.102.0",
      "1.126.04524",
      "1.125.03429",
    ]));
  });

  it("returns empty string when fetch throws", async () => {
    writeBundled([]);
    initPaths();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const result = await resolveNearestVsCodiumVersion("1.124.0");
    expect(result).toBe("");
  });

  it("merges bundled and cached lists into the union", async () => {
    writeBundled(["1.126.04524"]);
    writeCache(["1.121.03429"]);
    initPaths();
    const result = await resolveNearestVsCodiumVersion("1.124.0");
    expect(result).toBe("1.121.03429");
  });
});
