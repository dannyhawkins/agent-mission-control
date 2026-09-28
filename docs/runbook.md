# Runbook: wire an existing project in under five minutes

Prerequisites: the `amc` binary on your `PATH` (`brew install dannyhawkins/tap/amc`, a release tarball, or a source build; see [install.md](install.md)), `curl`, Claude Code 2.1.280 or later (`claude --version`). Replace `/ABS/PATH/amc` below with the binary's real path; `amc wire --dry-run` prints everything already substituted. From a checkout without building, `bun /ABS/PATH/agent-mission-control/apps/cli/src/main.ts` stands in for `amc` and the `task` targets below still work.

## 1. Start the hub

```sh
amc start           # the hub and its embedded UI on http://127.0.0.1:4242 (--port to change)
# from a checkout: task install && task start
```

`amc doctor` checks everything below in one go: hub reachable and its version, the global and project wiring (and whether it points at this `amc` or at an old checkout path), Claude Code's version, telemetry and socket settings, and which ElevenLabs key source the running hub uses. It exits 1 when something is broken.

For development use `task dev` instead (hub with `--watch` plus Vite on :5173, which proxies `/api`, `/ws` and `/v1` to the hub). `task sim` fills the floor with fake sessions.

Check it is up:

```sh
curl -s http://127.0.0.1:4242/api/health     # {"ok":true,"version":"0.1.0",...}
```

Hub environment variables, all optional (`amc start` honours every one, and `<data dir>/secrets.env`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `AMC_PORT` | `4242` | Listen port |
| `AMC_HOST` | `127.0.0.1` | Bind address. Leave it on loopback. |
| `AMC_DATA_DIR` | `~/.agent-mission-control` | Where `amc.db` lives |
| `AMC_GATE_TIMEOUT_MS` | `540000` | How long the gate waits for an answer before letting the terminal prompt through (9 min, under the 600 s hook default) |
| `AMC_OFFLINE_AFTER_MS` | 30 min | Silence before a station is marked offline |
| `AMC_CREW_STALE_MS` | 10 min | Silence before a working subagent or teammate with no stop event is marked done |
| `AMC_TEAMMATE_STANDBY_MS` | 4 h | Silence before a teammate on standby (between tasks) leaves the crew bay |
| `AMC_CLAUDE_HOME` | `~/.claude` | Where agent team rosters are read from (`teams/<team>/config.json`, read only) |
| `AMC_DROP_OFFLINE_AFTER_MS` | 24 h | Offline time before a station is removed from the floor |
| `AMC_NUDGE` | on | `off` stops the Stop hook from blocking a turn that ends with questions in prose (see "Questions left in prose"); the read-only card still appears |
| `AMC_SOCKET_REPLY` | on | `off` stops the hub delivering answers to prose cards into the session over its messaging socket (see "Questions left in prose"). Overrides `socketReply` in `config.json` |
| `AMC_IGNORE_CWD` | `~/.claude-mem` | Comma-separated path prefixes (`~` expanded) whose sessions the hub ignores completely. Overrides `ignoreCwd` in `config.json` (below); set it to an empty string to ignore nothing |
| `AMC_LOG` | `info` | `quiet` silences; `info` prints one line per hook event, gate exchange, decision change, status post, session online/merged/offline and OTLP batch; `debug` adds pid and socket headers, payload keys and OTLP event or metric names. `AMC_DEBUG=1` is an alias for `debug`, ignored when `AMC_LOG` is set |
| `ELEVENLABS_API_KEY` | unset | Enables the optional ElevenLabs voice provider. Prefer `secrets.env` (below); the environment wins when both are set |
| `AMC_ELEVENLABS_URL` | `https://api.elevenlabs.io` | ElevenLabs API base URL |
| `AMC_ELEVENLABS_MODEL` | `eleven_flash_v2_5` | Model id for text to speech |
| `AMC_TTS_DAILY_CHARS` | `20000` | Characters per local day sent to ElevenLabs (cache misses only); past it lines fall back to the browser voice |
| `AMC_TTS_PREWARM` | on | `off` stops background rendering of a session's six core lines after its first spoken line |

The MCP server reads `AMC_HUB_URL` (default `http://127.0.0.1:4242`).

**Optional: ElevenLabs voice.** Put the key in `~/.agent-mission-control/secrets.env` (`KEY=value` lines; `#` comments, `export` and quotes are fine; only `ELEVENLABS_API_KEY` is read) and `chmod 600` it. The hub reads the file at start and again on every `GET /api/voice/status`, which the UI calls when the voice popover opens, so a new or rotated key needs no restart; it refuses the file while its mode lets group or others read it and logs one line saying so. Then pick ElevenLabs under the VOICE caret. The key stays in the hub: `/api/voice/status` reports only `configured` and `keySource` (`env`, `secrets.env` or null), errors carry HTTP statuses, and the log never prints it. Audio is cached in `<data dir>/voice-cache/` keyed by model, voice, settings and text (50 MB cap, least recently played evicted). `POST /api/voice/speak` takes `{text, sessionId}` (or `{text, persona: {voice, spriteSeed}}`) and returns `audio/mpeg`, or JSON `{error, reason}` with 409 (`not_configured`, `cap_reached`), 503 (`upstream`, `timeout`, `no_voice`) or 400, and the UI speaks that line with the browser voice instead. Each live session (engaged, not offline, with its own station) gets its own voice: the best trait match not used by another live session, else the least used, stored in the `voice_assign` table so it survives resume and restarts. `GET /api/voice/status` lists them as `assignments: [{sessionId, voiceName}]`, and `POST /api/voice/assign {"sessionId": "...", "next": true}` re-rolls one to its next best unused voice. Per-persona `voice_settings` offsets (speed +/-0.08, stability and style +/-0.1) come from the sprite seed and are part of the cache key. The first line a session speaks triggers a background render of its six core lines only. Only announcement lines from `packages/shared/src/phrases.ts` are sent, never card content. To check it without the UI: `curl -s http://127.0.0.1:4242/api/voice/status`.

**Ignored sessions.** Global wiring reaches every `claude` on the machine, including tools' own background sessions (claude-mem's observers run in `~/.claude-mem/observer-sessions`). A session whose `cwd` starts with an ignored prefix gets no station, no log lines, no events and no crew slot; its gate calls return `{}` at once, so Claude Code prompts in the terminal as usual, and `request_decision` is refused (409 `{"ignored": true}`), which the MCP server turns into "ask in chat". Once a session id is known to be ignored, later hooks and OTLP without a cwd are dropped too. On start the hub purges stored sessions, log rows and decisions under an ignored prefix and logs the counts. To change the list without env vars, edit `~/.agent-mission-control/config.json` and restart the hub:

```json
{ "ignoreCwd": ["~/.claude-mem", "~/scratch/bots"] }
```

## Everyday setup: global wiring

With the hub running (`amc start`), one command wires every project; sections 2 to 6 are the per-project alternative.

### Global wiring

```sh
amc wire --global                          # hooks + env into ~/.claude/settings.json, MCP server at user scope
amc wire --global --gate                   # plus the gate for tool permissions, questions and plans
amc wire --global --gate-questions-only    # plus the gate for AskUserQuestion and plan approval only
amc wire --global --snippet                # also append the marked snippet to ~/.claude/CLAUDE.md
amc wire --global --telemetry              # also send OTLP telemetry to the hub (section 5)
amc wire --global --dry-run                # print it instead of writing
amc unwire --global                        # remove exactly what the above added
```

From a checkout, `task wire:global -- --gate` and `task unwire:global` do the same.

The MCP server is registered as `{"command": "/ABS/PATH/amc", "args": ["mcp"]}`: the path of the `amc` that ran `wire`, so move the binary before wiring, not after (or rewire). From a checkout it is `bun /ABS/PATH/agent-mission-control/apps/cli/src/main.ts mcp`.

**Migrating a checkout install.** Wiring written before `amc` existed runs `bun <checkout>/packages/mcp-server/src/index.ts`. Every `amc wire` (global or per project) looks for `mission-control` entries that run `bun` on that file, or on a checkout's `apps/cli/src/main.ts`, in user scope, in every project's local scope in `~/.claude.json` and in those projects' `.mcp.json`, rewrites them to the running `amc` (keeping their `env` and re-applying the 24 h timeout) and prints each one it changed. Entries that point anywhere else are left alone. Running it again changes nothing. A local-scope entry the `claude` CLI files under a different project key (a subdirectory of a git repo is keyed by the repo root) is reported, not claimed; `amc doctor` lists any repo-path entries that remain.

Hooks in `~/.claude/settings.json` apply to every project and run in addition to any project hooks (Claude Code merges hooks across settings files; it does not replace them). The MCP server is added with `claude mcp add-json --scope user`, which keeps the 24 h `timeout` (verified on 2.1.280). No `CLAUDE.md` is written unless you pass `--snippet`; without it Claude still sees `request_decision` and its description, just without the standing instruction to prefer it over asking in the terminal. Both directions write `settings.json.amc-backup-YYYYMMDD-HHMMSS` next to the file before changing it and print the path. `--home <dir>` (or `AMC_CLAUDE_HOME`) points everything at another Claude config dir, and the `claude` CLI is then run with `CLAUDE_CONFIG_DIR` set to it; that is how the tests stay away from your real files. Running the `claude` CLI can itself normalise `settings.json` (it rewrote `"model": "opus"` to `"opus[1m]"` in a test), which the backup covers.

Global wiring covers every project, this repo included; hooks never fail Claude on the hub's account, so that is harmless.

**Noise sessions.** Global wiring also sees `claude` processes that start and exit without doing anything (a quick `claude --version`-style launch, tools probing the CLI). A session only shows once it is *engaged*: a user prompt, a main-thread tool call, a crew member or a decision. Until then it has `engaged: false`, the UI hides it, and its log lines are held (up to 20) and written in order when it engages. A session that ends, or goes silent, without ever engaging is deleted with its held lines and its callsign is freed. Sessions stored before this change count as engaged.

**Double wiring.** A project that is also wired per project (section 2) sends every event twice. `--global` lists the projects it can find (every project in `~/.claude.json` with a local-scope `mission-control` server, a `.mcp.json` entry or our hooks in `.claude/settings*.json`) with an `amc unwire <dir>` line for each. The hub copes either way: an identical delivery (same session, event and body) within 2 s is dropped and logged as `(duplicate, dropped)`, and two identical gate calls in flight share one card and one answer.

## 2. Wire your project

```sh
amc wire ~/Code/some-project --dry-run    # print the hooks and env, the .mcp.json entry and the CLAUDE.md snippet, paths filled in
amc wire ~/Code/some-project              # merge hooks + env into .claude/settings.json, server into .mcp.json, append CLAUDE.md
amc wire ~/Code/some-project --local      # same, but only into files git never sees (see "Keep it out of git")
amc wire ~/Code/some-project --gate       # also add the gate: tool permissions, AskUserQuestion, plan approval
amc wire ~/Code/some-project --gate-questions-only        # gate only AskUserQuestion + plan approval
amc wire ~/Code/some-project --gate --gate-matcher 'Bash|Write'   # narrower gate
amc wire ~/Code/some-project --port 4343  # hub on another port
amc wire ~/Code/some-project --telemetry  # also send OTLP telemetry to the hub (section 5)
amc unwire ~/Code/some-project            # take it all out again (see "Unwiring")
```

The directory defaults to the current one. From a checkout, `task wire DIR=...` prints (the old `bun scripts/wire.ts` behaviour) and `task wire DIR=... -- --write --local` applies; `scripts/wire.ts` forwards its old flags to `amc wire`. It refuses to wire the mission control repo itself unless you pass `--force`. Wiring covers sections 3, 4 and 6 (the `CLAUDE.md` append is skipped if the snippet is already there), and section 5 with `--telemetry`. When one of the files it writes is tracked in git, it prints a warning naming it and the `--local` command to use instead.

### Keep it out of git: `--local`

`.claude/settings.json`, `.mcp.json` and `CLAUDE.md` are usually committed, so the default mode puts your hub's absolute paths in front of the whole team. `--local` writes the same things to personal locations instead:

| What | Shared (default) | `--local` |
| --- | --- | --- |
| Hooks + env | `.claude/settings.json` | `.claude/settings.local.json` |
| MCP server | `.mcp.json` | local scope: `claude mcp add-json --scope local mission-control '{...}'`, stored in `~/.claude.json` under the project path |
| Snippet | `CLAUDE.md` | `CLAUDE.local.md` |

MCP servers cannot live in `settings.local.json`; local scope is Claude Code's per-user, per-project place for them, and `add-json` (unlike `claude mcp add`) keeps the 24 h `timeout`. The script runs the `claude` CLI from the project directory so the entry is keyed to it. It also adds `/CLAUDE.local.md` and `/.claude/settings.local.json` to `.git/info/exclude` (inside a marked block) unless they are already ignored, so `git status` stays clean. Nothing tracked is touched.

### Unwiring

```sh
amc unwire ~/Code/some-project
# from a checkout: task unwire DIR=~/Code/some-project
```

Removes only what `amc wire` adds, from both modes at once, and prints each thing it removed:

- hook commands containing `/api/hooks/` (any port) from `.claude/settings.json` and `.claude/settings.local.json`; your own hooks in the same events stay;
- `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, only when its value is `"0"`;
- the `mission-control` server from `.mcp.json` and from local scope;
- the snippet between `<!-- mission-control:start -->` and `<!-- mission-control:end -->` in `CLAUDE.md` / `CLAUDE.local.md`, or an older unmarked copy (its heading through the next `#`/`##` heading);
- our block in `.git/info/exclude`.

Files left as `{}` or blank are deleted, and so is `.claude/` if that leaves it empty. When a tracked JSON file ends up equal to its committed version, the committed bytes are restored, so formatting an older `--write` changed comes back too. Running it twice is a no-op. Restart the project's Claude sessions afterwards.

## 3. Add the MCP server

Either command form (project scope writes `.mcp.json`, which you can commit; `--scope local` keeps it private to you in this project; `--scope user` puts it in every project):

```sh
cd ~/Code/some-project
claude mcp add-json --scope project mission-control '{"type":"stdio","command":"/ABS/PATH/amc","args":["mcp"],"env":{"AMC_HUB_URL":"http://127.0.0.1:4242"},"timeout":86400000}'
```

Or the `.mcp.json` snippet, which is what `amc wire` writes. The `timeout` (ms) is the per-server tool timeout; it also floors the idle timeout so a decision can wait all day:

```json
{
  "mcpServers": {
    "mission-control": {
      "type": "stdio",
      "command": "/ABS/PATH/amc",
      "args": ["mcp"],
      "env": { "AMC_HUB_URL": "http://127.0.0.1:4242" },
      "timeout": 86400000
    }
  }
}
```

`claude mcp add` has no flag for `timeout`; `claude mcp add-json` keeps every field you pass, which is why the example uses it.

## 4. Add the hooks

Every hook is the same `curl` one-liner with a different event name. The three headers give the hub what the JSON body does not: the `claude` process id (`CLAUDE_PID`, with `$PPID` as the fallback since both are the `claude` pid), the session id, and the session's inbox socket path for later use. `SessionStart` also sends `X-Claude-Ppid`, the parent of the `claude` process, which lets the hub notice a `claude` started from inside another session (see "Crew" in `architecture.md`); it costs one `ps` per session start, so only that hook does it. `amc wire` writes fourteen events; the block below is abbreviated to the pattern. Put it in `~/Code/some-project/.claude/settings.json` (or `.claude/settings.local.json` to keep it out of git):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{
      "type": "command",
      "timeout": 5,
      "command": "curl -sS -m 3 -X POST -H \"X-Claude-Pid: ${CLAUDE_PID:-$PPID}\" -H \"X-Claude-Session: $CLAUDE_CODE_SESSION_ID\" -H \"X-Claude-Socket: $CLAUDE_CODE_MESSAGING_SOCKET\" -H 'Content-Type: application/json' -H \"X-Claude-Ppid: $(ps -o ppid= -p ${CLAUDE_PID:-$PPID} | tr -d ' ')\" --data-binary @- http://127.0.0.1:4242/api/hooks/SessionStart >/dev/null 2>&1 || true"
    }] }],
    "SessionEnd": [{ "hooks": [{
      "type": "command",
      "timeout": 2,
      "command": "curl -sS -m 1 -X POST -H \"X-Claude-Pid: ${CLAUDE_PID:-$PPID}\" -H \"X-Claude-Session: $CLAUDE_CODE_SESSION_ID\" -H \"X-Claude-Socket: $CLAUDE_CODE_MESSAGING_SOCKET\" -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4242/api/hooks/SessionEnd >/dev/null 2>&1 || true"
    }] }]
  },
  "env": {
    "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS": "0"
  }
}
```

Repeat the `SessionStart` entry without the `X-Claude-Ppid` header, changing only the last path segment, for `UserPromptSubmit`, `Notification`, `PermissionRequest`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCreated` and `TaskCompleted`. The last five feed the crew bay: hooks fired inside a subagent or in-process teammate carry `agent_id` and `agent_type`, and the hub files them under that crew member instead of the main thread.

Notes:

- `SessionEnd` uses `-m 1` and `timeout: 2` because those hooks share a 1.5 second budget by default.
- Hooks never block Claude on the hub's account: `-m 3` plus `|| true` means a dead hub costs at most three seconds per event, and the hook `timeout` of 5 is a second ceiling.
- If you already have hooks for an event, append ours to that event's array; matchers are optional and we want every event. `amc wire` does this merge for both `hooks` and `env` and keeps your existing keys.
- The `env` key stops Claude Code moving a `request_decision` call that has run for two minutes into a background task and carrying on without the answer (see section 5).
- Claude Code also supports `"type": "http"` hooks that POST the same JSON to a URL with no shell involved. They cannot send the headers above, so keep at least `SessionStart` as a command hook if you switch.

`Stop` is different because Claude Code reads its output. It posts to `/api/hooks/stop` (lower case), keeps stdout, and swallows every failure so a dead hub just lets Claude stop:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{
      "type": "command",
      "timeout": 5,
      "command": "curl -sSf -m 3 -X POST -H \"X-Claude-Pid: ${CLAUDE_PID:-$PPID}\" -H \"X-Claude-Session: $CLAUDE_CODE_SESSION_ID\" -H \"X-Claude-Socket: $CLAUDE_CODE_MESSAGING_SOCKET\" -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4242/api/hooks/stop 2>/dev/null || true"
    }] }]
  }
}
```

### Questions left in prose

Claude sometimes ends a turn with questions written as text ("Two things still need you: 1. ...? 2. ...?"). No tool call means nothing for the gate to catch. The Stop hook handles it in two steps:

1. **Nudge.** The hub pulls the questions out of `last_assistant_message` (sentences and list items ending in `?`, ignoring code blocks, inline code and quoted text, at most four). If there are any and `stop_hook_active` is false, it replies `{"decision":"block","reason":"Before you stop: your reply leaves questions for the user. Ask them with the AskUserQuestion tool instead ..."}` once. Claude usually re-asks with `AskUserQuestion`, which the gate (section 4) puts on the board. A nudged stop is not logged as a stop.
2. **Prose card.** If Claude stops again with questions still there (`stop_hook_active` true), or `AMC_NUDGE=off`, the hub posts a read-only `source: "prose"` card: the questions plus the last ~1200 characters of the reply, no options, `answerable: false`. The station waits and escalates like any decision. Answer in the terminal; the next prompt or tool call from that session's main thread clears the card ("Answered in the terminal."). Dismiss in the UI sends `POST /api/decisions/:id/cancel` with `{"dismiss": true}` and is logged as "Dismissed.".

**Answering a prose card from the board.** When the hub knows the session's messaging socket (hooks send `X-Claude-Socket`, and `SessionStart`/`Stop` send `X-Claude-Token: $CLAUDE_CODE_MESSAGING_TOKEN`) and socket replies are on (`AMC_SOCKET_REPLY`, or `"socketReply": false` in `config.json` to turn it off), the card is `answerable: true` and takes a typed reply. The hub writes it to the socket as a new message, as plain text headed "The user answered your open questions in Mission Control:" (Claude Code adds its own cross-session envelope around it), so Claude knows where it came from, logs "Answer delivered to the session." and marks the card answered. If delivery fails the answer call returns 502, the card stays up with `answerable: false`, and you reply in the terminal. This socket protocol is undocumented (observed on 2.1.280), and a session running with `bypassPermissions` may hold such messages for approval rather than acting on them. The token is kept only in the hub's database, never shown in the UI or logs.

**Messaging a session.** `POST /api/sessions/:id/message` with `{"text": "..."}` (up to 4000 characters, one per 2 s per session) sends a free message to any session whose messaging socket the hub knows (`Session.canMessage`). It is delivered like a prose answer, as plain text headed "Message from the user via Mission Control:", and logged as "Operator: ...". If the session is idle it starts a new turn; if it is mid-turn, Claude Code queues it and folds it into the current turn as soon as the running tool call finishes. Errors: 404 unknown or ignored session, 409 `no_socket`, 429 `rate_limited`, 502 `delivery_failed`.

The hub answers the Stop hook in a few milliseconds. Ignored sessions and subagents always get `{}`.

### What a card shows

Every card carries `recentContext` so you can decide without the terminal: the user's last typed prompt in that session (~600 chars) and Claude's text just before the question or tool call (~1500 chars; for prose cards, the final reply). The hub reads only the last 256 KB of the session transcript and skips tool results, injected peer and task messages and command output; if anything goes wrong the context is simply left out. Gated `Edit`, `MultiEdit`, `NotebookEdit` and `Write` calls also carry `changePreview`: a compact diff (or the head of the new file, marked "new file" or "overwrite"), capped at 120 lines. For a subagent's card the prompt still comes from the session, but Claude's text comes from the subagent's own transcript (`agent_transcript_path` from its hooks, else `<session dir>/<session id>/subagents/agent-<agent id>.jsonl`).

### Optional: route permission prompts through the UI (the gate)

`--gate` adds a second `PermissionRequest` entry with a matcher (default `Bash|Write|Edit|MultiEdit|NotebookEdit|AskUserQuestion|ExitPlanMode`; `--gate-questions-only` uses just `AskUserQuestion|ExitPlanMode`, `--gate-matcher` sets it exactly). It fires only when Claude Code is about to show a permission prompt, posts the prompt to the hub, and the hub shows an Allow/Deny card on the station while the terminal shows "Waiting for Mission Control". If nobody answers within `AMC_GATE_TIMEOUT_MS` the hub replies `{}`, the hook returns no decision, and the normal terminal prompt appears.

```json
{
  "hooks": {
    "PermissionRequest": [{
      "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit",
      "hooks": [{
        "type": "command",
        "timeout": 600,
        "statusMessage": "Waiting for Mission Control",
        "command": "curl -sS -m 590 -X POST -H \"X-Claude-Pid: ${CLAUDE_PID:-$PPID}\" -H \"X-Claude-Session: $CLAUDE_CODE_SESSION_ID\" -H \"X-Claude-Socket: $CLAUDE_CODE_MESSAGING_SOCKET\" -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4242/api/hooks/gate"
      }]
    }]
  }
}
```

The hub replies `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny","message":"..."}}}`.

Two built-in tools are questions for you rather than permissions, and the gate turns them into richer cards:

- **`AskUserQuestion`** (Claude's multiple-choice questions, 1 to 4 per call) becomes a `source: "ask"` decision carrying every question. Answer each one with a label, several labels for multi-select, or your own text. The hub replies `allow` with `updatedInput` set to the original input plus `answers: {"<question text>": "<label or text>" | ["label", ...]}`, which Claude reads as your answers. Every question must be answered; an older UI that only sends `answer` fills the first question.
- **`ExitPlanMode`** (plan approval) becomes a `source: "plan"` decision showing the plan. **Approve** replies `allow` with the original input echoed as `updatedInput` (without it the approval does not take and the terminal menu stays up); edits then prompt as usual. **Approve + auto-accept edits** also sends `updatedPermissions: [{"type":"setMode","mode":"acceptEdits","destination":"session"}]`. **Keep planning** replies `deny` with "The user reviewed your plan and wants changes before you start: <your note>" (or "The user reviewed your plan and wants you to keep planning before making changes."); Claude stays in plan mode, revises and asks again. Every deny message (plans and tool permissions, "The user declined this Bash call: <note>") is phrased as the user's own feedback and never mentions the hub, because Claude sees it raw and an unframed message read as a possible prompt injection in testing.

The terminal shows its own prompt at the same moment (for these two and for gated tool permissions), and whichever side answers first wins; the hook is not cancelled when the terminal wins. The hub therefore retires a stale card (logged as "Answered in the terminal.") when that call's `PostToolUse` or `PostToolUseFailure` arrives (matched by `tool_use_id`, remembered from the `PreToolUse` just before the prompt, else by tool name), the turn ends (`Stop`, `UserPromptSubmit`) or the same agent raises a new question. Unanswered cards fall back to the terminal prompt like any other gate call.

A gate card can only be answered while its hook is still connected, because the answer travels back on that connection. If the hook's `curl` goes away (Claude Code gave up, the terminal answered, the hub restarted), the card is expired at once and logged "Hub restarted; answer in the terminal."; answering one that is no longer waiting returns 409 `{"reason":"not_waiting"}`. On start the hub expires any gate card it reloads from the database, and on SIGTERM/SIGINT it answers every open gate hook with `{}` first, so terminals fall back to their own prompt immediately. `request_decision` cards are different: the MCP server's long-poll reconnects by id, so they survive a restart. Keep the three numbers in order: `AMC_GATE_TIMEOUT_MS` (540000 ms) < `curl -m` (590 s) < hook `timeout` (600 s). Raise all three together to wait longer. This entry has no `|| true` and no output redirect because Claude Code reads the JSON it prints. The plain `PermissionRequest` reporter from section 4 still fires alongside it; the hub treats the second arrival as the same prompt (one `waiting_permission` transition, one log line) and the gate adds exactly one decision card.

## 5. Environment: telemetry

Optional. `--telemetry` adds it for you, per project or with `--global` (`amc wire --global --gate --telemetry`), and `amc unwire` takes it out again:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4242",
    "OTEL_METRIC_EXPORT_INTERVAL": "10000",
    "OTEL_LOGS_EXPORT_INTERVAL": "2000"
  }
}
```

- This makes Claude Code post API calls, tool results and token/cost metrics to the hub, which fills the stats panel. OpenTelemetry values are read once at startup, so restart `claude` after adding them.
- `OTEL_LOG_USER_PROMPTS` and `OTEL_LOG_TOOL_DETAILS` are deliberately not set: cards get their context from the session transcript, so there is no need to store prompt text a second time.
- Only missing keys are added; a key you already set to a harmless different value (an interval) is kept. If an existing setting routes telemetry elsewhere (a different `OTEL_EXPORTER_OTLP_ENDPOINT`, protocol or exporter, or a per-signal `OTEL_EXPORTER_OTLP_*_ENDPOINT`), in the target file or, for a project, in `~/.claude/settings.json`, `--telemetry` refuses rather than hijack your collector.
- Unwire removes these keys only when the endpoint is the hub on `127.0.0.1` and each value is still ours, so your own OTLP setup is never touched.
- Telemetry from ignored sessions is dropped by the hub.
- `MCP_TOOL_TIMEOUT` does not need setting: it defaults to about 28 hours. The per-server `timeout` in `.mcp.json` covers the 30 minute idle timeout, and the MCP server also sends progress notifications every 25 s while it waits.

## 6. Tell Claude when to ask

`amc wire` appends `packages/mcp-server/CLAUDE_SNIPPET.md` to the project's `CLAUDE.md` (`CLAUDE.local.md` with `--local`) between `<!-- mission-control:start -->` and `<!-- mission-control:end -->` so `amc unwire` can find it, skipping it if either the markers or the heading are already present. By hand:

```sh
cat /ABS/PATH/agent-mission-control/packages/mcp-server/CLAUDE_SNIPPET.md >> ~/Code/some-project/CLAUDE.md
```

Current text:

```markdown
## Decisions go through Mission Control

This project is wired to Agent Mission Control. Whenever you would otherwise stop and ask the user a question, choose between materially different approaches, or need a go/no-go before something hard to reverse (schema changes, deletes, deploys, spending money, contacting third parties), call the `request_decision` MCP tool instead of asking in the terminal:

- `question`: one sentence, the decision itself, readable on its own: the user sees a dashboard card, not your terminal.
- `options`: two to five short labels, mark the one you recommend with `recommended: true`. Put the consequence of each choice in its `description`.
- `context`: what you were doing, why the fork exists, and any snippet or path the user needs to decide. Be concrete; the user is not looking at your terminal.
- `urgency`: `low` for nice-to-know, `normal` by default, `high` if the session is blocked, `critical` if something is broken or costs money while you wait.

The call blocks until the user answers in the Mission Control UI and returns their choice as the tool result, sometimes with a note. Act on the answer and do not re-ask. If the tool returns `cancelled` or `expired`, stop and summarise the open question in your reply instead of guessing. If the call is moved to a background task, wait for its result before doing anything that depends on the decision. Do not use `request_decision` for trivial choices you can make yourself; the user wants fewer interruptions, not more.
```

## 7. Verify it works

1. Open http://127.0.0.1:4242.
2. In the project run `claude`. A station should appear within a second (from `SessionStart`) with a callsign and sprite.
3. Type a prompt. The station should flip to working and, with telemetry on, the token counter should tick within ten seconds.
4. Ask Claude: `Use request_decision to ask me whether to proceed, with options yes and no.` A decision card appears on the station; answer it in the UI and Claude should continue with your answer in the terminal.
5. If you added the gate, ask Claude to run `date`. An Allow/Deny card appears and the terminal shows "Waiting for Mission Control".
6. Run `/mcp` in Claude Code and confirm `mission-control` is `connected`.

Debugging: the hub's stdout already shows one line per hook event, gate exchange, decision change and OTLP batch at the default `AMC_LOG=info`, tagged with the persona callsign (for example `09:41:51 hook      SessionStart    SABLE  ~/Code/x`). Set `AMC_LOG=debug` to add payload keys. `claude --debug hooks,mcp` shows the Claude Code side of hook runs and MCP traffic.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No station appears when `claude` starts | Hooks not loaded, or hub not running | `/hooks` inside Claude Code lists active hooks. `curl -s 127.0.0.1:4242/api/health`. Check the settings file is valid JSON. |
| Events seem to vanish between Claude and the hub | Unclear which side dropped them | Read the hub stdout first (default `AMC_LOG=info` shows every event; `debug` adds payload keys). If the hub never saw it, run `claude --debug hooks,mcp` and compare. |
| Decisions land on a `pid:...` provisional station | MCP server could not match a session | Confirm `SessionStart` sends `X-Claude-Pid` and `X-Claude-Session`. Restart the session so the hook fires. The hub merges the provisional station once a hook reports the pid. |
| `request_decision` errors after about 30 minutes | Idle timeout | Add `"timeout": 86400000` to the `mission-control` entry in `.mcp.json`. |
| Claude says the call was moved to a background task | Auto-backgrounding after 2 minutes | Set `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` to `0` in settings `env` (section 4 or 5). |
| `mission-control` shows `failed` in `/mcp` | The wired `amc` was moved or deleted, the server crashed on start, or (checkout wiring) `bun` is not on PATH | `amc doctor` flags an entry that "points at a missing binary"; run `amc wire --global` (or `amc wire <dir>`) again and restart the session. Otherwise run the command from `.mcp.json` (or `claude mcp get mission-control`) by hand. For checkout wiring, use an absolute path to `bun` if Claude Code was launched from an app with a minimal PATH. Startup limit is `MCP_TIMEOUT`, 30 s. |
| `amc doctor` says the hub runs an older version | The hub was started before an upgrade | Restart it (`Ctrl+C`, then `amc start`) when no gate cards are pending; see [Upgrading](install.md#upgrading). |
| Gate card appears but the terminal prompt also appears at once | Hook returned before the hub answered | Check `AMC_GATE_TIMEOUT_MS` (ms) < `curl -m` (s) < hook `timeout` (s). |
| Gate card never appears for a tool call | The call was already allowed by a permission rule, so no prompt and no `PermissionRequest` | Expected. The gate only mirrors prompts Claude Code would show. |
| No token or cost stats | Telemetry not enabled or session started before the env was set | Restart `claude`. Check `OTEL_EXPORTER_OTLP_PROTOCOL` is `http/json`. |
| A nested `claude` gets its own station instead of joining its parent's crew | Parent not wired, `SessionStart` lacks `X-Claude-Ppid` (wired before crew support), or the parent was offline | Re-run `amc wire` and restart both sessions. `AMC_LOG=debug` shows `ppid=` on each hook line. |
| Station stays "working" after Claude stops | A subagent or teammate is still running (see its crew slot), or one was killed without `SubagentStop` | Wait; a working crew member silent for `AMC_CREW_STALE_MS` (10 min) is marked done and the station goes idle then. |
| Persona changed after resume | Session was forked, not resumed | `claude --resume <id>` keeps the id; `--fork-session` and `/branch` create a new one and a new persona. |
| Hooks slow every tool call | Hub unreachable and `curl` waiting | `-m 3` caps it; lower to `-m 1` if the hub is often off, or drop `PreToolUse`/`PostToolUse` hooks and rely on OTLP for activity. |
| Hub log shows `blocked  host`, `origin` or `content-type` and a caller gets 421, 403 or 415 | The request guard refused it: wrong `Host` (not loopback plus the hub port), a foreign browser `Origin`, or a POST without `Content-Type: application/json` | Expected for other websites. For your own tool, call `http://127.0.0.1:4242` directly, send no `Origin`, and label JSON bodies. |
| A session cannot load the MCP server and you need to answer its prompt | Escape hatch | Run that session inside tmux and answer there. A PTY-injecting wrapper is documented in `architecture.md` as a non-built fallback. |
