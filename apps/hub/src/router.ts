import {
  type DecisionAnswerBody,
  type DecisionRequest,
  type HookPayload,
  type PersonaVoice,
  SPEAK_MAX_CHARS,
  type SpeakRequest,
  type Urgency,
  type VoiceAssignRequest,
} from "@amc/shared";
import { type Hub, MAX_MESSAGE_CHARS } from "./hub";
import { payloadKeys, shortPath } from "./hublog";
import type { HookMeta } from "./sessions";
import { VERSION } from "./version";

type Handler = (
  req: Request,
  url: URL,
  params: Record<string, string>,
) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const URGENCIES: Urgency[] = ["low", "normal", "high", "critical"];
const PERSONA_VOICES: PersonaVoice[] = [
  "deadpan",
  "gungho",
  "anxious",
  "noir",
  "bureaucrat",
  "pirate",
  "robot",
];

/** Tiny path router: `/api/decisions/:id/wait` style patterns, first match wins. */
export function createRouter(hub: Hub) {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:([a-zA-Z]+)/g, (_, k: string) => {
        keys.push(k);
        return "([^/]+)";
      })}$`,
    );
    routes.push({ method, pattern, keys, handler });
  };

  const cors = (req: Request, res: Response): Response => {
    const origin = req.headers.get("origin");
    if (origin && hub.config.corsOrigins.includes(origin)) {
      res.headers.set("access-control-allow-origin", origin);
      res.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
      res.headers.set(
        "access-control-allow-headers",
        "content-type,x-claude-pid,x-claude-ppid,x-claude-socket",
      );
      res.headers.set("vary", "origin");
    }
    return res;
  };

  add("GET", "/api/health", () =>
    Response.json({ ok: true, version: VERSION, clients: hub.broadcaster.size }),
  );
  add("GET", "/api/state", () => Response.json(hub.snapshot()));

  // Lower-case "stop" is the Stop hook that may answer; "/api/hooks/Stop" (below) only reports.
  add("POST", "/api/hooks/stop", async (req) => {
    const payload = await readJson<HookPayload>(req);
    if (!payload || typeof payload !== "object") return Response.json({});
    try {
      return Response.json(hub.stopHook(hookMeta(req), payload));
    } catch (err) {
      // Never block Claude on our account.
      console.error("[hub] stop hook error", err);
      return Response.json({});
    }
  });

  add("POST", "/api/hooks/gate", async (req) => {
    const payload = await readJson<HookPayload>(req);
    if (!payload) return bad("invalid JSON");
    const out = await hub.gate(hookMeta(req), payload, req.signal);
    if (hub.isIgnored(payload.session_id, undefined)) return Response.json(out);
    hub.logger.event(
      "gate",
      [
        payload.hook_event_name,
        payload.tool_name,
        hub.callsign(payload.session_id),
        JSON.stringify(out),
      ],
      payloadKeys(payload),
    );
    return Response.json(out);
  });

  add("POST", "/api/hooks/:event", async (req, _url, params) => {
    const payload = await readJson<HookPayload>(req);
    // Hooks must never fail Claude on our account: swallow bad bodies too.
    if (payload && typeof payload === "object") {
      try {
        const event = params.event ?? payload.hook_event_name ?? "";
        const meta = hookMeta(req);
        const outcome = hub.handleHook(event, meta, payload);
        if (outcome === "ignored") return Response.json({});
        hub.logger.event(
          "hook",
          [
            event.padEnd(14),
            hub.callsign(payload.session_id),
            payload.tool_name ?? payload.notification_type,
            outcome === "duplicate" ? "(duplicate, dropped)" : undefined,
            shortPath(typeof payload.cwd === "string" ? payload.cwd : undefined),
          ],
          () =>
            `pid=${meta.claudePid ?? "-"} ppid=${meta.parentPid ?? "-"} agent=${payload.agent_id ?? "-"} socket=${meta.socket ?? "-"} ${payloadKeys(payload)()}`,
        );
      } catch (err) {
        console.error("[hub] hook error", params.event, err);
      }
    }
    return Response.json({});
  });

  add("POST", "/api/decisions", async (req) => {
    const body = await readJson<DecisionRequest>(req);
    if (!body || typeof body.question !== "string" || !body.question.trim()) {
      return bad("question is required");
    }
    const options = Array.isArray(body.options)
      ? body.options.filter((o) => o && typeof o.label === "string")
      : [];
    const allowFreeText = body.allowFreeText === true;
    if (options.length === 0 && !allowFreeText) return bad("options required unless allowFreeText");
    if (options.length > 6) return bad("at most 6 options");
    if (hub.isIgnored(body.sessionId, typeof body.cwd === "string" ? body.cwd : undefined)) {
      // The MCP server turns this into "not tracked, ask in chat".
      return Response.json(
        {
          error: "mission control ignores this session (cwd is on the ignore list)",
          ignored: true,
        },
        { status: 409 },
      );
    }
    const decision = hub.requestDecision({
      ...body,
      source: body.source === "permission" || body.source === "hook" ? body.source : "mcp",
      options: options.slice(0, 6),
      urgency: URGENCIES.includes(body.urgency as Urgency) ? body.urgency : "normal",
      allowFreeText,
    });
    return Response.json({ id: decision.id, sessionId: decision.sessionId }, { status: 201 });
  });

  add("GET", "/api/decisions/:id/wait", async (_req, url, params) => {
    const id = params.id ?? "";
    if (!hub.decisions.get(id))
      return Response.json({ error: "no such decision" }, { status: 404 });
    const requested = Number(url.searchParams.get("timeoutMs") ?? 25_000);
    const timeoutMs = Math.min(
      Math.max(Number.isFinite(requested) ? requested : 25_000, 0),
      hub.config.maxWaitMs,
    );
    return Response.json(await hub.decisions.wait(id, timeoutMs));
  });

  add("POST", "/api/decisions/:id/answer", async (req, _url, params) => {
    const body = await readJson<DecisionAnswerBody>(req);
    const hasAnswers = !!body?.answers && typeof body.answers === "object";
    if (!body || (typeof body.answer !== "string" && !hasAnswers)) {
      return bad("answer is required");
    }
    const result = await hub.answerDecision(params.id ?? "", {
      ...body,
      answer: body.answer ?? "",
    });
    if (!result.ok) {
      return Response.json(
        { error: result.error, ...("reason" in result ? { reason: result.reason } : {}) },
        { status: result.code },
      );
    }
    return Response.json(result.decision);
  });

  add("POST", "/api/decisions/:id/cancel", async (req, url, params) => {
    // The UI's Dismiss sends {"dismiss": true} (or ?dismiss=1); the MCP server's
    // cancel on abort sends nothing and keeps its old meaning.
    const body = await readJson<{ dismiss?: boolean }>(req);
    const dismiss = body?.dismiss === true || url.searchParams.get("dismiss") === "1";
    const id = params.id ?? "";
    const d = dismiss ? hub.dismissDecision(id) : hub.decisions.cancel(id);
    if (!d) return Response.json({ error: "no such decision" }, { status: 404 });
    return Response.json(d);
  });

  add("POST", "/api/sessions/:id/message", async (req, _url, params) => {
    const body = await readJson<{ text?: unknown }>(req);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return bad("text is required");
    if (text.length > MAX_MESSAGE_CHARS)
      return bad(`text is limited to ${MAX_MESSAGE_CHARS} characters`);
    const result = await hub.messageSession(params.id ?? "", text);
    if (!result.ok) {
      return Response.json({ error: result.error, reason: result.reason }, { status: result.code });
    }
    return Response.json({ ok: true });
  });

  add("GET", "/api/voice/status", async () => Response.json(await hub.tts.status()));

  add("POST", "/api/voice/speak", async (req) => {
    const body = await readJson<SpeakRequest>(req);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text || text.length > SPEAK_MAX_CHARS) {
      return Response.json(
        { error: `text is required, at most ${SPEAK_MAX_CHARS} characters`, reason: "bad_request" },
        { status: 400 },
      );
    }
    const fromSession =
      typeof body?.sessionId === "string" ? hub.sessions.persona(body.sessionId) : undefined;
    const given = body?.persona;
    const persona = fromSession ?? {
      voice: given && PERSONA_VOICES.includes(given.voice) ? given.voice : "deadpan",
      spriteSeed: Number.isFinite(given?.spriteSeed) ? Number(given?.spriteSeed) : 0,
    };
    const result = await hub.tts.speak(text, persona, fromSession ? body?.sessionId : undefined);
    if (!result.ok) {
      return Response.json(
        { error: result.error, reason: result.reason },
        { status: result.status },
      );
    }
    return new Response(result.audio, {
      headers: {
        "content-type": "audio/mpeg",
        "cache-control": "no-store",
        "x-amc-voice-cache": result.cached ? "hit" : "miss",
      },
    });
  });

  add("POST", "/api/voice/assign", async (req) => {
    const body = await readJson<VoiceAssignRequest>(req);
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
    const persona = sessionId ? hub.sessions.persona(sessionId) : undefined;
    if (!persona) {
      return Response.json({ error: "no such session", reason: "bad_request" }, { status: 404 });
    }
    const result = await hub.tts.assign(sessionId, persona, body?.next === true);
    if (!result.ok) {
      return Response.json(
        { error: result.error, reason: result.reason },
        { status: result.status },
      );
    }
    return Response.json({ sessionId, voiceName: result.voiceName });
  });

  add("POST", "/api/status", async (req) => {
    const body = await readJson<{
      ancestorPids?: number[];
      cwd?: string;
      line?: string;
      sessionId?: string;
    }>(req);
    if (!body || typeof body.line !== "string") return bad("line is required");
    if (hub.isIgnored(body.sessionId, typeof body.cwd === "string" ? body.cwd : undefined)) {
      return Response.json({ ignored: true });
    }
    const sessionId = hub.reportStatus({
      sessionId: body.sessionId,
      ancestorPids: Array.isArray(body.ancestorPids) ? body.ancestorPids.map(Number) : undefined,
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
      line: body.line.slice(0, 200),
    });
    return Response.json({ sessionId });
  });

  add("POST", "/v1/logs", async (req) => {
    const body = await readJson<unknown>(req);
    const n = body ? hub.ingestOtlpLogs(body) : 0;
    return Response.json({ partialSuccess: {}, accepted: n });
  });
  add("POST", "/v1/metrics", async (req) => {
    const body = await readJson<unknown>(req);
    const n = body ? hub.ingestOtlpMetrics(body) : 0;
    return Response.json({ partialSuccess: {}, accepted: n });
  });
  add("POST", "/v1/traces", () => Response.json({ partialSuccess: {} }));

  return async (req: Request, url: URL): Promise<Response | undefined> => {
    if (req.method === "OPTIONS") return cors(req, new Response(null, { status: 204 }));
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? "");
      });
      try {
        return cors(req, await r.handler(req, url, params));
      } catch (err) {
        console.error("[hub] route error", req.method, url.pathname, err);
        return cors(req, Response.json({ error: "internal error" }, { status: 500 }));
      }
    }
    return undefined;
  };
}

async function readJson<T>(req: Request): Promise<T | undefined> {
  try {
    const text = await req.text();
    if (!text.trim()) return {} as T;
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function bad(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

function hookMeta(req: Request): HookMeta {
  const pid = (name: string) => {
    const n = Number.parseInt(req.headers.get(name) ?? "", 10);
    return Number.isInteger(n) && n > 1 ? n : undefined;
  };
  const claudePid = pid("x-claude-pid");
  const parentPid = pid("x-claude-ppid");
  const socket = req.headers.get("x-claude-socket")?.trim();
  const token = req.headers.get("x-claude-token")?.trim();
  return {
    ...(token ? { token } : {}),
    ...(claudePid ? { claudePid } : {}),
    ...(parentPid ? { parentPid } : {}),
    ...(socket ? { socket } : {}),
  };
}
