import { afterEach, describe, expect, test } from "bun:test";
import { restartTestHub, sleep, startTestHub, type TestHub } from "./helpers";

const SID = "55555555-aaaa-bbbb-cccc-000000000005";
const NOTE = "Hub restarted; answer in the terminal.";
const ASK = {
  session_id: SID,
  hook_event_name: "PermissionRequest",
  tool_name: "AskUserQuestion",
  tool_input: {
    questions: [
      {
        question: "Which?",
        header: "Pick",
        options: [{ label: "A" }, { label: "B" }],
        multiSelect: false,
      },
    ],
  },
};

let t: TestHub;
afterEach(() => t?.stop());

describe("gate cards whose hook is gone", () => {
  test("a hub restart expires pending gate cards but keeps mcp decisions", async () => {
    t = startTestHub();
    const orphan = fetch(`${t.base}/api/hooks/gate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ASK),
    }).catch(() => undefined);
    const mcp = await t.post<{ id: string }>("/api/decisions", {
      sessionId: SID,
      source: "mcp",
      question: "Keep me?",
      options: [{ label: "yes" }, { label: "no" }],
    });
    await sleep(30);
    expect(t.hub.decisions.pending()).toHaveLength(2);

    t = restartTestHub(t);
    await orphan;
    const state = await t.state();
    expect(state.decisions.map((d) => d.id)).toEqual([mcp.body.id]);
    expect(state.log.map((l) => l.text)).toContain(NOTE);
  });

  test("answering a gate card with no live hook returns 409 not_waiting and expires it", async () => {
    t = startTestHub();
    await t.hook("SessionStart", 1, { session_id: SID });
    // Created without a gate hook behind it, as after a lost connection.
    const d = t.hub.decisions.create({
      sessionId: SID,
      source: "permission",
      question: "Allow Bash?",
      options: [{ label: "Allow" }, { label: "Deny" }],
    });
    const res = await t.post<{ reason: string }>(`/api/decisions/${d.id}/answer`, {
      answer: "Allow",
    });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("not_waiting");
    expect(t.hub.decisions.get(d.id)?.status).toBe("expired");
    expect((await t.state()).log.map((l) => l.text)).toContain(NOTE);
  });

  test("the card disappears as soon as the hook's connection drops", async () => {
    t = startTestHub();
    const abort = new AbortController();
    const req = fetch(`${t.base}/api/hooks/gate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ASK),
      signal: abort.signal,
    }).catch(() => undefined);
    await sleep(30);
    const [card] = t.hub.decisions.pending();
    expect(card?.source).toBe("ask");
    abort.abort();
    await req;
    await sleep(50);
    expect(t.hub.decisions.get(card?.id ?? "")?.status).toBe("expired");
  });

  test("releaseGates (SIGTERM/SIGINT) answers open gate hooks with {}", async () => {
    t = startTestHub();
    const reply = t.post("/api/hooks/gate", ASK);
    await sleep(30);
    expect(t.hub.decisions.pending()).toHaveLength(1);
    t.hub.releaseGates();
    expect((await reply).body).toEqual({});
    expect(t.hub.decisions.pending()).toHaveLength(0);
  });
});
