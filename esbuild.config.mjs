/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");
const target = process.env.TARGET || "kiro";

// Per-vendor feature flags. esbuild substitutes these as literal
// booleans and tree-shakes the unused adapter branch out of each VSIX.
const flags = {
  HAS_KIRO_ADAPTER: target === "kiro",
  HAS_VSCODIUM_ADAPTER: target === "vscodium",
};

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minifySyntax: true,
  treeShaking: true,
  mainFields: ["module", "main"],
  logLevel: "info",
  banner: {
    js: `/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */`,
  },
  define: {
    __TARGET__: JSON.stringify(target),
    __BUILD_ID__: JSON.stringify(new Date().toISOString()),
    ...Object.fromEntries(
      Object.entries(flags).map(([k, v]) => [k, JSON.stringify(v)]),
    ),
  },
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log(`[esbuild] watching (target=${target})...`);
  } else {
    await esbuild.build(buildOptions);
    console.log(`[esbuild] build complete (target=${target})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
