import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { wrapMessage } from "../src/socket";
import { sleep, startTestHub, type TestHub } from "./helpers";

const SID = "bbbbbbbb-aaaa-bbbb-cccc-00000000000b";
// Distinct from socket.test.ts: socketExists caches per path for a few seconds.
const sockPath = `/tmp/amc-msg-${process.pid}.sock`;

let t: TestHub;
let server: { stop(): void } | undefined;
afterEach(() => {
  server?.stop();
  server = undefined;
  fs.rmSync(sockPath, { force: true });
  t?.stop();
});

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

const send = (text: unknown, id = SID) =>
  t.post<{ ok?: boolean; reason?: string }>(`/api/sessions/${id}/message`, { text });

describe("operator messages to a session", () => {
  test("delivers wrapped over the socket with the token, logs a note, flags canMessage", async () => {
    const lines = fakeSessionSocket();
    t = startTestHub();
    await t.hook(
      "SessionStart",
      1,
      { session_id: SID, cwd: "/tmp/m" },
      { "x-claude-socket": sockPath, "x-claude-token": "tok-9" },
    );
    expect((await t.state()).sessions[0]?.canMessage).toBe(true);

    const text = `Also check the staging config. ${"x".repeat(200)}`;
    const res = await send(`  ${text}  `);
    expect(res.status).toBe(200);
    await sleep(50);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { type: "auth", token: "tok-9" },
      { type: "user", message: { role: "user", content: wrapMessage(text) } },
    ]);
    expect(wrapMessage("hi")).toBe("Message from the user via Mission Control:\nhi");
    const note = (await t.state()).log.find((l) => l.kind === "note");
    expect(note?.text).toStartWith("Operator: Also check the staging config.");
    expect(note?.text.length).toBeLessThanOrEqual(130);
    expect(note?.meta).toEqual({ from: "operator", text });

    // One per 2s per session.
    expect((await send("again")).body.reason).toBe("rate_limited");
  });

  test("validation, unknown or ignored sessions, no socket, dead socket", async () => {
    t = startTestHub({ AMC_IGNORE_CWD: "/tmp/ign" });
    expect((await send("")).status).toBe(400);
    expect((await send("x".repeat(4001))).status).toBe(400);
    expect((await send("hi", "nope")).status).toBe(404);
    await t.hook("SessionStart", 2, { session_id: "ign", cwd: "/tmp/ign/x" });
    expect((await send("hi", "ign")).status).toBe(404);

    await t.hook("SessionStart", 1, { session_id: SID, cwd: "/tmp/m" });
    expect((await t.state()).sessions[0]?.canMessage).toBe(false);
    const none = await send("hi");
    expect(none.status).toBe(409);
    expect(none.body.reason).toBe("no_socket");

    // Socket known and seen a moment ago, but the session is gone.
    fakeSessionSocket();
    await t.hook(
      "PreToolUse",
      1,
      { session_id: SID, tool_name: "Read" },
      { "x-claude-socket": sockPath },
    );
    server?.stop();
    server = undefined;
    const dead = await send("hi");
    expect(dead.status).toBe(502);
    expect(dead.body.reason).toBe("delivery_failed");
  });
});
