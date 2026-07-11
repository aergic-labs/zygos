/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Build a vendor-specific VSIX.
 * Usage: node scripts/build-vsix.mjs --target=kiro|vscodium
 *
 * Builds the esbuild bundle (with TARGET env set), then assembles the
 * VSIX in a temp directory to keep the working tree's package.json
 * untouched. Lifted from artizo's build-vsix.mjs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

// Sweep stale staging dirs from killed runs (root + os.tmpdir).
const sweepDir = (dir, label) => {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith("zygos-pack-") && !name.startsWith(".zygos-pack-"))
      continue;
    const p = path.join(dir, name);
    try {
      fs.rmSync(p, { recursive: true, force: true });
      console.log(`Removed stale ${label} staging dir ${name}`);
    } catch {
      // best effort
    }
  }
};
sweepDir(root, "root");
sweepDir(os.tmpdir(), "tmp");

let stageDir;
const cleanup = () => {
  if (stageDir) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    stageDir = undefined;
  }
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(sig, () => {
    cleanup();
    process.exit(130);
  });
}

const target = process.argv
  .find((a) => a.startsWith("--target="))
  ?.split("=")[1];
if (target !== "kiro" && target !== "vscodium") {
  console.error("Usage: node scripts/build-vsix.mjs --target=kiro|vscodium");
  process.exit(1);
}

const basePkgPath = path.join(root, "package.json");
const vendorDir = path.join(root, "vendor", target);
const vendorPkgPath = path.join(vendorDir, "package.json");

const basePkg = JSON.parse(fs.readFileSync(basePkgPath, "utf-8"));
const version = basePkg.version;

const outFile = `zygos-${target}-${version}.vsix`;
const outPath = path.join(root, outFile);
for (const f of fs.readdirSync(root)) {
  if (
    f.startsWith(`zygos-${target}-`) &&
    f.endsWith(".vsix") &&
    f !== outFile
  ) {
    fs.unlinkSync(path.join(root, f));
    console.log(`Removed old ${f}`);
  }
}
if (fs.existsSync(outPath)) {
  fs.unlinkSync(outPath);
  console.log(`Removed old ${outFile}`);
}

try {
  // Clean stale bundles from previous builds
  const distDir = path.join(root, "dist");
  for (const f of fs.readdirSync(distDir)) {
    if (f.startsWith("extension-") && f.endsWith(".js")) {
      fs.unlinkSync(path.join(distDir, f));
    }
  }

  // Normalize LF on shell scripts that ship in the VSIX (Windows CRLF
  // breaks them on Linux remotes).
  for (const f of ["scripts/askpass/askpass.sh"]) {
    const fp = path.join(root, f);
    if (fs.existsSync(fp)) {
      let content = fs.readFileSync(fp, "utf-8");
      if (content.includes("\r")) {
        content = content.replace(/\r/g, "");
        fs.writeFileSync(fp, content, "utf-8");
        console.log(`  Normalized ${f} to LF`);
      }
    }
  }

  console.log(`Building for ${target}...`);
  execSync("node esbuild.config.mjs", {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, TARGET: target },
  });

  console.log("Guarding bundle for competitor strings...");
  execSync(`node scripts/guard-bundle.mjs --target=${target}`, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, TARGET: target },
  });

  // Assemble in temp directory to keep the worktree clean.
  stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "zygos-pack-"));
  console.log(`Packaging in ${stageDir}...`);

  // Merge vendor package.json over base (shallow merge: vendor keys win).
  const vendorOverride = JSON.parse(fs.readFileSync(vendorPkgPath, "utf-8"));
  const stripSpec = vendorOverride.__strip;
  delete vendorOverride.__strip;
  const merged = deepMerge(basePkg, vendorOverride);
  delete merged.scripts;
  delete merged.devDependencies;

  // Strip items declared in __strip from the merged package.json.
  // This lets vendor builds remove base contributes that don't apply
  // (e.g. Kiro has no configurable server download).
  if (stripSpec) {
    stripFromMerged(merged, stripSpec);
  }

  // README: vscodium has its own; others use the template.
  let readme;
  if (target === "vscodium") {
    readme = fs.readFileSync(path.join(vendorDir, "README.md"), "utf-8");
  } else {
    const templatePath = path.join(root, "vendor", "README.template.md");
    readme = fs.readFileSync(templatePath, "utf-8");
    const platform = vendorOverride.platform ?? {};
    const name = platform.name ?? "Kiro";
    const url = name === "Kiro" ? "https://kiro.dev" : "https://vscodium.com";
    readme = readme.replace(/\{\{NAME\}\}/g, name).replace(/\{\{URL\}\}/g, url);
  }

  // Copy project files, skipping dirs that .vscodeignore would exclude.
  const SKIP = new Set([
    "node_modules",
    "vendor",
    ".git",
    "research",
    "upstream",
    "tmp",
    "coverage",
    "dist/meta.json",
    "sim.ps1",
  ]);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const name = entry.name;
    if (SKIP.has(name)) continue;
    if (name.startsWith("zygos-pack-") || name.startsWith(".zygos-pack-"))
      continue;
    if (name.endsWith(".vsix")) continue;
    if (name === "package.json.bak") continue;
    const src = path.join(root, name);
    const dest = path.join(stageDir, name);
    if (entry.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  // Write vendor README over the copied one.
  fs.writeFileSync(path.join(stageDir, "README.md"), readme);

  // Write merged package.json over the copied one.
  fs.writeFileSync(
    path.join(stageDir, "package.json"),
    JSON.stringify(merged, null, 2) + "\n",
  );

  // Clean stale meta.json / source maps copied from dist.
  const metaPath = path.join(stageDir, "dist", "meta.json");
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  const distStage = path.join(stageDir, "dist");
  if (fs.existsSync(distStage)) {
    for (const f of fs
      .readdirSync(distStage)
      .filter((f) => f.endsWith(".map"))) {
      fs.unlinkSync(path.join(distStage, f));
    }
  }

  execSync(
    `npx vsce package --no-dependencies --allow-missing-repository --allow-star-activation -o ${outPath}`,
    {
      cwd: stageDir,
      stdio: "inherit",
    },
  );

  console.log(`Done: ${outFile}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  cleanup();
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (
      k === "contributes" &&
      out.contributes &&
      typeof out.contributes === "object" &&
      v &&
      typeof v === "object"
    ) {
      out.contributes = mergeContributes(out.contributes, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function mergeContributes(baseC, overC) {
  const out = { ...baseC };
  for (const [k, v] of Object.entries(overC)) {
    if (Array.isArray(v) && Array.isArray(out[k])) {
      // Concatenate arrays of commands/menus/etc; later entries win on
      // duplicate command ids (vsce uses last-wins).
      out[k] = [...out[k], ...v];
    } else if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      out[k] &&
      typeof out[k] === "object" &&
      !Array.isArray(out[k])
    ) {
      // configuration.properties - merge keys.
      if (k === "configuration") {
        out[k] = {
          ...(out[k]?.title ? { title: out[k].title } : {}),
          properties: {
            ...(out[k]?.properties ?? {}),
            ...(v.properties ?? {}),
          },
        };
      } else {
        out[k] = { ...out[k], ...v };
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Strip items declared in __strip from the merged package.json.
 * Removes commands, activationEvents, and configuration properties by id/key.
 */
function stripFromMerged(merged, strip) {
  if (strip.commands && merged.contributes?.commands) {
    const ids = new Set(strip.commands);
    merged.contributes.commands = merged.contributes.commands.filter(
      (c) => !ids.has(c.command),
    );
  }
  if (strip.activationEvents && merged.activationEvents) {
    const events = new Set(strip.activationEvents);
    merged.activationEvents = merged.activationEvents.filter(
      (e) => !events.has(e),
    );
  }
  if (strip.configuration && merged.contributes?.configuration?.properties) {
    for (const key of strip.configuration) {
      delete merged.contributes.configuration.properties[key];
    }
  }
}
