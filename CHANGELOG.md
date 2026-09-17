# Changelog

## [0.4.5]

### Fixed

- Save/restore busybox PATH so it does not leak busybox coreutils into the vscodium server. (#5)
- Dev-dep advisories: `vitest`/`@vitest/mocker` (GHSA-82fw-gwwq-j7x9) and `js-yaml` (GHSA-2883-xcg3-v3hh) via vitest 4→5 bump and transitive update.
- Fixes for various lint warnings from the dep updates.

## [0.4.4]

### Fixed

- High- and moderate-severity advisories in transitive dev deps (`fast-uri`, `qs`) via `npm audit fix`.

## [0.4.3]

### Fixed

- Auth token forwarding now includes the `<clientIdHash>.json` registration sibling so the remote can refresh its own tokens. Previously only `kiro-auth-token.json` was forwarded; the remote would sign out ~1 hour into every session. (#4)
- Auth file writes are now atomic (temp + mv) and non-fatal on read-only mounts.
- Busybox bootstrap now runs before the `installPresent` early return. A host provisioned by another extension can have the server installed but no busybox, breaking downstream `bbExec` calls. (#3)

## [0.4.2]

### Added

- Recent folders in the Remote Explorer tree, with Forget context menu.
- Host items show `user@host` when the ssh config has a `User` directive.
- Auto-refresh the tree when folder history changes (connect, forget).

### Fixed

- High-severity advisory in `nanoid` (transitive dep) via `npm audit fix`.

## [0.4.1]

- Fixed high-severity advisories in transitive dev deps (brace-expansion, fast-uri, js-yaml).

## [0.4.0]

### Added

- On-disk REH download cache (cacache) keyed on the original URL. Cache hits skip the network. 2GB cap with async prune.
- Retry with exponential backoff for transient HTTP and network errors.

### Changed

- Improved resolve time with consolidated lifecycle SSH probes.
- ESLint vendor override block replaces blanket ignore.

## [0.3.0]

### Added

- `${PRODUCT_NAME}` token in the config webview HTML.
- Vitest lcov + html coverage reporters.
- Tests for `forkTemplates`, `mergeConfig`, `secureTempDir` EEXIST retry, askpass cache sweep, `AskpassServer.generateSocketPath`.

### Changed

- Askpass env vars renamed to `AERGIC_SSH_ASKPASS_*` and `aergic-askpass-` socket prefix, shared with artizo.
- Server install probes HOME, arch, busybox, and existing install in a single SSH call.
- `resources/webview/` renamed to `resources/serverDownload/`.
- `src/server/` moved to `src/remote/`.
- ESLint upgraded to 10.8.0.

### Fixed

- Batched remote probe had an unclosed `$(`; parse by `:::` markers. Throws on empty HOME.
- `ssh host:port` destination; pass `[-p, port, user@host]` as separate args.
- Leaked ssh processes when resolve fails after server start.
- Unhandled `'error'` on the dirty askpass db.
- Stale-lock reclaim race in `lifecycle.ts`.
- Global connection-token file shared across installs; filename now per install path.
- Probe timer rescheduled after `stop()`.
- Label formatter re-registered per resolve, never disposed.
- Webview message listener outlived the panel.
- Unhandled rejection in the webview `getState` handler.
- Stdin writer hung/leaked when the remote exited early.
- `dispose()` racing `init()`'s key rotation.
- Unvalidated PID interpolated into `kill` commands.
- `fs.stat` misclassifying empty regular files.
- Conflict popup re-shown on every extension change.
- `OutputChannel` never disposed.
- `resolveExecServer` leak for the same authority.
- `askpassServer.stop()` could hang forever.
- Passphrase validated twice per prompt.
- Commit interpolated into sed without validation.
- Env var names unquoted in `buildCommand`.
- Unresolved URL placeholders silently returned.
- `ls -F` indicator chars `=`, `|` leaking into names.
- Empty error dialog on wrong runtime.
- SSRF guard bypassable via non-dotted IP forms.
- `zygos.hosts` tree view registered too late; VS Code showed "No view is registered" toast when restoring view state in a new ssh-remote window before activation finished.
- `CHANGELOG.md` excluded from VSIX; Open VSX surfaces it on the extension page.

## [0.2.0] - 2026-07-22

### Added

- VSCode-OSS support: maps the local version to the highest
  VSCodium reh release `<=` local via a bundled version list plus
  an append-only runtime cache. New `${nearestVsCodiumVersion}`
  template variable for custom mode.
- Commit patching after server tarball extraction (sed-based) so
  cross-fork downloads pass VS Code's client/Server commit check.
- `make vscodium-versions` target to refresh the bundled version
  list (manual, not part of `make build`).
- Apply buttons in the config webview now show in-flight and
  success/failure status.

### Changed

- Fork template picker in the config webview now uses an explicit
  Load button instead of applying on selection.
- Config webview: status widgets renamed from `test-result` to
  `status`, placed consistently above their button row.
- Static `node:fs/promises` import in sshConfig (was lazy).

### Removed

- Brand-string guard script (`scripts/guard-bundle.mjs`) and its
  build/lint integrations.

## [0.1.0] - 2026-07-12

### Added

- Checksum integrity checks for vendor reh downloads (sidecar or
  manifest, sha256/md5). Per-fork defaults with user override.
- Busybox binaries from Alpine 3.24, downloaded at build
  time with pinned SHA256 verification and provenance manifest.
- CSP nonce on config webview.
- `checksumMethod` selector in the download config webview.
- Build instructions in README.
- Key rotation for askpass cache master key
  (`zygos.askpassKeyRotationDays`).

### Changed

- Askpass cache writes are now awaited before dispose to prevent
  data loss.
- `make package` always re-downloads and verifies busybox.

### Fixed

- Various fixes for config, activation, build.
- chmod askpass.sh on activation (Unix) to fix missing
  executable bit from Windows-packed VSIX.

## [0.0.1] - 2026-07-11

### Added

- SSH resolver using `ManagedResolvedAuthority` with a `ssh -D` SOCKS5
  transport and `ManagedMessagePassing`.
- `resolveExecServer` implementation for devcontainer chaining (artizo).
- Auto-detected server download URL from `product.json`, with a
  configuration wizard for custom templates (VSCodium build only).
  Supports VSCodium, code-oss, Trae, Devin, Antigravity, and
  Qoder.
- Vendored busybox bootstrap on the remote for a known POSIX environment.
- Client-side server tarball download, streamed over SSH stdin.
- Server reuse across windows - detects existing running server instead
  of killing and restarting.
- Sleep/wake resilience via timer-skew detection that repairs the SSH
  tunnel after OS sleep/hibernate.
- Askpass: password and passphrase prompts surface as VS Code input
  boxes, with retry for wrong passphrases.
- Persistent encrypted askpass cache (SecretStorage + AES-256-GCM)
  with configurable TTL (`zygos.askpassCacheTtl`), shared across windows.
  Wrong host passwords are detected and evicted on resolve failure.
- Conflict detection for built-in or installed SSH extensions that
  own the `ssh-remote` authority, with guided disable instructions.
- argv.json patcher to enable proposed APIs (`resolvers`,
  `contribViewsRemote`) on VS Code forks.
- Per-vendor builds for Kiro and VSCodium.
- Host tree view with SSH targets, open terminal, server log, and open
  folder in new window actions.
- Configuration settings: `zygos.sshPath`, `zygos.configFile`,
  `zygos.logLevel`, `zygos.askpass`, `zygos.askpassCacheTtl`,
  `zygos.defaultExtensions`, `zygos.httpProxy`, `zygos.httpsProxy`,
  `zygos.serverDownload`.
