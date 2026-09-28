# Security

## Threat model

Agent Mission Control is a local, single-user tool. The hub listens on `127.0.0.1:4242` and has no authentication. It can answer permission prompts and send messages into your Claude Code sessions, so treat it with the same trust as the shell those sessions run in.

What the hub stores, in `~/.agent-mission-control` (or `AMC_DATA_DIR`): the SQLite database `amc.db`, an optional user-edited `config.json`, and for the optional ElevenLabs voice `secrets.env` and `voice-cache/`. The database holds:

- session metadata: ids, working directories, process ids, personas, status, and the session messaging-socket path and token when Claude Code provides them;
- decision cards, including their context: excerpts of your prompts and of Claude's replies, Bash commands, file paths and diffs;
- activity lines and the mission log;
- token and cost counters from OTLP telemetry, when a project is wired with `--telemetry`;
- for the ElevenLabs voice: each session's assigned voice and a per-day character count.

The hub also reads, and never writes, files Claude Code keeps under `~/.claude` (or `AMC_CLAUDE_HOME`): the tail of session and subagent transcripts, to give cards context, and agent team rosters.

## What leaves your machine

Nothing, unless you turn on the ElevenLabs voice. The OTLP telemetry that `--telemetry` enables is sent by Claude Code to the hub on loopback, and the hub sends no telemetry of its own. With an ElevenLabs key configured, the hub sends the text of each spoken announcement (fixed phrases built from a callsign, a count, and tool or role names; never card content, prompts or code) to the ElevenLabs API, and caches the audio locally.

The ElevenLabs key comes from `ELEVENLABS_API_KEY` or from `secrets.env`, which the hub ignores while group or others have any access to it (`chmod 600` it). The key is only ever sent as the header on requests to ElevenLabs; the UI, the log and `amc doctor` never see it. The messaging-socket token is kept on the session record only and never logged or sent to the UI.

## What the hub protects against

Binding loopback keeps other machines out, but any web page open in your browser can still reach `127.0.0.1`. Every request is checked before it reaches a route, the WebSocket or the UI files:

- **Host** must be `127.0.0.1`, `localhost` or `[::1]` with the hub's port (or the Vite dev server during development). This blocks DNS rebinding.
- **Origin**, if present, must be the hub's own origin or the Vite dev origin. This covers the WebSocket upgrade, which browsers do not protect with CORS.
- **Content-Type** must be `application/json` on every request other than GET, HEAD and OPTIONS, so a cross-site form or `text/plain` post cannot skip the CORS preflight.

Refused requests get 421, 403 or 415 and a `blocked` line in the hub log.

## What it does not protect against

Any local process running as you can talk to the hub, by design: that is how hooks, the MCP server and telemetry reach it. A malicious local process already has your shell. Do not expose the hub beyond loopback: no tunnels, no `AMC_HOST=0.0.0.0`, no reverse proxies.

## Reporting a vulnerability

Please report privately through GitHub private vulnerability reporting on this repository: the Security tab, then "Report a vulnerability". Do not open a public issue for security problems.

Include what you found, how to reproduce it, and the output of `amc --version`. You should get a first reply within a week. This is an alpha project maintained in spare time, so fixes land on `main` and ship in the next release; only the latest release is supported.
