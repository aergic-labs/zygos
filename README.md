# Zygos Remote SSH

Connect to any remote machine via SSH. Open folders on remote hosts, run a
full IDE-backed server, and chain into devcontainers - all over a stock `ssh`
binary. No bundled SSH library, no native modules, no ControlMaster - just
OpenSSH.

Sister project to [artizo](https://github.com/aergic-labs/artizo), our
devcontainer extension. Together they give your editor a complete remote
development stack: SSH host + devcontainer chaining via `resolveExecServer`.

## Features

- **Stock `ssh` binary** - shells out to your system OpenSSH. Uses your
  existing `~/.ssh/config`, keys, agent, ProxyJump, etc.
- **`resolveExecServer`** - modern resolver API. Devcontainer extensions
  (artizo) chain cleanly without sideload hacks.
- **Managed SOCKS transport** - `ssh -D` SOCKS5 + `ManagedMessagePassing`,
  no port forwarding to manage.
- **Auto-detected server download** - reads `product.json` to build the
  correct server tarball URL for each fork (VSCodium, Trae, Antigravity,
  Qoder, etc.). Server tarballs are checksum-verified before extraction.
  A configuration wizard lets you override with a custom template and
  test it before applying.
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

## Supported editors

- [Kiro](https://kiro.dev)
- [VSCodium](https://vscodium.com) (including code-oss, VSCodium-OSS,
  Trae, Devin, Antigravity, and Qoder)

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

- `zygos-kiro-0.1.0.vsix`
- `zygos-vscodium-0.1.0.vsix`

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

## License

GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE)
for the full text. Commercial licensing: contact@aergic.com.

© 2026 Aergic Labs, LLC | [aergic.com](https://aergic.com)
