# Install

Agent Mission Control is one binary, `amc`. It holds the hub with its UI, the wiring commands
and the MCP server that Claude Code launches, so there is no runtime to install alongside it.
Builds exist for macOS and Linux on arm64 and x64. You also need Claude Code 2.1.280 or later.

- [macOS: Homebrew](#macos-homebrew)
- [macOS and Linux: release tarball](#macos-and-linux-release-tarball)
- [From source](#from-source)
- [After installing](#after-installing)
- [Upgrading](#upgrading)
- [Running at login](#running-at-login)
- [Uninstalling](#uninstalling)

## macOS: Homebrew

```sh
brew install dannyhawkins/tap/amc
amc --version
```

This taps [dannyhawkins/homebrew-tap](https://github.com/dannyhawkins/homebrew-tap) and
installs the build for your Mac's CPU. Homebrew on Linux works the same way.

## macOS and Linux: release tarball

Each [GitHub release](https://github.com/dannyhawkins/agent-mission-control/releases) carries
four tarballs and a checksum file:

| File | Platform |
| --- | --- |
| `amc-<version>-darwin-arm64.tar.gz` | macOS on Apple Silicon |
| `amc-<version>-darwin-x64.tar.gz` | macOS on Intel |
| `amc-<version>-linux-x64.tar.gz` | Linux on x86-64 |
| `amc-<version>-linux-arm64.tar.gz` | Linux on arm64 (aarch64) |
| `SHA256SUMS` | SHA-256 of every tarball |

Download one tarball and `SHA256SUMS` into an empty directory, check it, and unpack it. Set
`VERSION` and `PLATFORM` to match the release and your machine:

```sh
VERSION=0.1.0 PLATFORM=darwin-arm64
BASE=https://github.com/dannyhawkins/agent-mission-control/releases/download/v$VERSION
curl -fsSLO "$BASE/amc-$VERSION-$PLATFORM.tar.gz"
curl -fsSLO "$BASE/SHA256SUMS"

shasum -a 256 -c --ignore-missing SHA256SUMS      # macOS
sha256sum -c --ignore-missing SHA256SUMS          # Linux

tar -xzf "amc-$VERSION-$PLATFORM.tar.gz"          # amc, README.md, LICENSE
```

The check must print `amc-<version>-<platform>.tar.gz: OK`. Anything else means a damaged or
wrong download: delete it and fetch it again.

Then put `amc` somewhere on your `PATH` that it will stay, because wiring records the binary's
full path:

```sh
mkdir -p ~/.local/bin
mv amc ~/.local/bin/           # or: sudo mv amc /usr/local/bin/
amc --version
```

If `amc` is not found, add `~/.local/bin` to `PATH` in your shell profile. If you move the
binary later, run `amc wire --global` again so Claude Code finds it.

On macOS, a tarball downloaded with a browser is quarantined and Gatekeeper refuses to run the
binary, which is signed ad hoc and not notarised. `curl` does not set the quarantine flag.
After checking the checksum, clear it with:

```sh
xattr -d com.apple.quarantine ~/.local/bin/amc
```

## From source

You need [Bun](https://bun.sh) 1.3 or later and [go-task](https://taskfile.dev)
(`brew install go-task`).

```sh
git clone https://github.com/dannyhawkins/agent-mission-control.git
cd agent-mission-control
task install          # bun install + git hooks
task build:bin        # dist/amc for this platform, UI embedded
cp dist/amc ~/.local/bin/
```

Or skip the binary and run everything from the checkout: `task start` runs the hub,
`task wire:global -- --gate` wires Claude Code to `bun <checkout>/apps/cli/src/main.ts mcp`,
and `bun apps/cli/src/main.ts <command>` stands in for `amc <command>`.
[CONTRIBUTING.md](../CONTRIBUTING.md) covers development.

## After installing

```sh
amc start                   # the hub and its UI on http://127.0.0.1:4242, in this terminal
amc wire --global --gate    # in another terminal: wire every Claude Code session
open http://127.0.0.1:4242  # xdg-open on Linux
amc doctor                  # checks the hub, the wiring and Claude Code
```

Restart running Claude Code sessions once (`claude -c` resumes the conversation), because each
session loads its MCP servers when it starts. The [README](../README.md#wiring-options) lists
the other wiring options, and the [runbook](runbook.md) has the details.

## Upgrading

```sh
brew upgrade amc          # Homebrew
```

For a tarball install, repeat the download and checksum steps and replace the binary at the
same path.

Then:

1. Restart the hub: `Ctrl+C` in its terminal, then `amc start`. `amc doctor` warns while the
   running hub is an older version than the binary. Restart when nothing is waiting on the
   floor: every pending permission, question or plan card is a Claude Code hook holding a
   connection open, and a restart drops those sessions back to their terminal prompt.
   `request_decision` cards survive a restart.
2. Run `amc doctor`. Re-run `amc wire --global` (with the flags you used, for example
   `--gate --telemetry`) only if it tells you to, for example when the MCP server points at a
   missing binary. Homebrew installs are wired through Homebrew's stable `opt` path, so an
   upgrade does not move them.
3. If you did rewire, restart running Claude Code sessions (`claude -c`).

## Running at login

Not provided yet. The hub runs in the foreground of the terminal that starts it, so after a
reboot run `amc start` again. Starting it at login is tracked in
[#1](https://github.com/dannyhawkins/agent-mission-control/issues/1).

## Uninstalling

```sh
# 1. Remove the global wiring and any per-project wiring. Your own hooks and
#    settings stay; a backup of each settings file is written first.
amc unwire --global
amc unwire ~/Code/some-project

# 2. Stop the hub (Ctrl+C in its terminal), then delete its data: the SQLite
#    database, config.json, secrets.env and the voice cache.
rm -rf ~/.agent-mission-control

# 3. Optional: delete the settings backups that wiring and unwiring wrote.
rm ~/.claude/settings.json.amc-backup-*

# 4. Remove the binary.
brew uninstall amc                 # Homebrew
rm ~/.local/bin/amc                # tarball or source build: wherever you put it
```

Unwire before removing the binary, since `amc unwire` is what takes the hooks and the MCP
server back out. Restart running Claude Code sessions afterwards so they drop them.
