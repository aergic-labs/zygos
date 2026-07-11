# Changelog

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
