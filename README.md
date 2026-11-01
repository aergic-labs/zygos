# Zygos Remote SSH

<!-- BEGIN:intro -->
Connect to any remote machine via SSH. Open folders on remote hosts, run a
full IDE-backed server, and chain into devcontainers - all over a stock `ssh`
binary. No bundled SSH library, no native modules, no ControlMaster - just
OpenSSH.
<!-- END:intro -->

## Supported editors

- Running [Kiro](https://kiro.dev)? Install [Zygos for Kiro](https://open-vsx.org/extension/aergic/zygos-kiro).
- Anything else? Install [Zygos for VSCodium](https://open-vsx.org/extension/aergic/zygos-vscodium).
  Supports: VSCodium, code-oss, Trae, Devin, Antigravity, Qoder, IBM Bob, and other VS Code forks.

<!-- BEGIN:features -->
## Features

- **Stock `ssh` binary** - shells out to your system OpenSSH. Uses your
  existing `~/.ssh/config`, keys, agent, ProxyJump, etc.
- **`resolveExecServer`** - modern resolver API. Devcontainer extensions
  (artizo) chain cleanly without sideload hacks.
- **Managed SOCKS transport** - `ssh -D` SOCKS5 + `ManagedMessagePassing`,
  no port forwarding to manage.
- **Auto-detected server download** - reads `product.json` to build the
  correct server tarball URL per fork. Server tarballs are checksum-verified
  before extraction. A configuration wizard lets you override with a custom
  template and test it before applying.
- **Server bootstrap** - vendored busybox provides a known POSIX env on
  the remote, verified against pinned SHA256 with provenance manifest;
  server tarball streamed client-side over stdin.
- **Server reuse** - detects and reuses an existing running server across
  windows instead of killing and restarting.
- **Sleep/wake resilience** - timer-skew detection repairs the SSH tunnel
  after OS sleep/hibernate.
- **Askpass with persistent cache** - password and passphrase prompts
  surface as VS Code input boxes. Passphrases are cached in an encrypted
  store (SecretStorage + AES-256-GCM) with a configurable TTL, shared
  across windows. Wrong host passwords are detected and evicted.
- **Conflict detection** - detects when a built-in or installed SSH
  extension already owns the `ssh-remote` authority and guides the user
  to disable it.
<!-- END:features -->

<!-- BEGIN:zygos-integration -->
## Zygos Integration

Sister project to [artizo](https://github.com/aergic-labs/artizo), our
devcontainer extension. Together they give your editor a complete remote
development stack: SSH host + devcontainer chaining via `resolveExecServer`.
<!-- END:zygos-integration -->

## Why

Microsoft's Remote-SSH extension is closed-source and locked to VS Code.
Zygos provides the same functionality for Kiro and VSCodium by shelling
out to the system `ssh` binary and implementing the VS Code resolver API
from scratch.

## Requirements

End users:

- A supported editor (see above)
- An `ssh` binary on your PATH (OpenSSH 8+ recommended)

Building from source also requires:

- Node.js 18+
- npm (includes npx)
- GNU Make
- Go 1.26+ (cross-compiles the transport server in `go/tunnel/`;
  see `go/tunnel/go.mod`)
- Internet access (to install dev dependencies and download busybox
  binaries from the Alpine CDN)

## Building from source

```sh
git clone https://github.com/aergic-labs/zygos.git
cd zygos
npm install
make package
```

This produces two VSIX files:

- `zygos-kiro-<version>.vsix`
- `zygos-vscodium-<version>.vsix`

Install the one matching your editor.

### Busybox binaries

The extension ships a statically-linked busybox binary for the remote
bootstrap (x64 and arm64). These are not committed to the repo. `make
package` downloads them automatically from the Alpine Linux CDN,
verifies the APK and binary SHA256 against pinned values in
`tools/busybox/checksums.json`, and writes a `provenance.json` manifest
that ships in the VSIX.

To upgrade busybox:

1. Find the new `busybox-static` package version on the
   [Alpine package index](https://pkgs.alpinelinux.org/packages?name=busybox-static)
2. Download the APKs and compute their SHA256
3. Update `tools/busybox/checksums.json` with the new version and hashes
4. Run `make busybox` to download and verify

See `tools/busybox/PROVENANCE.md` for full details.

## Getting started

1. Install this extension in your editor.
2. Run **Zygos Remote SSH: Connect to SSH Host...**
3. Enter `user@host` (or an `~/.ssh/config` alias).
4. A new window opens on the remote. The first connect downloads the
   server and bootstraps busybox; subsequent connects are fast.

<!-- BEGIN:configuration -->
## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `zygos.serverDownload` | `{}` | Server download config. Use the wizard (**Zygos Remote SSH: Configure Server Download**) instead of editing directly. |
| `zygos.sshPath` | `""` | Absolute path to a custom `ssh` executable. |
| `zygos.configFile` | `""` | Absolute path to a custom SSH config file. |
| `zygos.logLevel` | `info` | Output channel log level: `info`, `debug`, `trace`. |
| `zygos.fileLog` | `false` | Append logs to `~/.zygos/zygos.log` so logs from multiple windows appear in one tailable file. |
| `zygos.askpass` | `true` | Show password/passphrase prompts as VS Code input boxes. |
| `zygos.askpassCacheTtl` | `8` | Hours that cached passphrases survive. 0 = never expire. |
| `zygos.askpassKeyRotationDays` | `7` | Days before the askpass cache master key rotates. 0 = never. |
| `zygos.defaultExtensions` | `[]` | Extension IDs to install on every SSH host. |
| `zygos.httpProxy` | `""` | HTTP proxy URL to forward to the remote server. |
| `zygos.httpsProxy` | `""` | HTTPS proxy URL to forward to the remote server. |
| `zygos.handshakeTimeout` | `30` | Total timeout in seconds for the complete connection sequence. |
| `zygos.tcpTimeout` | `15` | Maximum time in seconds to wait for the initial TCP connection. 0 = system default. |
| `zygos.usePersistentConnection` | `false` | Reuse one ssh process per window for all remote commands. Experimental; restart required. |
| `zygos.sessionKeyRotationDays` | `7` | Days before the persistent connection master key rotates. 0 = never. |
<!-- END:configuration -->

<!-- BEGIN:custom-download -->
## Custom download URL

Out of the box, Zygos reads `version` from `product.json` and constructs the
correct server tarball URL for the detected fork. For custom forks, code-oss
built from source, or mirrors, use the **Zygos Remote SSH: Configure Server
Download** command to switch to custom mode and set a template. Variables
are substituted from `product.json`:

| Variable | Meaning |
|----------|---------|
| `${version}` | `product.json` version string |
| `${commit}` | `product.json` commit |
| `${release}` | Alias for `${version}` (or `${commit}` if version is empty) |
| `${os}` | `linux` (macOS reserved) |
| `${arch}` | `x64`, `arm64`, `armhf` |
| `${quality}` | `product.json` quality (`stable` by default) |
| `${platform}` | Alias for `${arch}` |

Example for a custom fork (set via the configuration wizard):

```
https://cdn.example.com/reh/${version}/myfork-reh-${os}-${arch}.tar.gz
```

The wizard's **Test** button verifies a custom template resolves to a
reachable URL before applying.
<!-- END:custom-download -->

<!-- BEGIN:license -->
## License

GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE)
for the full text. Commercial licensing: contact@aergic.com.

© 2026 Aergic Labs, LLC | [aergic.com](https://aergic.com)
<!-- END:license -->
