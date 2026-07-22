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
#   make publish      - package + publish both VSIXs to OpenVSX

NODE ?= node
NPX ?= npx
VERSION := $(shell npm pkg get version | tr -d '"')

ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

.PHONY: build package package-kiro package-vscodium test typecheck clean distclean busybox vscodium-versions publish

# Always re-download + verify so SHA256 checks run on every build.
busybox:
	$(NODE) scripts/download-busybox.mjs

# Refresh the bundled VSCodium release version list. Fresh download every
# run; not part of `build` so builds stay offline and reproducible.
# Review and commit the updated file.
vscodium-versions:
	$(NODE) scripts/download-vscodium-versions.mjs

build: typecheck busybox
	$(NODE) esbuild.config.mjs

package-kiro: build
	$(NODE) scripts/build-vsix.mjs --target=kiro

package-vscodium: build
	$(NODE) scripts/build-vsix.mjs --target=vscodium

package: package-kiro package-vscodium

publish: package
	$(NPX) ovsx publish zygos-kiro-$(VERSION).vsix --pat $$OVSX_PAT
	$(NPX) ovsx publish zygos-vscodium-$(VERSION).vsix --pat $$OVSX_PAT

test:
	$(NPX) vitest run

typecheck:
	$(NPX) tsc --noEmit

clean:
	rm -rf dist
	rm -f zygos-*.vsix

distclean: clean
	rm -f tools/busybox/bb-* tools/busybox/provenance.json
	rm -f tools/vscodium/versions.json
