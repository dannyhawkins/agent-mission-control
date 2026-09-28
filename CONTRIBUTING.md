# Contributing

Thanks for looking. Agent Mission Control is a local-first web app that puts every Claude Code
session on your machine on one screen and routes your answers back into the sessions that are
waiting on you. It is alpha software (0.x): expect breaking changes between minor versions, and
expect it to lean on Claude Code behaviour that is not documented (see the note in the
[README](README.md)).

Read [docs/architecture.md](docs/architecture.md) for the design and
[docs/runbook.md](docs/runbook.md) for wiring a project in.

## Dev setup

You need [Bun](https://bun.sh) 1.x and [go-task](https://taskfile.dev) (`brew install go-task`).

```sh
task install   # bun install + lefthook pre-commit hooks
task dev       # hub on 127.0.0.1:4242 with --watch, Vite UI on 127.0.0.1:5173
```

Open <http://127.0.0.1:5173/?mock=1> to run the UI against a built-in simulator, no Claude Code
needed. `task sim` fakes three sessions against a running hub instead, and `task --list` shows
everything else.

`packages/shared/src/index.ts` is the wire contract between the hub, the UI and the MCP server.
Change it there first.

## Checks

```sh
task check           # biome + tsc + bun test
task test:coverage   # tests with coverage and the aggregate gate CI enforces
```

CI runs Biome, the typecheck, the tests with coverage, the web build and a smoke test of the
compiled `amc` binary. The coverage gate is aggregate across all product code: at least 80% of
lines and 85% of functions (`scripts/coverage-gate.ts`). New code comes with tests.

Lefthook runs Biome on staged files before each commit.

## Branches and pull requests

There is no git flow. Work lands on `main` through pull requests, and releases are tagged from
`main`.

1. Branch from `main`. Name it after the change and the issue, for example `fix/42-gate-timeout`.
2. Open a pull request to `main` and fill in the template. Link the issue (`Closes #42`).
3. CI must pass before merge.

Keep a pull request to one change. If you rename or add an env var, hook, flag or route, update
`docs/` and `README.md` in the same pull request.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org). The changelog is generated
from them, so the type and scope matter.

```
<type>(<scope>): <summary in the imperative, lower case>

<optional body: what and why>

<optional footer: Closes #42, BREAKING CHANGE: ...>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `chore`. Scopes are
usually the package: `hub`, `web`, `cli`, `mcp-server`, `shared`, `wire`.

```
feat(hub): expire gate cards when the hook's curl disconnects
fix(web): keep the WAITING timer running after a reconnect
docs: add the tested-with table to the README
refactor(mcp-server): extract the tool handlers from the stdio entry
feat(shared)!: carry the agent id on every decision

BREAKING CHANGE: hubs older than this release cannot read decisions from the new MCP server.
```

## Issues and labels

Bugs and feature requests go through the issue templates. Security problems do not: see
[SECURITY.md](SECURITY.md).

| Label | Meaning |
| --- | --- |
| `bug` | Something isn't working |
| `enhancement` | Agreed feature or improvement |
| `design` | Visual or interaction design |
| `idea` | Proposed, not yet agreed. Discuss before building |
| `deferred` | Agreed idea, parked until later |
| `security` | Security issue (reported privately first) |

If you want to work on something labelled `idea`, comment on the issue first so we can agree
the shape before you write code.

## For AI-agent contributors

Much of this project is written with Claude Code, and agent contributions are welcome under the
same rules as anyone else's.

- [CLAUDE.md](CLAUDE.md) is the source of truth for layout, commands and conventions. Read it
  first.
- Its **Verified facts** section records Claude Code behaviour that was observed, not
  documented, and that the design depends on. If you find one has changed, say so in the pull
  request with the Claude Code version and how you verified it.
- Its **Design rulings** section records decisions the maintainer has made. Do not relitigate
  them in a pull request; open an issue if you think one should change.
- No em dashes in user-facing strings or docs.
- Say in the pull request how the change was verified (tests, a real session, `?mock=1`).

## Releasing

Releases are tagged from `main`: bump the root `package.json` version, commit
`chore(release): vX.Y.Z`, then push the tag `vX.Y.Z`. The release workflow does the rest.
The full steps, dry runs and the Homebrew tap token are in [docs/releasing.md](docs/releasing.md).
