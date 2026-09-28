# Agent Mission Control

Local-first web app that puts every Claude Code session on one screen, surfaces each pending
decision as an "incoming transmission", and routes the answer back into the waiting session via
a blocking MCP tool. Read `docs/architecture.md` for the design and `docs/runbook.md` to wire a
project in. `packages/shared/src/index.ts` is the wire contract; change it there first.

## Layout and ownership

| Path | What | Notes |
| --- | --- | --- |
| `apps/hub` | Bun.serve on 127.0.0.1:4242. Hook receiver, OTLP receiver, decision API, WebSocket, SQLite, serves `apps/web/dist` (or the binary's embedded copy) | env vars in `src/config.ts`; `src/index.ts` `runHub()`; version from root `package.json` via `src/version.ts` |
| `apps/web` | Vite + React UI. `?mock=1` runs a built-in simulator | dev server binds 127.0.0.1:5173 |
| `apps/cli` | The `amc` binary: `start`, `wire`, `unwire`, `doctor`, `mcp`, `--version`. `src/wire.ts` merges hooks, env, the MCP entry and the CLAUDE.md snippet (idempotent; `--gate`, `--local`, `--global`, `--telemetry`); `src/migrate.ts` rewrites repo-path MCP entries to the binary | `build.ts` runs `bun build --compile`, embedding `apps/web/dist` by swapping `src/web-assets.ts` for a generated module of `with { type: "file" }` imports (Bun 1.3 has no directory `--asset`) |
| `packages/mcp-server` | stdio MCP server: `request_decision` (blocks until answered), `report_status` | `src/server.ts` has the testable handlers, `src/index.ts` the stdio entry (`amc mcp`); `CLAUDE_SNIPPET.md` is the CLAUDE.md text for wired projects, inlined into `amc` |
| `packages/shared` | Contract types shared by everything | no runtime code beyond `escalationTier`, except `src/phrases.ts` (`@amc/shared/phrases`): the spoken announcement lines, used by the UI and by the hub's ElevenLabs prewarm |
| `scripts/wire.ts` | The old wiring flags, forwarded to `amc wire` / `amc unwire` (no `--write` means `--dry-run`) | kept for `task wire*` |
| `scripts/dev-sim.ts` | Fakes 3 sessions against a running hub | `task sim` |
| `.github/workflows/release.yml` | On a `v*` tag: cross-compile amc x4, tarballs + SHA256SUMS, git-cliff notes (`cliff.toml`), GitHub pre-release, CHANGELOG.md regenerated on main, formula pushed to dannyhawkins/homebrew-tap | tag must equal root `package.json` version; `dry_run` dispatch makes artifacts only; formula from `packaging/homebrew/amc.rb.tmpl` via `scripts/render-formula.ts`; steps in `docs/releasing.md` |
| `apps/web/public/assets/_src/make.ts` | Source of truth for all pixel art (emits SVG + PNG) | folder is excluded from Biome |

## Commands

```
task install      # bun install + lefthook
task dev          # hub --watch + Vite
task start        # build UI, run hub serving it on :4242
task sim          # fake sessions
task check        # biome + tsc + bun test
task build:bin    # dist/amc (task build:bin:all for darwin/linux x arm64/x64)
amc start [--port N]
amc wire [dir] [--local] [--gate|--gate-questions-only] [--telemetry] [--dry-run]
amc wire --global [--gate|--gate-questions-only] [--snippet] [--telemetry]   # ~/.claude/settings.json + user-scope MCP
amc unwire [dir] | amc unwire --global
amc doctor [dir]
# from a checkout: bun apps/cli/src/main.ts <command>, or task wire / unwire / wire:global / unwire:global
```

## Verified facts (Claude Code 2.1.280, 2026-09-23) that shaped the design

- MCP server processes receive `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PROJECT_DIR` (undocumented but observed). Primary session correlation; ancestor PID chain is the fallback.
- Hooks receive `CLAUDE_PID`; curl hooks send it as `X-Claude-Pid`.
- `MCP_TOOL_TIMEOUT` defaults to ~28h and is not the problem. The blockers for a long-waiting tool are the 30 min stdio idle timeout (a per-server `timeout` in `.mcp.json` floors it; we write 24h) and auto-backgrounding after 2 min (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` in the project's settings env). The MCP server also sends progress notifications every 25s poll.
- A timed-out `PreToolUse` hook skips the tool. The permission gate therefore uses the `PermissionRequest` hook (fires only when a prompt would show; empty output on timeout leaves the terminal prompt intact). Hook timeout default is 600s; gate waits 540s.
- `claude -p --resume` is refused against a session open in a terminal, so "own the loop" routing was rejected.
- Subagents and in-process teammates share the parent's session_id; their hooks add `agent_id` + `agent_type`. A subagent's `request_decision` goes through the parent's MCP server, so the hub attributes it by matching the preceding `PreToolUse` (same agent_id, same question). A nested `claude` gets a new session_id with nothing in env linking it; the process tree does (child claude -> shell -> parent claude).
- `AskUserQuestion` and `ExitPlanMode` fire `PermissionRequest` (no `tool_use_id` in that payload) and the gate can answer them. Ask: `allow` + `updatedInput` = `{questions: <echoed as-is, required or the tool errors>, answers: {"<exact question text>": "label" | "free text" | ["l1","l2"]}}`; key by the verbatim text, Claude rewords questions between runs. Plan approve: `allow` + `updatedInput` = tool_input echoed (a bare allow leaves the terminal menu up); "Approve + auto-accept edits" adds `updatedPermissions: [{type:"setMode",mode:"acceptEdits",destination:"session"}]`. Plan reject: `deny` + message, which Claude sees raw, so every deny message is phrased as the user's own feedback and never names the hub (unframed text was flagged as prompt injection).
- The terminal picker/prompt renders in parallel with the gate hook and the first answer wins; the hook is not killed when the terminal wins. The hub retires the stale card on that call's PostToolUse/PostToolUseFailure (tool_use_id remembered from the preceding PreToolUse), Stop or UserPromptSubmit. Headless `claude -p` has no AskUserQuestion.
- Stop hooks receive `last_assistant_message` (the final reply text) and `stop_hook_active` (true when Claude is already continuing because of a stop hook); `{"decision":"block","reason":...}` makes Claude continue with the reason, and Claude Code ends the turn anyway after 8 consecutive blocks. The hub nudges once (only when `stop_hook_active` is false) and must answer fast because the hook blocks the terminal.
- Gate answers travel back on the hook's open connection, so a gate card is only answerable while that curl is connected. Bun aborts `req.signal` when the client disconnects; the hub expires the card then, expires reloaded gate cards on start, and answers open gates with `{}` on SIGTERM/SIGINT. `request_decision` cards survive restarts (the MCP long-poll reconnects by id).
- Session messaging socket (undocumented, observed 2.1.280, isolated in `apps/hub/src/socket.ts`): newline-delimited JSON to `CLAUDE_CODE_MESSAGING_SOCKET`, optional `{"type":"auth","token":$CLAUDE_CODE_MESSAGING_TOKEN}` then `{"type":"user","message":{"role":"user","content":...}}`; no reply, ~50 ms, starts a turn if idle. Claude Code wraps whatever arrives in its own genuine `<cross-session-message>` envelope (origin `peer`, verified sender pid), so the hub sends plain text with one honest header line ("Message from the user via Mission Control:" / "The user answered your open questions in Mission Control:") and never adds a look-alike envelope or passes it off as typed input. bypassPermissions sessions may hold it. The token is a secret: stored on the session record only, never logged or sent to the UI.
- Session transcripts (JSONL, 2.1.280) hold one record per content block (`thinking`, `text`, `tool_use` are separate assistant lines). Real user prompts are `type:"user"` with string content and no `origin`; tool results, `isMeta` rows, task notifications and peer messages (`origin` set, or text starting "Another Claude session sent a message:") are not. `apps/hub/src/context.ts` reads only the last 256 KB.
- Subagent transcripts live at `<dir of session transcript>/<session id>/subagents/agent-<agent id>.jsonl` (every record `isSidechain: true`); hooks give `agent_transcript_path` only at SubagentStop. Card context for crew decisions reads Claude's text from there.
- A socket message delivered while the session is mid-turn is not dropped and does not wait for the next turn: Claude Code enqueues it (transcript `queue-operation` "enqueue"), and at the next boundary, when the running tool call finishes, removes it with reason `absorbed_mid_turn` and injects it into the same turn as a `queued_command` attachment with `origin.kind: "peer"`; `UserPromptSubmit` fires then and the turn ends with one Stop (verified 2026-09-23 on a scratch session: reply "DONE PINEAPPLE"). Delivered while idle, it starts a new turn. Claude Code shows it as a queued prompt in the terminal.
- Agent teams (observed 2.1.281): `~/.claude/teams/<team>/config.json` is `{name, description, createdAt, leadAgentId, leadSessionId, members: [{agentId: "<name>@<team>", name, agentType, model, joinedAt, tmuxPaneId, cwd, subscriptions, backendType}]}`, lead included as `team-lead`. Hook `agent_id`s for teammates are `a<name>-<16 hex>` and never appear there, so join on name. `leadSessionId` may not be the lead's current session_id (resumed lead). Each teammate has `<transcript dir>/<session>/subagents/agent-<agent_id>.meta.json` with `{name, teamName, agentType, taskKind: "in_process_teammate"}`, the reliable agent_id to team link. Teammates fire SubagentStop then TeammateIdle after every task and SubagentStart again for the next, so the hub keeps them on `standby`.
- ElevenLabs (verified 2026-09-25, `apps/hub/src/tts.ts`): `POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128`, header `xi-api-key`, JSON `{text, model_id, voice_settings: {stability, similarity_boost, style, speed 0.7..1.2, use_speaker_boost}}`, returns mp3 bytes. `GET /v1/voices` returns `{voices: [{voice_id, name, category, labels}]}`; stock voices are `category: "premade"` and carry their character in the name ("Callum - Husky Trickster"), which the hub scores against the persona voice. `eleven_flash_v2_5` is the low-latency model at half the credits per character. The key lives in env or `<dataDir>/secrets.env` (0600 only) and never reaches the UI or logs; tests use a fake server via `AMC_ELEVENLABS_URL` and never read `process.env`. Voices are unique per live session (`voice_assign` table, re-roll via `POST /api/voice/assign`); a persona's phrasing is fixed by its seed (`personaVariant`) so the hub's prewarmed `coreLines` are the lines the UI asks for. A real account has ~21 premade voices, so uniqueness holds for a normal floor.
- QA proved end to end against a real headless session: hooks arrive, the decision round-trips through the tool result, the gate works for Deny and Allow, the hub-down path makes Claude ask in chat, OTLP stats populate.

## Design rulings (from the user, do not relitigate)

- Pixel type (Press Start 2P) only on the wordmark, callsigns, badges, tiny uppercase labels, counters, WAITING timer and TRANSMITTED stamp, never above 12px except the wordmark. All reading text is IBM Plex Mono, body 13px/1.5. VT323 was rejected as tiring.
- Scanline overlay stays faint (7% every 4px). Heavier scanlines over small text read as aliasing.
- The procedural mirrored-half sprites are the crew look and were explicitly liked. The hand-drawn crew sheet in assets is an optional variant, not a replacement.
- Decision cards live on the station, not in a modal or inbox, so you always see who is asking.
- Escalation tiers: amber at 2 min, red at 5, alarm at 10 (`ESCALATION_TIERS_MS` in the contract).
- Sound is synthesised (Web Audio), mutable, armed on first gesture.

## Working conventions

- Bun APIs (Bun.serve, bun:sqlite), no Express. Biome for lint/format, Taskfile for orchestration, Lefthook pre-commit.
- Comments only where something is non-obvious (correlation, timeouts, merge rules, sprite algorithm).
- No em dashes in user-facing strings or docs.
- TypeScript 7 rejects project references to composite+noEmit packages; packages include `../../packages/shared/src` directly instead of `references`.
- If you rename or add an env var, hook, flag or route, grep `docs/` and `README.md` in the same change. Code wins when they disagree, but the person changing code owns the doc sync; the two things most likely to drift are the hub env table and the hooks block in the runbook (`bun apps/cli/src/main.ts wire /tmp --gate --dry-run` prints the truth).
- Test the CLI with temp dirs and `--home`/`AMC_CLAUDE_HOME`/`AMC_DATA_DIR` and a spare port, never the user's `~/.claude`, `~/.claude.json` or live hub. Tests use the file-backed fake in `apps/cli/test/helpers.ts` instead of the `claude` CLI.
- Before restarting a hub that the user is actively using, check `GET /api/state` for pending decisions. Restarting kills every waiting gate hook (the session falls back to its terminal prompt), so wait until nothing is pending, or tell the user first. Learned the hard way on 2026-09-23.
- Track all work on GitHub issues (dannyhawkins/agent-mission-control). Before building a new feature, design change or fix the user asks for, open an issue with the agreed scope (labels: `enhancement`, `bug`, `design`, `idea` for proposed-not-agreed, `deferred` for parked). Commits that finish it end with `Closes #N`; partial work references `#N`. New ideas that come up in conversation get an `idea` issue rather than living only in chat.
