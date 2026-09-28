import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import type { Decision } from "@amc/shared";
import { wrapAnswer } from "../src/socket";
import { sleep, startTestHub, type TestHub } from "./helpers";

const SID = "66666666-aaaa-bbbb-cccc-000000000006";
const QUESTION_TEXT =
  "Done. Which service should mint invoice numbers once legacy-billing is retired?";

let t: TestHub;
let server: { stop(): void } | undefined;
const sockPath = `/tmp/amc-sock-${process.pid}.sock`;

afterEach(() => {
  server?.stop();
  server = undefined;
  fs.rmSync(sockPath, { force: true });
  t?.stop();
});

/** Stand-in for Claude Code's messaging socket: collects newline-delimited JSON. */
function fakeSessionSocket(): string[] {
  const lines: string[] = [];
  fs.rmSync(sockPath, { force: true });
  server = Bun.listen({
    unix: sockPath,
    socket: {
      data(_s, d) {
        lines.push(...d.toString().split("\n").filter(Boolean));
      },
    },
  });
  return lines;
}

async function proseCard(headers: Record<string, string>): Promise<Decision> {
  await t.hook("SessionStart", 1, { session_id: SID, cwd: "/tmp/p" }, headers);
  await t.post("/api/hooks/stop", {
    session_id: SID,
    hook_event_name: "Stop",
    stop_hook_active: true,
    last_assistant_message: QUESTION_TEXT,
  });
  return (await t.state()).decisions[0] as Decision;
}

describe("prose answers over the session socket", () => {
  test("delivers the wrapped answer with the auth token, then marks the card answered", async () => {
    const lines = fakeSessionSocket();
    t = startTestHub();
    const card = await proseCard({ "x-claude-socket": sockPath, "x-claude-token": "tok-123" });
    expect(card.answerable).toBe(true);
    expect(card.allowFreeText).toBe(true);
    // The token is a secret: never on the Session the UI sees.
    expect(JSON.stringify(await t.state())).not.toContain("tok-123");

    const res = await t.post<Decision>(`/api/decisions/${card.id}/answer`, {
      answer: "The CRM does, via its webhook.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("answered");
    await sleep(50);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { type: "auth", token: "tok-123" },
      {
        type: "user",
        message: { role: "user", content: wrapAnswer("The CRM does, via its webhook.") },
      },
    ]);
    expect(wrapAnswer("x", "note")).toBe(
      "The user answered your open questions in Mission Control:\nx\nNote: note",
    );
    expect((await t.state()).log.map((l) => l.text)).toContain("Answer delivered to the session.");
  });

  test("a dead socket gives 502 and flips the card to answer-in-terminal", async () => {
    fakeSessionSocket();
    t = startTestHub();
    const card = await proseCard({ "x-claude-socket": sockPath });
    server?.stop();
    server = undefined;
    fs.rmSync(sockPath, { force: true });
    const res = await t.post<{ reason: string }>(`/api/decisions/${card.id}/answer`, {
      answer: "yes",
    });
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("delivery_failed");
    const after = (await t.state()).decisions[0];
    expect(after?.status).toBe("pending");
    expect(after?.answerable).toBe(false);
    const again = await t.post<{ reason: string }>(`/api/decisions/${card.id}/answer`, {
      answer: "yes",
    });
    expect(again.status).toBe(409);
  });

  test("not answerable without a live socket, or with AMC_SOCKET_REPLY=off", async () => {
    t = startTestHub();
    expect((await proseCard({ "x-claude-socket": "/tmp/nope.sock" })).answerable).toBe(false);
    t.stop();
    fakeSessionSocket();
    t = startTestHub({ AMC_SOCKET_REPLY: "off" });
    expect((await proseCard({ "x-claude-socket": sockPath })).answerable).toBe(false);
  });
});
