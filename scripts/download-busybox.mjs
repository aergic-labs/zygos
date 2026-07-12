/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Download busybox-static binaries from Alpine CDN.
 *
 * Usage: node scripts/download-busybox.mjs
 *
 * Reads pinned checksums from tools/busybox/checksums.json.
 * Downloads APKs, verifies their SHA256 against the pinned values,
 * extracts bin/busybox.static, verifies the binary SHA256, and
 * writes both binaries plus a provenance.json manifest.
 *
 * Uses only Node.js built-ins; no shell, tar, or curl required.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { get } from "node:https";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEST_DIR = join(ROOT, "tools", "busybox");
const CHECKSUMS_PATH = join(DEST_DIR, "checksums.json");
const PROVENANCE_MD_PATH = join(DEST_DIR, "PROVENANCE.md");

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// HTTP helper

function download(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    get(url, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      if (res.statusCode >= 300 && res.headers.location) {
        resolve(download(res.headers.location));
        return;
      }
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// APK / tar.gz extraction

function extractFromTarGz(gzBuf, targetPath) {
  const buf = gunzipSync(gzBuf);
  let pos = 0;
  const BLOCK = 512;

  while (pos + BLOCK <= buf.length) {
    const name = buf.toString("utf-8", pos, pos + 100).replace(/\0.*/, "");
    if (name === "") break;

    const sizeStr = buf
      .toString("utf-8", pos + 124, pos + 136)
      .replace(/\0.*/, "");
    const size = parseInt(sizeStr, 8) || 0;
    pos += BLOCK;

    if (name === targetPath) {
      return buf.subarray(pos, pos + size);
    }

    pos += Math.ceil(size / BLOCK) * BLOCK;
  }

  return null;
}

// Main

async function main() {
  const checksums = JSON.parse(await readFile(CHECKSUMS_PATH, "utf-8"));
  const alpineVer = checksums.alpineVersion;
  const cdn = `https://dl-cdn.alpinelinux.org/alpine/v${alpineVer}/main`;

  await mkdir(DEST_DIR, { recursive: true });

  const provenance = {
    alpineVersion: alpineVer,
    package: "busybox-static",
    source: "https://dl-cdn.alpinelinux.org/alpine/v" + alpineVer + "/main",
    license: "GPL-2.0-only",
    downloadedAt: new Date().toISOString(),
    binaries: {},
  };

  for (const entry of checksums.binaries) {
    const { alpineArch, runtimeArch, packageVersion, apkSha256, binarySha256 } =
      entry;
    const outFile = `bb-${runtimeArch}`;
    console.log(`${alpineArch} -> ${outFile}`);

    const apkUrl = `${cdn}/${alpineArch}/busybox-static-${packageVersion}.apk`;
    process.stdout.write(`  Downloading APK... `);
    const apkBuf = await download(apkUrl);

    const apkHash = sha256(apkBuf);
    if (apkHash !== apkSha256) {
      console.error(`FAIL`);
      console.error(`  APK SHA256 mismatch:`);
      console.error(`    expected: ${apkSha256}`);
      console.error(`    actual:   ${apkHash}`);
      console.error(`  Update tools/busybox/checksums.json if this is an intentional upgrade.`);
      process.exit(1);
    }
    console.log(`OK (APK ${apkHash.slice(0, 16)}...)`);

    process.stdout.write(`  Extracting bin/busybox.static... `);
    const binary = extractFromTarGz(apkBuf, "bin/busybox.static");
    if (!binary) {
      console.error(`FAIL`);
      console.error(`  bin/busybox.static not found in APK`);
      process.exit(1);
    }

    const binHash = sha256(binary);
    if (binHash !== binarySha256) {
      console.error(`FAIL`);
      console.error(`  Binary SHA256 mismatch:`);
      console.error(`    expected: ${binarySha256}`);
      console.error(`    actual:   ${binHash}`);
      process.exit(1);
    }
    console.log(`OK (${(binary.length / 1024 / 1024).toFixed(1)} MB)`);

    await writeFile(join(DEST_DIR, outFile), binary, { mode: 0o755 });

    provenance.binaries[outFile] = {
      alpineArch,
      runtimeArch,
      packageVersion,
      apkUrl,
      apkSha256,
      binarySha256,
      binarySize: binary.length,
    };
  }

  await writeFile(
    join(DEST_DIR, "provenance.json"),
    JSON.stringify(provenance, null, 2) + "\n",
  );
  console.log(`Wrote provenance.json`);

  const provenanceMd = `# Busybox Binary Provenance

The binaries in \`tools/busybox/bb-*\` are downloaded at build time by
\`scripts/download-busybox.mjs\` (run via \`make busybox\`). They are not
committed to git.

## Pinned checksums

\`tools/busybox/checksums.json\` pins the exact Alpine version, package
version, APK SHA256, and expected binary SHA256 for each arch. The
download script verifies both hashes and fails if either mismatches.

To upgrade busybox:

1. Manually edit \`checksums.json\` with the new version and hashes
2. Verify the new APK and binary hashes against the Alpine CDN
3. Run \`make busybox\` to download and verify

## Generated provenance

\`tools/busybox/provenance.json\` is generated at download time. It
records the exact source URL, APK SHA256, binary SHA256, and download
timestamp for each binary. This file ships in the VSIX so anyone can
verify the chain from CDN to binary.

## Source

- **Upstream**: https://dl-cdn.alpinelinux.org/alpine/v${alpineVer}/main
- **Package**: \`busybox-static\` (Alpine package, extracts \`bin/busybox.static\`)
- **License**: GPL-2.0-only (https://busybox.net/license.html)

## Reproduction

To reproduce from source without trusting the CDN:

1. Clone https://gitlab.alpinelinux.org/alpine/aports
2. Build the \`busybox-static\` package for the target arch using \`abuild\`
3. Compare the resulting binary's SHA256 against \`checksums.json\`
`;
  await writeFile(PROVENANCE_MD_PATH, provenanceMd, "utf-8");
  console.log(`Wrote PROVENANCE.md`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
