# Zygos Remote SSH - Makefile
#
# Usage:
#   make build        - typecheck + esbuild bundle
#   make package      - build + package both VSIXs (kiro + vscodium)
#   make package-kiro - build + package kiro VSIX only
#   make package-vscodium - build + package vscodium VSIX only
#   make check        - full quality gate (lint + test)
#   make lint         - typecheck + eslint + knip (TS) + go vet (Go transport)
#   make busybox      - download + verify busybox binaries
#   make test         - run vitest
#   make typecheck    - tsc --noEmit
#   make go-vet       - go vet on the Go transport source
#   make release VERSION=x.y.z - bump version, check, package, tag
#   make clean        - remove dist/ and VSIX files
#   make distclean    - also remove downloaded busybox binaries
#   make publish      - package + publish both VSIXs to OpenVSX

NODE ?= node
NPX ?= npx
VERSION := $(shell npm pkg get version | tr -d '"')

ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

.PHONY: build package package-kiro package-vscodium check lint test typecheck release clean distclean busybox tunnel vscodium-versions publish go-vet

# Always re-download + verify so SHA256 checks run on every build.
busybox:
	$(NODE) scripts/download-busybox.mjs

# Cross-compile the Go transport server. Source in go/tunnel/, binaries
# land in tools/tunnel/ (gitignored, shipped in the VSIX).
tunnel:
	mkdir -p tools/tunnel
	cd go/tunnel && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o ../../tools/tunnel/tunnel-linux-x64 .
	cd go/tunnel && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o ../../tools/tunnel/tunnel-linux-arm64 .

# go vet on the Go transport source. Catches issues `go build` doesn't
# (unused vars, shadowed vars, printf format mismatches, unreachable
# code, etc.). Runs on `make check`; not part of `tunnel` so a build
# stays a build and the gate stays the gate.
go-vet:
	cd go/tunnel && go vet ./...

# Refresh the bundled VSCodium release version list. Fresh download every
# run; not part of `build` so builds stay offline and reproducible.
# Review and commit the updated file.
vscodium-versions:
	$(NODE) scripts/download-vscodium-versions.mjs

build: typecheck go-vet busybox tunnel
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

# Lint across both languages: TS (tsc + eslint + knip) and Go (go vet).
# `npm run lint` is TS-only; go-vet adds the Go transport source.
lint: go-vet
	npm run lint

check: lint test

release:
	@test -n "$(VERSION)" || (echo "Usage: make release VERSION=x.y.z" && exit 1)
	@echo "=== Releasing version $(VERSION) ==="
	npm version $(VERSION) --no-git-tag-version
	$(MAKE) check
	$(MAKE) package
	git add package.json package-lock.json
	git commit -m "Release $(VERSION)"
	git tag "v$(VERSION)"
	@echo "=== Release $(VERSION) ready ==="
	@echo "Next: git push --follow-tags, then make publish"

typecheck:
	$(NPX) tsc --noEmit

clean:
	rm -rf dist
	rm -f zygos-*.vsix

distclean: clean
	rm -f tools/busybox/bb-* tools/busybox/provenance.json
	rm -f tools/vscodium/versions.json
	rm -rf tools/tunnel
