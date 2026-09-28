import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { createGuard } from "../src/guard";
import { createLogger } from "../src/hublog";
import { startTestHub, type TestHub } from "./helpers";

const EVIL = "https://evil.example";
const JSON_TYPE = { "content-type": "application/json" };
const WS_HEADERS = {
  connection: "Upgrade",
  upgrade: "websocket",
  "sec-websocket-version": "13",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
};

describe("request guard", () => {
  let t: TestHub;
  let port: number;
  beforeEach(() => {
    t = startTestHub();
    port = Number(new URL(t.base).port);
  });
  afterEach(() => t.stop());

  const req = (path: string, init: RequestInit = {}) => fetch(t.base + path, init);

  test("foreign Origin on the WebSocket upgrade is rejected", async () => {
    const res = await req("/ws", { headers: { ...WS_HEADERS, origin: EVIL } });
    expect(res.status).toBe(403);
    expect(t.hub.broadcaster.size).toBe(0);
  });

  test("own-origin WebSocket connects and receives the snapshot", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    } as unknown as string[]);
    const first = await new Promise<string>((resolve, reject) => {
      ws.onmessage = (e) => resolve(String(e.data));
      ws.onerror = () => reject(new Error("ws error"));
    });
    ws.close();
    expect(first).toContain("snapshot");
  });

  test("foreign Origin POST is rejected before the route runs", async () => {
    t.hub.requestDecision({ question: "Ship?", options: [{ label: "Yes" }], source: "mcp" });
    const id = t.hub.decisions.pending()[0]?.id ?? "";
    const res = await req(`/api/decisions/${id}/answer`, {
      method: "POST",
      headers: { ...JSON_TYPE, origin: EVIL },
      body: JSON.stringify({ answer: "Yes" }),
    });
    expect(res.status).toBe(403);
    expect(t.hub.decisions.get(id)?.status).toBe("pending");
  });

  test("foreign Origin GET is rejected too", async () => {
    const res = await req("/api/state", { headers: { origin: EVIL } });
    expect(res.status).toBe(403);
  });

  test("text/plain and missing content types are rejected on POST", async () => {
    const plain = await req("/api/hooks/SessionStart", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1" }),
    });
    expect(plain.status).toBe(415);
    const none = await req("/api/decisions/x/cancel", { method: "POST" });
    expect(none.status).toBe(415);
    expect((await t.state()).sessions).toHaveLength(0);
  });

  test("a Host other than loopback with our port is rejected", async () => {
    const rebound = await req("/api/state", { headers: { host: `evil.example:${port}` } });
    expect(rebound.status).toBe(421);
    const wrongPort = await req("/api/state", { headers: { host: "127.0.0.1:1" } });
    expect(wrongPort.status).toBe(421);
  });

  test("hook-style POST (no Origin, JSON with charset) is accepted", async () => {
    const res = await req("/api/hooks/SessionStart", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", "x-claude-pid": "4242" },
      body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", cwd: "/tmp/x" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect((await t.state()).sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  test("the served UI's own origin works on every loopback name", async () => {
    for (const name of ["127.0.0.1", "localhost", "[::1]"]) {
      const res = await req("/api/state", {
        headers: { host: `${name}:${port}`, origin: `http://${name}:${port}` },
      });
      expect(res.status).toBe(200);
    }
    const post = await req("/api/decisions/nope/cancel", {
      method: "POST",
      headers: { ...JSON_TYPE, origin: `http://localhost:${port}` },
      body: JSON.stringify({ dismiss: true }),
    });
    expect(post.status).toBe(404);
  });

  test("the Vite dev origin is accepted through the proxy and keeps CORS", async () => {
    const res = await req("/api/state", {
      headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
  });

  test("OTLP export with the exporter's real headers is accepted", async () => {
    // Captured from Claude Code's OTel-OTLP-Exporter-JavaScript/0.208.0 (http/json).
    const res = await req("/v1/metrics", {
      method: "POST",
      headers: { ...JSON_TYPE, "user-agent": "OTel-OTLP-Exporter-JavaScript/0.208.0" },
      body: JSON.stringify({ resourceMetrics: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ partialSuccess: {} });
  });
});

describe("guard logging", () => {
  test("logs each (reason, subject) once and strips control characters", () => {
    const lines: string[] = [];
    const guard = createGuard(
      loadConfig({ AMC_DATA_DIR: "/nonexistent" }),
      createLogger("info", (l) => lines.push(l)),
    );
    const evil = () =>
      new Request("http://127.0.0.1:4242/api/state", {
        headers: { host: "127.0.0.1:4242", origin: "https://evil.example\u001b[2J" },
      });
    expect(guard(evil(), 4242)?.status).toBe(403);
    expect(guard(evil(), 4242)?.status).toBe(403);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("blocked");
    expect(lines[0]).toContain("origin  https://evil.example?[2J");
  });
});
