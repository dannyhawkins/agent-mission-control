# Agent Mission Control: architecture

## Problem

A developer runs four or five Claude Code sessions at once across code, business plans and design work. Each session asks questions, raises permission prompts and hits forks that need a human call, but those requests scroll past in a terminal that nobody is looking at. Sessions sit blocked for minutes without anyone noticing, and there is no record afterwards of what was decided or why.

## Solution

A single local web page shows every live session as a station on a mission control floor. Sessions report in through three channels: Claude Code hooks, OpenTelemetry (OTLP) events, and an explicit `request_decision` MCP tool. When an agent needs a decision it calls the tool, the question appears on its station with context and options, and the tool call blocks until the operator answers in the UI. The answer is returned as the tool result, so it lands in the waiting session with no terminal interaction. Stations escalate visually the longer they wait, every decision is logged, and each session gets a persistent persona so it is recognisable across resumes. Everything runs on one machine, on loopback, with a SQLite file as the only state.

## Components

| Component | Runtime | Role |
| --- | --- | --- |
| Hub (`apps/hub`) | Bun, HTTP + WebSocket on `127.0.0.1:4242` | Receives hooks and OTLP, owns sessions, decisions, personas and the log in SQLite at `~/.agent-mission-control/amc.db`, pushes state to the UI |
| MCP server (`packages/mcp-server`) | Bun, stdio, one process per Claude Code session, spawned by Claude Code | Exposes `request_decision`; posts the decision to the hub and long-polls until answered |
| Hook scripts | `curl` one-liners in the target project's `.claude/settings.json` | Forward Claude Code lifecycle events to the hub |
| OTLP receiver | Part of the hub, `/v1/logs` and `/v1/metrics`, OTLP/HTTP JSON | Ambient activity: prompts, tool results, API calls, token and cost counters |
| Web UI (`apps/web`) | Vite + React, served by the hub in prod | The floor: stations, decision cards, mission log, escalation |

### Data flow

```
 Claude Code session (terminal)                          Hub :4242                      Browser
 ┌──────────────────────────────┐                  ┌────────────────────┐          ┌──────────────┐
 │ hooks ──curl──────────────────┼─POST /api/hooks/*┼─▶ sessions/log     │          │              │
 │ OTLP exporter ────────────────┼─POST /v1/logs ───┼─▶ activity/stats   │──ws /ws─▶│  stations    │
 │ MCP server (child process)    │                  │                    │          │  decisions   │
 │   request_decision ───────────┼─POST /api/decisions──▶ pending ───────┼──ws─────▶│  log         │
 │   ◀── tool result ────────────┼─GET /api/decisions/:id/wait (long-poll)◀─answer──┼──HTTP────────│  operator    │
 └──────────────────────────────┘                  └─────────┬──────────┘          └──────────────┘
                                                             │ SQLite ~/.agent-mission-control/amc.db
```

## Input channels

### Hooks

Claude Code runs configured commands at lifecycle points and pipes a JSON payload to stdin. Every payload carries `session_id`, `cwd`, `transcript_path`, `hook_event_name` and `permission_mode`. The hub subscribes to `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Notification`, `PermissionRequest`, `Stop`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCreated` and `TaskCompleted`. Hooks are the only channel that tells us the session id, the project directory and the process id of the `claude` binary (Claude Code exports `CLAUDE_PID` to hook commands), so `SessionStart` is what creates a station.

New sessions start unengaged (`Session.engaged: false`): hidden, with their log lines held, until a prompt, a main-thread tool call, a crew member or a decision shows real work; sessions that end unengaged are deleted. Sessions whose cwd starts with a prefix on the ignore list (`AMC_IGNORE_CWD` / `config.json` `ignoreCwd`, default `~/.claude-mem`) are dropped at the door: no record, log, events or crew slot, and the gate answers `{}` at once. Hooks can be wired per project or once in `~/.claude/settings.json` (global); Claude Code runs both when both exist, so the hub drops an identical delivery (same session, event and body) within 2 s and lets two identical in-flight gate calls share one decision.

Limits: hook commands must return quickly or they slow the session, so every hook uses `curl -m 3` and swallows failures. `Notification` with `permission_prompt` only fires after the prompt has been waiting about six seconds, and the hook cannot answer the prompt. `SessionEnd` hooks share a 1.5 second budget by default. Hooks see one event at a time and nothing in between, so they cannot tell us whether Claude is thinking or idle.

### Crew: subagents, teammates, nested sessions

A session can have children, shown in its crew bay (`Session.crew`, `CrewMember` in the contract) rather than as stations of their own. Verified on 2.1.280:

- **Subagents and in-process teammates** share the parent's `session_id`. Every hook fired inside one adds `agent_id` and `agent_type`; main-thread hooks have neither. `SubagentStart` creates the member, `SubagentStop` marks it done, and done members linger 60 s (`CREW_GRACE_MS`) so the bay does not flicker. Kind is a heuristic on the id: `a` + 16 hex chars is a Task-tool subagent, anything else (`a<name>-...`) a teammate. Crew hooks bump the member's tool count and last tool and emit activity prefixed with its role; they never touch the parent's own status, last tool or status line. The parent stays `working` while any member is busy, even after the main thread's `Stop` or `idle_prompt` (no idle log line, no blockedSince, so no READY or "standing by"); when the last busy member finishes and the main thread has done nothing since, the session goes idle at that moment and the idle clock starts then. One exception: a crew member's permission prompt is still a prompt in the parent's terminal, so the parent goes `waiting_permission` until that member runs a tool again. A working member silent for `AMC_CREW_STALE_MS` (10 min) is marked done so a killed subagent cannot pin its parent; one waiting on a decision is exempt, and a member marked done this way goes back on shift at its next hook.
- **Subagent labels.** Hooks inside a subagent only say `agent_type` ("general-purpose"). The parent's `PreToolUse` for the `Agent`/`Task` tool carries `tool_input.name`, `description` and `subagent_type`, so the hub queues each one and gives the next `SubagentStart` of that type (FIFO, 30 s) a `label`: the `name`, else the description cut at a word boundary to about 16 chars. `role` stays the agent_type. Calls with `team_name` start teammates and are skipped.
- **Standby teammates.** A teammate fires `SubagentStop` then `TeammateIdle` after every task and `SubagentStart` again under the same `agent_id` when given more work, so a teammate goes to `standby` instead of `done`: drawn dim in the bay, not busy (the lead may go idle and READY around it), exempt from the stale rule, and back to `working` on its next hook. Standby and wake are logged at `AMC_LOG=debug` only. It leaves the bay when the lead ends (SessionEnd or offline), when its team roster no longer lists it or the team is gone, or after `AMC_TEAMMATE_STANDBY_MS` (4 h) of silence; each removal is logged once. Rosters are read (never written) from `<AMC_CLAUDE_HOME>/teams/<team>/config.json` on the 30 s sweep, cached. Roster `agentId`s look like `security@session-8ea4ad4f` while hooks say `asecurity-a484867aa788e408`, so they join on member name, and `leadSessionId` can differ from the lead's current `session_id` (a resumed lead keeps the old one). The reliable link is the teammate's `<transcript dir>/<session id>/subagents/agent-<agent_id>.meta.json` (`name`, `teamName`, `taskKind: "in_process_teammate"`); `leadSessionId` is only the fallback, and an unknown team never removes anyone. The same meta files let the sweep re-seed, on standby, teammates of a live session that the bay is missing (hub restart) while their team lists them and their transcript moved within the standby window. Subagents keep done plus the 60 s fade.
- **Decision attribution.** A subagent's `request_decision` runs through the parent's MCP server, so the POST names only the parent session. The `PreToolUse` hook for `mcp__mission-control__request_decision` fires first with `agent_id` and `tool_input.question`; the hub keeps it for 30 s and stamps the matching decision with `agentId`/`agentRole`, and the member shows `waiting_decision` until it is answered. Attribution in the request body is ignored.
- **Nested `claude` processes** (a `claude -p` from a Bash tool, a split-pane teammate) get a new `session_id` and nothing in their env points at the parent. The process tree does: child claude, shell, parent claude. The `SessionStart` hook sends `X-Claude-Ppid`; the hub walks `ps` upward from it (8 levels, cached) and, if an ancestor is another live session's `claudePid`, sets `parentSessionId` on the child and adds a `child_session` crew member to the parent that mirrors the child's status. While the parent is live, every log entry the child writes (its `session_start` included) carries `agentId` = the child's session id and `agentRole` = `claude`. The child keeps its own `Session` and its decisions keep `sessionId` = the child; the UI files both under the parent. If the MCP server reports before any hook, its `ancestorPids` are used the same way, skipping the first entry (the session's own `claude`, which after `/clear` can still belong to a live record under the old id).

### OTLP

With `CLAUDE_CODE_ENABLE_TELEMETRY=1` and the OTLP exporters pointed at the hub, Claude Code emits log records for `user_prompt`, `assistant_response`, `tool_result`, `tool_decision`, `api_request` and `api_error`, plus token and cost metrics. All carry `session.id`, which is the same value as the hook `session_id`, so the hub uses it to paint activity onto the right station and fill the stats panel. Cache read and cache creation tokens count toward the station's input token figure, so it tracks what the API billed for context, not just fresh input.

Limits: it is opt-in and read once at startup, so it needs a relaunch. Logs flush every 5 seconds by default. Prompt and tool text are redacted unless `OTEL_LOG_USER_PROMPTS=1` and `OTEL_LOG_TOOL_DETAILS=1` are set. It is ambient colour, not a control channel.

### `request_decision` (primary)

The MCP server exposes one tool: `request_decision(question, options[], context, urgency)`. The CLAUDE.md snippet tells Claude to call it whenever it would otherwise ask the user a question or pick between materially different paths. The tool posts a `DecisionRequest` to the hub and long-polls `GET /api/decisions/:id/wait` in 25 second slices until the operator answers, then returns the chosen label and any note as the tool result. The operator can always type their own reply instead of picking an option; the result then reads `DECISION (typed by the user): <text>` so Claude knows it is free text (`allow_free_text` is accepted but ignored). This is the only channel that both surfaces a decision with structured context and routes the answer back.

### Correlating MCP calls to sessions

An MCP server is not told which session it belongs to by any documented mechanism. Verified on Claude Code 2.1.280, the server process does receive `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR` and `CLAUDE_CODE_MESSAGING_SOCKET` in its environment. That variable is undocumented, so the server treats it as the primary hint and also sends fallbacks:

1. `ancestorPids`: the server walks its parent chain. Claude Code spawns stdio servers as direct children, but the configured command is often a wrapper (`npx` becomes `npm exec` then `node`), so the hub compares every ancestor against the `claudePid` values that hooks reported.
2. `cwd`: if exactly one live session has that project directory, use it.
3. Otherwise the hub creates a provisional session keyed `pid:<ppid>` so the decision is still shown, and merges it into the real session as soon as a hook reports the matching pid.

## Answer routing

The brief asked for an evaluation of three mechanisms. Two more turned up in the current docs and are included.

| Mechanism | Can reach a live interactive session? | Verdict |
| --- | --- | --- |
| 1. Blocking MCP tool returning the operator's choice | Yes. The session is waiting on the tool result. | Primary. Simple, structured, no terminal involvement, works for any decision the model chooses to raise. |
| 2. Agent SDK or `claude -p --resume <id>` owning the loop | No. Since 2.1.248 Claude Code refuses to start a second process on a conversation that is open in another terminal. Resume continues a stopped session under the same id, `--fork-session` branches it. | Only viable if the SDK owns every session from the start, which changes how the user works. Rejected. |
| 3. tmux or PTY wrapper injecting keystrokes | Yes, but by screen-scraping the prompt and typing into it. | Fragile against UI changes and impossible to correlate reliably. Kept as a documented escape hatch, not built. |
| 4. Channels (research preview) | Yes. A channel MCP server can push `<channel>` events into the running session and, with the `claude/channel/permission` capability, receive every permission prompt and answer allow or deny while the terminal dialog stays open in parallel. | Best long-term fit for permission prompts and free-text nudges. Not primary in v1: it needs each session launched with `--dangerously-load-development-channels server:mission-control`, Anthropic auth, and the contract may change. |
| 5. Cross-session inbox socket (built for prose cards) | Partly. Every session binds `/tmp/cc-socks/<pid>.sock`; a delivered message starts a new turn if the session is idle. It cannot answer a permission prompt, and the line format is not documented beyond an optional auth line. | Built for prose cards only (see `apps/hub/src/socket.ts`): an answer typed on a prose card is delivered as a new, clearly wrapped cross-session message. Opt-out with `AMC_SOCKET_REPLY=off`. |

### Decision

`request_decision` is the primary channel. Questions Claude leaves in prose at the end of a turn are caught by the `Stop` hook: the hub blocks the stop once with a reason asking Claude to use `AskUserQuestion` (so the gate can route it), and if Claude stops again with the questions still there it posts a read-only `prose` card that clears when the user next prompts that session. Claude Code's own ask-the-human tools, `AskUserQuestion` and `ExitPlanMode`, raise a `PermissionRequest` like any tool, so the same gate routes them: the hub shows them as `ask` (all questions, per-question answers) and `plan` (plan text, Approve / Keep planning) decisions and answers the hook with `allow` + `updatedInput.answers` for questions, `allow` or `deny` + message for plans. Permission prompts are covered by an opt-in gate hook: a `PermissionRequest` hook (matcher on tool name) posts to `/api/hooks/gate`, the hub shows an allow/deny card, and the hook returns `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny"}}}`. If the operator has not answered before the hub's gate timeout (`AMC_GATE_TIMEOUT_MS`, 540 s, under the 600 s hook default), the hook returns no decision and the terminal prompt appears as normal. A `PreToolUse` gate was considered and rejected: it fires for every tool call including auto-allowed ones, and a `PreToolUse` hook that times out skips the tool call instead of prompting.

### Trade-offs, honestly

- **Timeouts.** `MCP_TOOL_TIMEOUT` defaults to about 28 hours, so it does not need raising. The real limits are the idle timeout (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, 30 minutes for stdio: a call with no response and no progress notification is aborted) and automatic backgrounding (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, 2 minutes: a main-conversation call still running is moved to a background task and Claude keeps working). The runbook sets a per-server `timeout` of 24 hours in `.mcp.json`, which also floors the idle window, and sets the auto-background threshold to 0 in the project's settings so Claude really does wait. The MCP server sends a progress notification on every 25 second poll (when Claude Code supplies a progress token) as belt and braces.
- **Claude idles while waiting.** That is the point for a decision, but it means a forgotten question burns a session slot. Escalation tiers exist to make that visible. If someone prefers Claude to carry on with other work, leave auto-backgrounding on and the answer arrives as a task notification; the CLAUDE.md snippet tells Claude not to act on the decision until it does.
- **Cancellation.** If the operator interrupts Claude, Claude Code cancels the tool call. The MCP server observes the cancellation (or the transport closing) and posts `POST /api/decisions/:id/cancel`, so the card disappears instead of going stale. A decision answered after cancellation is logged as `expired`.
- **Gate ceiling.** Hook `timeout` is in seconds and defaults to 600 for command hooks, not 60 as the brief assumed. The hub's gate wait is 540 s and the hook's `curl -m` is 590 s, so the hub always answers before the hook is cancelled. `SessionEnd` hooks have a 1.5 second budget, so that hook is fire-and-forget.
- **PTY escape hatch.** For sessions that cannot load the MCP server, a tmux wrapper that watches the pane for the permission prompt and sends `y` or `n` is the fallback. It is documented in the runbook's troubleshooting section as the last resort and is not built.

## Escalation, personas, mission log

Escalation is computed client-side from `blockedSince` (sessions) or `createdAt` (decisions) using the tiers in `@amc/shared`: calm from 0, amber at 2 minutes, red at 5, alarm at 10. The hub never times the UI; it only stamps when the blocking state began.

Personas are generated deterministically from the session id by the hub on `SessionStart` and stored in SQLite: callsign, sprite seed, phosphor colour, voice and tagline. Because a resumed session keeps its session id (only `--fork-session` mints a new one), the persona survives `claude --resume` and `/resume`. Status lines and log text are phrased by the hub in the persona's voice before they are sent to the UI.

Each station also has an activity history: one line per tool call, in the persona's voice plus the specific target after " · " (a file relative to the session's cwd, a command's description or first 60 characters with anything secret-looking masked, a search pattern, a URL host and path, an MCP tool name), and a "✗ ... failed" line when a call fails. The hub keeps the last 80 lines per session in memory and SQLite and serves them in the snapshot as `recentActivity`, so history survives a page reload or hub restart.

The mission log records every session start and end, decision requested, answered or expired, permission prompt, idle and stop event. The UI shows the most recent 200 on load and streams the rest over the WebSocket. Decisions are never deleted, so the log doubles as the history of every call made.

## Security

The hub binds `127.0.0.1` only and has no authentication. Anything on the machine that can reach loopback can post hook events or answer decisions, which is the same trust level as the shell that runs Claude Code. Do not put it behind a tunnel. Hook payloads and OTLP records can contain prompt text and file contents when the verbose flags are on; they stay in the SQLite file under the user's home directory.

Loopback does not keep out web pages open in the user's browser, so `apps/hub/src/guard.ts` checks every request before any route, the `/ws` upgrade or static files run:

- **Host** must be `127.0.0.1`, `localhost` or `[::1]` with the hub's port (plus `AMC_HOST`, and the Vite dev host `:5173`, whose proxy forwards the browser's Host). Anything else gets 421, which stops DNS rebinding.
- **Origin**, when present, must be the hub's own origin on one of those names or the Vite dev origin; otherwise 403, on every method and on the WebSocket upgrade (browsers apply no CORS to WebSockets). Local callers (curl hooks, the MCP server, the OTLP exporter) send no Origin.
- **Content-Type** must be `application/json` (parameters allowed) on every POST, else 415. That forces a CORS preflight on any cross-site write, which the hub never grants to foreign origins. Every legitimate caller already sends it; Claude Code's OTLP `http/json` exporter sends `application/json` (captured from 2.1.280, exporter 0.208.0).

The optional ElevenLabs key (`apps/hub/src/tts.ts`) comes from the hub's environment or `<data dir>/secrets.env`, which is refused unless only the owner can read it. It is used only as the `xi-api-key` header on requests to ElevenLabs; the UI sees `configured: true|false`, and errors and logs carry HTTP statuses, never the key or upstream bodies. `/api/voice/speak` sits behind the same guard, accepts at most 200 characters, and the UI only sends announcement lines from `packages/shared/src/phrases.ts` (callsign, counts, tool and role names), never card content. A daily character cap bounds what a runaway caller could spend.

Rejections are plain text, so a gate hook's `curl` never prints something Claude Code could read as an answer, and are logged once per reason and origin/host as `blocked  <reason>  <origin or host>`. See `SECURITY.md` for the threat model.

## Verified against docs on 2026-09-23

Sources: [hooks reference](https://code.claude.com/docs/en/hooks), [hooks guide](https://code.claude.com/docs/en/hooks-guide), [MCP](https://code.claude.com/docs/en/mcp), [environment variables](https://code.claude.com/docs/en/env-vars), [settings](https://code.claude.com/docs/en/settings), [monitoring](https://code.claude.com/docs/en/monitoring-usage), [CLI reference](https://code.claude.com/docs/en/cli-reference), [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [errors](https://code.claude.com/docs/en/errors), [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging), [channels](https://code.claude.com/docs/en/channels), [channels reference](https://code.claude.com/docs/en/channels-reference). The `docs.claude.com/en/docs/claude-code/*` URLs in the brief now redirect to `code.claude.com/docs/en/*`. Local checks were run against Claude Code 2.1.280.

Confirmed:

- Hook events include `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Notification`, `Stop`, `PreToolUse`, `PostToolUse`, and also `PermissionRequest`, `PermissionDenied`, `Elicitation`, `SubagentStop`, `PreCompact` and more.
- Common stdin fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`. `Notification` adds `notification_type` (`permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_*`, `agent_needs_input`, `agent_completed`) and `message`. A `matcher` on `Notification` filters on `notification_type`.
- `PreToolUse` output: `hookSpecificOutput.permissionDecision` is `allow`, `deny` or `ask`; `permissionDecisionReason` is required for deny and ask.
- Hook commands receive `CLAUDE_PROJECT_DIR` and `CLAUDE_PID` (2.1.214+). Verified locally: the hook shell's `$PPID` is the `claude` pid with no intermediate shell.
- `MCP_TIMEOUT` (startup) defaults to 30000 ms. `MCP_TOOL_TIMEOUT` is in ms. `.mcp.json` shape is `{"mcpServers":{"name":{"command","args","env"}}}` with `${VAR}` expansion; `type` defaults to `stdio`. `claude mcp add --scope local|project|user`, default `local`.
- OTLP: `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL` (accepts `http/json`), `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_METRIC_EXPORT_INTERVAL` (default 60000), `OTEL_LOGS_EXPORT_INTERVAL` (default 5000), `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS` all exist. Events are named `claude_code.user_prompt`, `claude_code.tool_result`, `claude_code.api_request`, `claude_code.api_error`, `claude_code.tool_decision` and carry `session.id` (attribute `event.name` holds the bare name). `claude_code.assistant_response` also exists.
- `claude -p --resume` cannot inject into a live interactive session; since 2.1.248 it is refused with "This session is running in another terminal".

Contradicted or missing from the brief:

- Hook `timeout` default is 600 seconds for command hooks, not 60. Only `UserPromptSubmit` (30 s) and `SessionEnd` (1.5 s budget) are shorter.
- `MCP_TOOL_TIMEOUT` defaults to 100000000 ms, so a blocking tool does not need it raised. What does bite are the 30 minute idle timeout and 2 minute auto-backgrounding described above.
- A `PreToolUse` hook that times out does not fall back to the terminal prompt; the tool call is skipped. `PermissionRequest` is the right event for the gate.
- `CLAUDE_CODE_SESSION_ID` is present in the MCP server's environment on 2.1.280 but is not documented. Treated as a hint with the PID chain and cwd as fallbacks.
- `OTEL_*` variables are stripped from every subprocess Claude Code spawns, including hooks and MCP servers. Irrelevant to the design but worth knowing.
- Channels and the cross-session inbox socket did not exist when the brief was written and are the most promising future routes for permission prompts and nudges.
