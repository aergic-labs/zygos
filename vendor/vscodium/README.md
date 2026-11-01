# Zygos Remote SSH for VSCodium

{{section:intro}}

Supports VSCodium, code-oss, Trae, Devin, Antigravity, Qoder, and IBM Bob,
detected at runtime from `product.json` `applicationName`.

{{section:zygos-integration}}

{{section:features}}

## Requirements

- [VSCodium](https://vscodium.com) (or code-oss)
- An `ssh` binary on your PATH (OpenSSH 8+ recommended).

Everything else is bundled with the extension.

## Getting started

1. Install this extension in VSCodium.
2. Run **Zygos Remote SSH: Connect to SSH Host...**
3. Enter `user@host` (or an `~/.ssh/config` alias).
4. A new window opens on the remote. The first connect downloads the
   server and bootstraps busybox; subsequent connects are fast.

{{section:configuration}}

{{section:custom-download}}

{{section:license}}