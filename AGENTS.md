# Zygos Agent Instructions

## Critical: Stop means stop

When the user says "stop", "STOP", "wait", "hold on", or any similar
interruption; stop immediately. Do not finish your thought. Do not run one
more tool. Do not add a closing sentence. End your turn right then.

## Critical: Never revert or discard working-tree changes

Never run `git checkout`, `git reset`, `git restore`, `git clean`, or any
other command (rm, etc) that reverts, discards, or overwrites working-tree
changes without explicit permission. This includes `git checkout -- <file>`
and `git checkout HEAD -- <file>`. If a file is broken, explain the situation
and ask before reverting.

## Critical: NO EMDASHES ANYWHERE

Do not use emdashes (—) or endashes (–) anywhere in code, comments, changelog
entries, commit messages, docs, or any other text you write in this repo. Use
a colon, semicolon, comma, parenthetical, or plain rewording instead. This is
a hard rule; do not insert emdashes for emphasis or rhythm.

## Critical: Comments and docs are ultra-terse, not LLM-like

Code comments, changelog entries, commit messages, and docs must be ultra-terse
while keeping all information present. No filler ("it is worth noting that",
"please note", "as a matter of fact"). No hedging ("this might", "could
potentially"). No narration of obvious steps. No restating the code in English.
Say what the reader needs to know that the code does not say. State the
constraint or the why. Then stop. One line if possible, multiple lines only
when the why genuinely needs more. Write like a senior engineer's PR comments,
not like a chatbot explaining its work.

## Shell: detect before assuming

The shell environment is **configurable** and may not be what you expect.
On this machine it is git-bash, but don't hardcode that assumption in
general. Before running shell commands, probe with `echo $SHELL` or
`echo $0` if unsure. Never assume PowerShell on Windows or bash on macOS,
verify first.

## Command quick reference

| Task | Command | Notes |
|------|---------|-------|
| Type-check | `make typecheck` | `tsc --noEmit`, ~3s |
| Lint | `make lint` | tsc + eslint + knip |
| Unit tests | `make test` | `vitest run` |
| Full quality gate | `make check` | lint + test |
| Build bundle + tunnel | `make build` | typecheck + busybox + Go tunnel + esbuild |
| Build single VSIX | `make package-kiro` | Full build + package for kiro |
| Build both VSIXs | `make package` | kiro + vscodium |
| Release | `make release VERSION=x.y.z` | bump, check, package, tag |

## Pipeline (what to run, and when)

```
After any code change:
  1. make typecheck     - TypeScript errors
  2. make test          - vitest (fast)

Before considering work done:
  3. make lint          - tsc + eslint + knip
  4. make test          - One more time, clean exit

Before committing (or when asked to validate fully):
  5. make check         - lint + all tests
```

## Rules

### Go transport lives in `go/tunnel/`

The Go transport server source is in `go/tunnel/`; cross-compiled binaries
land in `tools/tunnel/` (gitignored, shipped in the VSIX). `make build` and
`make package` rebuild the Go binary. Don't edit compiled output in
`tools/tunnel/`; edit the Go source and rebuild.

### Shared-from-zygos files

Some files in the sibling `../artizo` tree are synced 1:1 from this repo via
`make sync-shared` (run from artizo). The list of synced files lives in
artizo's Makefile `SHARED_FROM_ZYGOS` variable. When editing a file that
appears in that list, edit it here in zygos, then run `make sync-shared` from
artizo to propagate.
