# Zygos Remote SSH for VSCodium

Connect to any remote machine via SSH from VSCodium, code-oss, or
VSCodium-OSS. Open folders on remote hosts, run a full IDE-backed server,
and chain into devcontainers - all over a stock `ssh` binary. No bundled
SSH library, no native modules, no ControlMaster - just OpenSSH.

Sister project to [artizo](https://github.com/aergic-labs/artizo), our
devcontainer extension. Together they give VSCodium a complete remote
development stack: SSH host + devcontainer chaining via
`resolveExecServer`.

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
  store with a configurable TTL, shared across windows. Wrong host
  passwords are detected and evicted.
- **Conflict detection** - detects when a built-in or installed SSH
  extension already owns the `ssh-remote` authority and guides the user
  to disable it.

## Requirements

- [VSCodium](https://vscodium.com) (or code-oss / VSCodium-OSS)
- An `ssh` binary on your PATH (OpenSSH 8+ recommended).

Everything else is bundled with the extension.

## Getting started

1. Install this extension in VSCodium.
2. Run **Zygos Remote SSH: Connect to SSH Host...**
3. Enter `user@host` (or an `~/.ssh/config` alias).
4. A new window opens on the remote. The first connect downloads the
   server and bootstraps busybox; subsequent connects are fast.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `zygos.sshPath` | `""` | Absolute path to a custom `ssh` executable. |
| `zygos.configFile` | `""` | Absolute path to a custom SSH config file. |
| `zygos.logLevel` | `info` | Output channel log level: `info`, `debug`, `trace`. |
| `zygos.askpass` | `true` | Show password/passphrase prompts as VS Code input boxes. |
| `zygos.askpassCacheTtl` | `8` | Hours that cached passphrases survive. 0 = never expire. |
| `zygos.askpassKeyRotationDays` | `7` | Days before the askpass cache master key rotates. 0 = never. |
| `zygos.defaultExtensions` | `[]` | Extension IDs to install on every SSH host. |
| `zygos.serverDownload` | `{}` | Server download config. Use the wizard (**Zygos Remote SSH: Configure Server Download**) instead of editing directly. |
| `zygos.httpProxy` | `""` | HTTP proxy URL to forward to the remote server. |
| `zygos.httpsProxy` | `""` | HTTPS proxy URL to forward to the remote server. |

## Custom download URL

Out of the box, Zygos reads `version` from VSCodium's `product.json` and
constructs:

```
https://github.com/VSCodium/vscodium/releases/download/<version>/vscodium-reh-linux-<arch>-<version>.tar.gz
```

For custom forks, code-oss built from source, or mirrors, use the
**Zygos Remote SSH: Configure Server Download** command to switch to custom
mode and set a template. Variables are substituted from `product.json`:

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

## License

GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE)
for the full text. Commercial licensing: contact@aergic.com.

© 2026 Aergic Labs, LLC | [aergic.com](https://aergic.com)
