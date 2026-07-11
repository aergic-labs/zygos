# Zygos Remote SSH for {{NAME}}

Connect to any remote machine via SSH from {{NAME}}. Open folders on remote
hosts, run a full IDE-backed server, and chain into devcontainers - all over
a stock `ssh` binary. No bundled SSH library, no native modules, no
ControlMaster - just OpenSSH.

Sister project to [artizo](https://github.com/aergic-labs/artizo), our
devcontainer extension. Together they give {{NAME}} a complete remote
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
  correct server tarball URL for each fork. A configuration wizard lets
  you override with a custom template and test it before applying.
- **Server bootstrap** - vendored busybox provides a known POSIX env on
  the remote; server tarball streamed client-side over stdin.
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

- {{NAME}} {{URL}}
- An `ssh` binary on your PATH (OpenSSH 8+ recommended).

Everything else is bundled with the extension.

## Getting started

1. Install this extension in {{NAME}}.
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
| `zygos.defaultExtensions` | `[]` | Extension IDs to install on every SSH host. |

## License

GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE)
for the full text. Commercial licensing: contact@aergic.com.

© 2026 Aergic Labs, LLC | [aergic.com](https://aergic.com)
