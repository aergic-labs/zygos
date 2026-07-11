/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Guard: a built target's bundle must contain no competitor identifiers.
 *
 * Runs after esbuild in build-vsix.mjs. Each per-vendor VSIX ships as a
 * standalone asset, so it must not leak the other vendor's name
 * (case-insensitive). Build-time flags + esbuild tree-shaking isolate the
 * adapters; this guard catches regressions (stray strings/comments in
 * shared files that esbuild keeps since minify is off).
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/** Forbidden substrings per build target (case-insensitive). */
export const FORBIDDEN_TERMS = {
  kiro: ["vscodium", "codium", "code-oss", "vscode-oss"],
  vscodium: ["kiro"],
};

/**
 * Return the list of forbidden terms found in `text`, each with an occurrence
 * count and a short context snippet. Pure function.
 *
 * A term matches only at a token start (negative lookbehind for a letter),
 * so distinctive brand strings are caught even when embedded in a larger
 * identifier, while innocent substrings are not. Matching is case-insensitive.
 */
export function findForbidden(text, terms) {
  const hits = [];
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![a-z])${escaped}`, "gi");
    let count = 0;
    let firstIdx = -1;
    let m;
    while ((m = re.exec(text)) !== null) {
      count++;
      if (firstIdx < 0) firstIdx = m.index;
    }
    if (count > 0) {
      hits.push({
        term,
        count,
        snippet: text.slice(
          Math.max(0, firstIdx - 30),
          firstIdx + term.length + 30,
        ),
      });
    }
  }
  return hits;
}

// CLI
const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(import.meta.dirname, "guard-bundle.mjs");

if (invokedDirectly) {
  const target =
    process.env.TARGET ||
    process.argv.find((a) => a.startsWith("--target="))?.split("=")[1];
  const root = path.resolve(import.meta.dirname, "..");

  if (!target) {
    console.log("guard-bundle: no TARGET set, skipping (build-time guard).");
    process.exit(0);
  }
  if (!FORBIDDEN_TERMS[target]) {
    console.error(
      `guard-bundle: unknown target "${target}" (expected kiro|vscodium)`,
    );
    process.exit(1);
  }

  const distBundle = path.join(root, "dist", "extension.js");
  if (!existsSync(distBundle)) {
    console.error("guard-bundle: dist/extension.js not found, build first");
    process.exit(1);
  }

  const terms = FORBIDDEN_TERMS[target];
  const text = readFileSync(distBundle, "utf-8");
  const hits = findForbidden(text, terms);
  if (hits.length > 0) {
    console.error(
      `guard-bundle: FORBIDDEN competitor strings found in the "${target}" build:`,
    );
    for (const { term, count, snippet } of hits) {
      console.error(
        `  "${term}" x${count}  ...${snippet.replace(/\s+/g, " ")}...`,
      );
    }
    process.exit(1);
  }

  console.log(`guard-bundle: ${target} bundle clean (no competitor strings).`);
}
