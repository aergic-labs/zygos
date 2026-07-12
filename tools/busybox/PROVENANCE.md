# Busybox Binary Provenance

The binaries in `tools/busybox/bb-*` are downloaded at build time by
`scripts/download-busybox.mjs` (run via `make busybox`). They are not
committed to git.

## Pinned checksums

`tools/busybox/checksums.json` pins the exact Alpine version, package
version, APK SHA256, and expected binary SHA256 for each arch. The
download script verifies both hashes and fails if either mismatches.

To upgrade busybox:

1. Manually edit `checksums.json` with the new version and hashes
2. Verify the new APK and binary hashes against the Alpine CDN
3. Run `make busybox` to download and verify

## Generated provenance

`tools/busybox/provenance.json` is generated at download time. It
records the exact source URL, APK SHA256, binary SHA256, and download
timestamp for each binary. This file ships in the VSIX so anyone can
verify the chain from CDN to binary.

## Source

- **Upstream**: https://dl-cdn.alpinelinux.org/alpine/v3.24/main
- **Package**: `busybox-static` (Alpine package, extracts `bin/busybox.static`)
- **License**: GPL-2.0-only (https://busybox.net/license.html)

## Reproduction

To reproduce from source without trusting the CDN:

1. Clone https://gitlab.alpinelinux.org/alpine/aports
2. Build the `busybox-static` package for the target arch using `abuild`
3. Compare the resulting binary's SHA256 against `checksums.json`
