#!/usr/bin/env node
/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Build-time generator for the bundled VSCodium release version list.
 *
 * Fetches all release pages from GitHub's releases HTML (not the REST
 * API, which is rate-limited). Writes tools/vscodium/versions.json as
 * a JSON array of version strings, sorted descending.
 *
 * Fresh download every run - this is a deliberate manual refresh (`make
 * vscodium-versions`), not part of `make build`. Review and commit the
 * updated file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "tools", "vscodium", "versions.json");

const RELEASES_URL = (page) =>
  `https://github.com/VSCodium/vscodium/releases?page=${page}`;

const TAG_RE = /\/VSCodium\/vscodium\/releases\/tag\/([0-9.]+)/g;

function parseVersions(html) {
  const out = new Set();
  let m;
  while ((m = TAG_RE.exec(html)) !== null) {
    out.add(m[1]);
  }
  return out;
}

async function fetchPage(page) {
  const res = await fetch(RELEASES_URL(page), {
    signal: AbortSignal.timeout(30000),
    headers: { "User-Agent": "zygos-build" },
  });
  if (!res.ok) {
    throw new Error(`page ${page}: HTTP ${res.status}`);
  }
  return await res.text();
}

async function main() {
  const all = new Set();
  let page = 1;
  const maxPages = 50; // safety net; ~10 releases per page = 500 releases
  while (page <= maxPages) {
    let html;
    try {
      html = await fetchPage(page);
    } catch (err) {
      process.stderr.write(`fetch failed at page ${page}: ${err.message}\n`);
      break;
    }
    const pageVersions = parseVersions(html);
    if (pageVersions.size === 0) {
      // Empty page = past the last release. Stop.
      break;
    }
    const before = all.size;
    for (const v of pageVersions) all.add(v);
    const added = all.size - before;
    process.stderr.write(
      `page ${page}: ${pageVersions.size} entries, ${added} new\n`,
    );
    if (added === 0 && page > 1) {
      // No new versions and we've already seen something - done.
      break;
    }
    page += 1;
  }

  const sorted = [...all].sort(compareVersionsDesc);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(sorted, null, 2) + "\n", "utf-8");
  process.stderr.write(
    `wrote ${sorted.length} versions to ${path.relative(ROOT, OUT_PATH)}\n`,
  );
}

// Same comparator used at runtime; duplicated here so the generator has
// no runtime dependency. Keep in sync with src/server/vscodiumFeed.ts.
function compareVersionsDesc(a, b) {
  const ax = parseVersion(a);
  const bx = parseVersion(b);
  for (let i = 0; i < 4; i++) {
    if (ax[i] !== bx[i]) return bx[i] - ax[i];
  }
  return 0;
}

function parseVersion(v) {
  const parts = v.split(".");
  const nums = parts.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`bad version segment "${p}" in "${v}"`);
    }
    return n;
  });
  // VSCodium uses 4 segments (major.minor.patch.build). Local vscode-oss
  // uses 3 (build=0). Pad to 4 for uniform comparison.
  while (nums.length < 4) nums.push(0);
  if (nums.length > 4) {
    throw new Error(`unexpected version format "${v}"`);
  }
  return nums;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
