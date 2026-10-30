# Changelog

## [0.6.1]

### Fixed

- Bumped `qs` to 6.17.1 (transitive via `@vscode/vsce`, build-only) to clear a moderate DoS advisory.

## [0.6.0]

### Fixed

- `apex → remote-ssh` heals after laptop sleep without a reload dialog. Both fast-paths probe the shared ssh session before reuse, mark it dead on failure, fall through to a fresh transport, and throw an `ECONNREFUSED`-shaped dead-guard error so vscode re-resolves.
- `apex → remote-ssh → devcontainer` heals the same way; the session fast-path probe above closes the `resolve()` gap the 0.5.1 `acquireTransport` probe left.
- SOCKS5 connect errors propagate their native `code`/`syscall` (`ECONNREFUSED` + `connect`) so vscode classifies them as retryable.
- `npm audit` advisories cleared.
- `"No view is registered with id: zygos.hosts"` toast in `apex → ssh → devcontainer` windows; `createTreeView("zygos.hosts")` is now gated on `remoteName` (the view is contributed `ssh-remote`-only).

### Changed

- Experimental persistent SSH connection (`zygos.usePersistentConnection`) uses a Go transport instead of Node.js. One ssh connection, one SOCKS5 forward, one Go transport per authority, refcounted across `resolve()` and `resolveExecServer()`; reload reuses a running transport instead of orphaning it.
- Session-path remote execs ride the Go transport (`transport.exec`) instead of the ssh-session control shell, skipping it for bookkeeping round-trips (resolve lock, PID/port metadata, conn-token, nohup wrapper, ready-file poll, error-log tail). The health-monitor ssh-alive ping keeps the control shell.
- Server tarball upload progress (`[install] upload N%`) reports every 5% instead of 1%, matching download.
- Go transport writes one atomic `tunnel-meta.json` (port/pid/token) instead of three files; the reuse probe and dead-pid reap read it in one `cat` round-trip.
- REH ready-file wait uses a `waitForFile` transport op (one blocking call) instead of the 1s `cat` poll loop. Default path keeps the poll.
- Session-path `startTransport` drops the separate `~/.ssh-remote` `mkdir -p`; the first `putFile` creates the parent inside the Go `doPut` op.
- Go transport self-generates its bearer token from `crypto/rand` instead of a `--token-file`; the token ships in `tunnel-meta.json`, dropping one `putFile` round-trip and the pre-listener window.
- `killSharedTransport` reaps the pid from `tunnel-meta.json` and removes `tunnel-meta.json` + `tunnel.log` (the old `tunnel-pid`/`token`/`port` files the Go binary no longer writes); the stale-pid kill was a no-op since the meta-file consolidation.

## [0.5.1]

### Fixed

- SSH Targets tree view registered unconditionally on activation, fixing "No view is registered with id: zygos.hosts" on reload in an ssh-remote window. The view's `remoteName` already gates visibility; the provider registration is always safe.

## [0.5.0]

### Added

- Experimental persistent SSH connection (`zygos.usePersistentConnection`): reuse one long-lived ssh process per window instead of spawning one per command. Faster, with fewer repeated auth prompts. Requires a full restart.
- `zygos.sessionKeyRotationDays` setting for the persistent connection master key.

### Fixed

- Remote server PID discovery now matches `out/server-main.js` instead of the install path, so the recorded PID is the server, not the `sh` wrapper or the ssh tunnel.
- SOCKS forward exit logs now include the ssh stderr tail, so a forward dying before remote setup shows why instead of just `code=255`. (#11)
- Dev-dep advisories cleared via a `@vscode/vsce` 4.0.0 override and `npm audit fix`.

## [0.4.10]

### Added

- New `zygos.handshakeTimeout` setting (default 30s, was hardcoded 15s) for the full SSH handshake including 2FA. When askpass is active, the floor is 2min so password entry isn't rushed.
- New `zygos.tcpTimeout` setting (default 15s, 0 = system default) for the TCP-only connection phase, passed as `-o ConnectTimeout=N`.

## [0.4.9]

### Fixed

- Forwarded ssh agent (`ForwardAgent yes`) keeps working after reconnects: each window's terminals use a stable `SSH_AUTH_SOCK` symlink, repointed on every connection.

## [0.4.8]

### Fixed

- Tree view now passes the ssh config alias (not the resolved host) to ssh, so `Host` block directives (`ProxyJump`, `User`, `IdentityFile`, `ControlMaster`) are honored. (#7)
- `zygos.configFile` and `zygos.sshPath` are now honored by the resolver and the open-terminal / server-log commands; `~` is expanded in both.

## [0.4.7]

### Fixed

- All SSH exec commands now run under `sh -c` (or are simple single-binary commands), so non-POSIX shells like fish don't break the install flow or the exec server. (#7)

## [0.4.6]

### Fixed

- Probe output now anchors on a per-invocation nonce marker, so shell-init output can't corrupt the parsed fields and break busybox bootstrap. (#6)

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
