/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Nearest VSCodium release version resolver.
 *
 * Used by the vscode-oss fork to map a local `major.minor.patch` version
 * (no build suffix) to the highest VSCodium release version `<=` the
 * local version. VSCodium skips many VS Code releases, so exact match
 * is not reliable; `<=` always finds a usable match if one exists.
 *
 * Two version sources:
 *   1. Bundled list at tools/vscodium/versions.json (generated at build
 *      time, shipped in the VSIX).
 *   2. Persisted cache at ${cachePath}/vscodium-versions.json (per-user,
 *      append-only, no TTL).
 *
 * Resolution:
 *   1. If the union (bundled + cache) contains any version `>=` local,
 *      return the highest version `<=` local. No network.
 *   2. Otherwise, fetch GitHub release pages incrementally, appending
 *      to the cache. Stop when a page contains a version `>=` local
 *      (visibility reached) or when a page returns no new versions
 *      (exhausted). Then apply step 1 again.
 *   3. Edge case: if page 1 (sorted descending, highest first) contains
 *      no version `>=` local, vscodium genuinely hasn't released one.
 *      Return the highest available version as the best match.
 *
 * The `>=` check is the trust anchor for cache-only matches: a `<=` match
 * is only meaningful if we have visibility into releases at or above the
 * local version. Without it, the cache is stale and a better match may
 * exist upstream. But once page 1 confirms no `>=` exists, the highest
 * available IS the best answer.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const RELEASES_URL = (page: number): string =>
  `https://github.com/VSCodium/vscodium/releases?page=${page}`;

// Matches /VSCodium/vscodium/releases/tag/<version> hrefs in the HTML.
const TAG_RE = /\/VSCodium\/vscodium\/releases\/tag\/([0-9.]+)/g;

let bundledPath: string | undefined;
let cachePath: string | undefined;

/** Initialize paths. Called once from activate(). */
export function initVscodiumFeed(opts: {
  bundledPath: string;
  cachePath: string;
}): void {
  bundledPath = opts.bundledPath;
  cachePath = opts.cachePath;
}

/**
 * Resolve the nearest VSCodium release version `<=` localVersion.
 * Returns empty string on any failure (network, parse, no match).
 */
export async function resolveNearestVsCodiumVersion(
  localVersion: string,
): Promise<string> {
  const local = parseVersion(localVersion);

  for (let page = 1; ; page++) {
    const set = loadUnion();
    const match = pickMatch(set, local);
    if (match !== undefined) {
      return match;
    }

    // No match in the current set. Fetch the next page.
    let html: string;
    try {
      html = await fetchPage(page);
    } catch {
      return "";
    }
    const pageVersions = parseVersions(html);
    if (pageVersions.size === 0) {
      // Exhausted. No more releases to discover.
      return "";
    }
    appendToCache(pageVersions);

    // Stop fetching once we have visibility into versions >= local;
    // otherwise keep paging until exhausted.
    let sawGe = false;
    for (const v of pageVersions) {
      if (compare(parseVersion(v), local) >= 0) {
        sawGe = true;
        break;
      }
    }
    if (sawGe) {
      const set2 = loadUnion();
      return pickMatch(set2, local) ?? "";
    }

    // Page 1 is sorted descending - its highest entry is the global
    // highest vscodium release. If page 1 has no version >= local,
 // vscodium hasn't released one. Return the highest available as
    // the best match rather than fetching every remaining page.
    if (page === 1) {
      const set2 = loadUnion();
      return pickHighestLe(set2, local) ?? "";
    }

    if (page > 50) return ""; // safety net
  }
}

/**
 * Pick the highest version `<=` local from the set, but only if the set
 * also contains a version `>=` local. Returns undefined if no trustworthy
 * match.
 */
function pickMatch(set: Set<string>, local: number[]): string | undefined {
  let hasGe = false;
  let best: string | undefined;
  let bestTuple: number[] | undefined;
  for (const v of set) {
    let tuple: number[];
    try {
      tuple = parseVersion(v);
    } catch {
      continue;
    }
    const c = compare(tuple, local);
    if (c >= 0) hasGe = true;
    if (c <= 0) {
      if (bestTuple === undefined || compare(tuple, bestTuple) > 0) {
        best = v;
        bestTuple = tuple;
      }
    }
  }
  return hasGe ? best : undefined;
}

/**
 * Pick the highest version `<=` local from the set without requiring a
 * version `>=` local. Used after a network fetch confirms none exists.
 */
function pickHighestLe(set: Set<string>, local: number[]): string | undefined {
  let best: string | undefined;
  let bestTuple: number[] | undefined;
  for (const v of set) {
    let tuple: number[];
    try {
      tuple = parseVersion(v);
    } catch {
      continue;
    }
    if (compare(tuple, local) <= 0) {
      if (bestTuple === undefined || compare(tuple, bestTuple) > 0) {
        best = v;
        bestTuple = tuple;
      }
    }
  }
  return best;
}

function loadUnion(): Set<string> {
  const set = new Set<string>();
  if (bundledPath) {
    try {
      const arr = JSON.parse(fs.readFileSync(bundledPath, "utf-8"));
      if (Array.isArray(arr)) {
        for (const v of arr) {
          if (typeof v === "string") set.add(v);
        }
      }
    } catch {
      // Bundled file missing or corrupt - skip.
    }
  }
  if (cachePath) {
    try {
      const arr = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      if (Array.isArray(arr)) {
        for (const v of arr) {
          if (typeof v === "string") set.add(v);
        }
      }
    } catch {
      // Cache missing or corrupt - skip.
    }
  }
  return set;
}

function appendToCache(newVersions: Set<string>): void {
  if (!cachePath) return;
  const existing = loadCacheSet();
  let changed = false;
  for (const v of newVersions) {
    if (!existing.has(v)) {
      existing.add(v);
      changed = true;
    }
  }
  if (!changed) return;
  const sorted = [...existing].sort(compareVersionsDesc);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(sorted, null, 2) + "\n", "utf-8");
  } catch {
    // Best effort - the in-memory set is still used this turn.
  }
}

function loadCacheSet(): Set<string> {
  const set = new Set<string>();
  if (!cachePath) return set;
  try {
    const arr = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (Array.isArray(arr)) {
      for (const v of arr) {
        if (typeof v === "string") set.add(v);
      }
    }
  } catch {
    // Missing or corrupt - start fresh.
  }
  return set;
}

async function fetchPage(page: number): Promise<string> {
  const res = await fetch(RELEASES_URL(page), {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.text();
}

function parseVersions(html: string): Set<string> {
  const out = new Set<string>();
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html)) !== null) {
    out.add(m[1]);
  }
  return out;
}

/**
 * Parse `major.minor.patch` or `major.minor.patch.build` into a 4-tuple.
 * Missing segments default to 0. Non-numeric or >4-segment versions throw.
 */
export function parseVersion(v: string): number[] {
  const parts = v.split(".");
  const nums = parts.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`bad version segment "${p}" in "${v}"`);
    }
    return n;
  });
  while (nums.length < 4) nums.push(0);
  if (nums.length > 4) {
    throw new Error(`unexpected version format "${v}"`);
  }
  return nums;
}

/** Tuple compare. Returns negative if a < b, 0 if equal, positive if a > b. */
export function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Sort comparator for descending order. Exported for the build-time generator. */
export function compareVersionsDesc(a: string, b: string): number {
  return compare(parseVersion(b), parseVersion(a));
}
