# Zygos Remote SSH - Makefile
#
# Usage:
#   make build        - typecheck + esbuild bundle
#   make package      - build + package both VSIXs (kiro + vscodium)
#   make package-kiro - build + package kiro VSIX only
#   make package-vscodium - build + package vscodium VSIX only
#   make busybox      - download + verify busybox binaries
#   make test         - run vitest
#   make typecheck    - tsc --noEmit
#   make clean        - remove dist/ and VSIX files
#   make distclean    - also remove downloaded busybox binaries

NODE ?= node
NPX ?= npx

ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

.PHONY: build package package-kiro package-vscodium test typecheck clean distclean busybox

# Always re-download + verify so SHA256 checks run on every build.
busybox:
	$(NODE) scripts/download-busybox.mjs

build: typecheck busybox
	$(NODE) esbuild.config.mjs

package-kiro: build
	$(NODE) scripts/build-vsix.mjs --target=kiro

package-vscodium: build
	$(NODE) scripts/build-vsix.mjs --target=vscodium

package: package-kiro package-vscodium

test:
	$(NPX) vitest run

typecheck:
	$(NPX) tsc --noEmit

clean:
	rm -rf dist
	rm -f zygos-*.vsix

distclean: clean
	rm -f tools/busybox/bb-* tools/busybox/provenance.json
