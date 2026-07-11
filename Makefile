# Zygos Remote SSH - Makefile
#
# Usage:
#   make build        - typecheck + esbuild bundle
#   make package      - build + package both VSIXs (kiro + vscodium)
#   make package-kiro - build + package kiro VSIX only
#   make package-vscodium - build + package vscodium VSIX only
#   make test         - run vitest
#   make typecheck    - tsc --noEmit
#   make clean        - remove dist/ and VSIX files

NODE ?= node
NPX ?= npx

ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

.PHONY: build package package-kiro package-vscodium test typecheck clean

build: typecheck
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
