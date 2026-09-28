import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { SpeakFailure, VoiceStatus } from "@amc/shared";
import { coreLines } from "@amc/shared/phrases";
import type { Server } from "bun";
import {
  chooseVoice,
  type ElevenVoice,
  parseSecrets,
  parseVoices,
  pickElevenVoice,
  rankElevenVoices,
  voiceSettings,
} from "../src/tts";
import { restartTestHub, startTestHub, type TestHub } from "./helpers";

const KEY = "sk_test_never_leaks_0123456789";
const JSON_TYPE = { "content-type": "application/json" };

/** Shaped like a real account: premade voices with character in the name, plus one clone. */
const VOICES = [
  { voice_id: "v-roger", name: "Roger - Laid-Back, Casual, Resonant", category: "premade" },
  { voice_id: "v-callum", name: "Callum - Husky Trickster", category: "premade" },
  { voice_id: "v-laura", name: "Laura - Enthusiast, Quirky Attitude", category: "premade" },
  { voice_id: "v-charlie", name: "Charlie - Deep, Confident, Energetic", category: "premade" },
  { voice_id: "v-george", name: "George - Warm, Captivating Storyteller", category: "premade" },
  { voice_id: "v-sarah", name: "Sarah - Mature, Reassuring, Confident", category: "premade" },
  {
    voice_id: "v-river",
    name: "River",
    category: "premade",
    labels: { accent: "american", description: "neutral", use_case: "informative_educational" },
  },
  { voice_id: "v-me", name: "My Clone", category: "cloned" },
];

interface Fake {
  url: string;
  tts: { voiceId: string; key: string | null; body: Record<string, unknown> }[];
  voiceCalls: number;
  mode: { tts: "ok" | "500" | "slow"; voices: "ok" | "401" };
  server: Server<undefined>;
}

function fakeElevenLabs(): Fake {
  const fake = {
    tts: [],
    voiceCalls: 0,
    mode: { tts: "ok", voices: "ok" },
  } as unknown as Fake;
  fake.server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/voices") {
        fake.voiceCalls++;
        if (req.headers.get("xi-api-key") !== KEY || fake.mode.voices === "401")
          return Response.json({ detail: { status: "invalid_api_key" } }, { status: 401 });
        return Response.json({ voices: VOICES });
      }
      const m = /^\/v1\/text-to-speech\/([^/]+)$/.exec(url.pathname);
      if (m && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        fake.tts.push({ voiceId: m[1] ?? "", key: req.headers.get("xi-api-key"), body });
        if (fake.mode.tts === "500") return new Response("boom", { status: 500 });
        if (fake.mode.tts === "slow") await Bun.sleep(400);
        return new Response(new TextEncoder().encode(`MP3:${body.text}`), {
          headers: { "content-type": "audio/mpeg" },
        });
      }
      return new Response("nope", { status: 404 });
    },
  });
  fake.url = `http://127.0.0.1:${fake.server.port}`;
  return fake;
}

async function speak(t: TestHub, body: unknown) {
  const res = await fetch(`${t.base}/api/voice/speak`, {
    method: "POST",
    headers: JSON_TYPE,
    body: JSON.stringify(body),
  });
  const type = res.headers.get("content-type") ?? "";
  return {
    status: res.status,
    cache: res.headers.get("x-amc-voice-cache"),
    audio: type.startsWith("audio/") ? await res.text() : undefined,
    fail: type.includes("json") ? ((await res.json()) as SpeakFailure) : undefined,
  };
}

const status = async (t: TestHub) =>
  (await (await fetch(`${t.base}/api/voice/status`)).json()) as VoiceStatus;

const persona = { voice: "deadpan", spriteSeed: 3 } as const;

describe("voice provider: not configured", () => {
  let t: TestHub;
  beforeEach(() => {
    t = startTestHub({ AMC_ELEVENLABS_URL: "http://127.0.0.1:1" });
  });
  afterEach(() => t.stop());

  test("status says browser only, speak answers 409 not_configured", async () => {
    const s = await status(t);
    expect(s.providers.browser).toBe(true);
    expect(s.providers.elevenlabs).toEqual({ configured: false, keySource: null });
    expect(s.dailyCharsCap).toBe(20_000);
    const r = await speak(t, { text: "Nova is on the floor.", persona });
    expect(r.status).toBe(409);
    expect(r.fail?.reason).toBe("not_configured");
  });

  test("bad text is a 400", async () => {
    expect((await speak(t, { text: "" })).status).toBe(400);
    expect((await speak(t, { text: "x".repeat(201) })).status).toBe(400);
  });
});

describe("voice provider: ElevenLabs against a fake server", () => {
  let fake: Fake;
  let t: TestHub;
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  beforeEach(() => {
    fake = fakeElevenLabs();
    logs.length = 0;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    t = startTestHub({
      AMC_LOG: "debug",
      ELEVENLABS_API_KEY: KEY,
      AMC_ELEVENLABS_URL: fake.url,
      AMC_TTS_PREWARM: "off",
    });
  });
  afterEach(() => {
    t.stop();
    fake.server.stop(true);
    console.log = origLog;
    console.error = origErr;
  });

  test("status lists voices and never carries the key", async () => {
    const res = await fetch(`${t.base}/api/voice/status`);
    const raw = await res.text();
    expect(raw).not.toContain(KEY);
    const s = JSON.parse(raw) as VoiceStatus;
    expect(s.providers.elevenlabs.configured).toBe(true);
    // Clones are left out while stock voices exist.
    expect(s.providers.elevenlabs.voices?.map((v) => v.id)).not.toContain("v-me");
    expect(s.providers.elevenlabs.voices?.length).toBe(7);
  });

  test("miss renders upstream with the key header, hit is served from disk", async () => {
    const first = await speak(t, { text: "Nova is on the floor.", persona });
    expect(first.status).toBe(200);
    expect(first.cache).toBe("miss");
    expect(first.audio).toBe("MP3:Nova is on the floor.");
    expect(fake.tts.length).toBe(1);
    expect(fake.tts[0]?.key).toBe(KEY);
    expect(fake.tts[0]?.body.model_id).toBe("eleven_flash_v2_5");
    // Deadpan base (stability 0.75, style 0, speed 1) nudged by the seed, then clamped.
    expect(fake.tts[0]?.body.voice_settings).toEqual(voiceSettings("deadpan", 3));

    const again = await speak(t, { text: "Nova is on the floor.", persona });
    expect(again.cache).toBe("hit");
    expect(again.audio).toBe(first.audio);
    expect(fake.tts.length).toBe(1);
    expect(fs.readdirSync(path.join(t.dataDir, "voice-cache")).length).toBe(1);

    // A different persona voice is a different cache entry.
    await speak(t, { text: "Nova is on the floor.", persona: { voice: "pirate", spriteSeed: 3 } });
    expect(fake.tts.length).toBe(2);
    expect((await status(t)).dailyCharsUsed).toBe(42);
  });

  test("daily cap counts misses only and refuses past it", async () => {
    t.hub.config.tts.dailyChars = 30;
    expect((await speak(t, { text: "Nova is on the floor.", persona })).status).toBe(200);
    const over = await speak(t, { text: "Nova is standing by.", persona });
    expect(over.status).toBe(409);
    expect(over.fail?.reason).toBe("cap_reached");
    expect(fake.tts.length).toBe(1);
    // Cached lines still play once the cap is hit.
    expect((await speak(t, { text: "Nova is on the floor.", persona })).cache).toBe("hit");
    expect((await status(t)).dailyCharsUsed).toBe(21);
  });

  test("upstream errors and timeouts become 503 with a reason", async () => {
    fake.mode.tts = "500";
    const err = await speak(t, { text: "Nova is on the floor.", persona });
    expect(err.status).toBe(503);
    expect(err.fail?.reason).toBe("upstream");
    expect((await status(t)).dailyCharsUsed).toBe(0);

    fake.mode.tts = "slow";
    t.hub.config.tts.timeoutMs = 100;
    const slow = await speak(t, { text: "Nova is standing by.", persona });
    expect(slow.status).toBe(503);
    expect(slow.fail?.reason).toBe("timeout");
  });

  test("a rejected key shows in status as an error, never as the key", async () => {
    fake.mode.voices = "401";
    const s = await status(t);
    expect(s.providers.elevenlabs.configured).toBe(true);
    expect(s.providers.elevenlabs.error).toContain("rejected the API key");
    const r = await speak(t, { text: "Nova is on the floor.", persona });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.fail)).not.toContain(KEY);
  });

  test("the key never reaches the log", async () => {
    await speak(t, { text: "Nova is on the floor.", persona });
    fake.mode.tts = "500";
    await speak(t, { text: "Nova is standing by.", persona });
    expect(logs.some((l) => l.includes("elevenlabs"))).toBe(true);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  test("the request guard covers the voice routes", async () => {
    const plain = await fetch(`${t.base}/api/voice/speak`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ text: "Nova is on the floor." }),
    });
    expect(plain.status).toBe(415);
    const foreign = await fetch(`${t.base}/api/voice/speak`, {
      method: "POST",
      headers: { ...JSON_TYPE, origin: "https://evil.example" },
      body: JSON.stringify({ text: "Nova is on the floor." }),
    });
    expect(foreign.status).toBe(403);
    const foreignGet = await fetch(`${t.base}/api/voice/status`, {
      headers: { origin: "https://evil.example" },
    });
    expect(foreignGet.status).toBe(403);
    expect(fake.tts.length).toBe(0);
  });
});

describe("voice provider: prewarm", () => {
  let fake: Fake;
  let t: TestHub;
  beforeEach(() => {
    fake = fakeElevenLabs();
    t = startTestHub({ ELEVENLABS_API_KEY: KEY, AMC_ELEVENLABS_URL: fake.url });
  });
  afterEach(() => {
    t.stop();
    fake.server.stop(true);
  });

  test("the first line for a session warms the rest of its persona's lines, once", async () => {
    await t.hook("SessionStart", 5151, { session_id: "s-warm", cwd: "/tmp/warm" });
    const p = t.hub.sessions.persona("s-warm");
    if (!p) throw new Error("no persona");
    const lines = coreLines(p);
    const first = lines[0] ?? "";
    expect((await speak(t, { text: first, sessionId: "s-warm" })).status).toBe(200);
    await t.hub.tts.idle();
    expect(fake.tts.map((c) => c.body.text).sort()).toEqual([...lines].sort());
    // Everything is cached now: a second line costs nothing and nothing re-warms.
    const hit = await speak(t, { text: lines[1] ?? "", sessionId: "s-warm" });
    expect(hit.cache).toBe("hit");
    await t.hub.tts.idle();
    expect(fake.tts.length).toBe(lines.length);
  });

  test("prewarm stops at the daily cap", async () => {
    t.hub.config.tts.dailyChars = 80;
    await t.hook("SessionStart", 5152, { session_id: "s-cap", cwd: "/tmp/cap" });
    const p = t.hub.sessions.persona("s-cap");
    if (!p) throw new Error("no persona");
    await speak(t, { text: coreLines(p)[0] ?? "", sessionId: "s-cap" });
    await t.hub.tts.idle();
    expect(t.hub.tts.usedToday()).toBeLessThanOrEqual(80);
    expect(fake.tts.length).toBeLessThan(coreLines(p).length);
  });
});

describe("voice provider: secrets.env", () => {
  let fake: Fake;
  let t: TestHub | undefined;
  let dir: string;
  beforeEach(() => {
    fake = fakeElevenLabs();
    dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "amc-secrets-"));
  });
  afterEach(() => {
    t?.stop();
    t = undefined;
    fake.server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (content: string, mode: number) => {
    const file = path.join(dir, "secrets.env");
    fs.writeFileSync(file, content);
    fs.chmodSync(file, mode);
  };

  test("a 0600 file configures the hub; rotation is picked up without a restart", async () => {
    t = startTestHub({ AMC_ELEVENLABS_URL: fake.url, AMC_TTS_PREWARM: "off" }, dir);
    expect((await status(t)).providers.elevenlabs.configured).toBe(false);
    write(`# ElevenLabs\nexport ELEVENLABS_API_KEY="${KEY}"\nOTHER=x\n`, 0o600);
    const s = await status(t);
    expect(s.providers.elevenlabs.configured).toBe(true);
    expect(s.providers.elevenlabs.voices?.length).toBe(7);
    expect((await speak(t, { text: "Nova is on the floor.", persona })).status).toBe(200);
    expect(fake.tts[0]?.key).toBe(KEY);

    write("ELEVENLABS_API_KEY=rotated-but-wrong\n", 0o600);
    // mtime granularity: make sure the stat changes.
    fs.utimesSync(path.join(dir, "secrets.env"), new Date(), new Date(Date.now() + 5_000));
    const rotated = await status(t);
    expect(rotated.providers.elevenlabs.error).toContain("rejected");
  });

  test("a group or world readable file is refused", async () => {
    write(`ELEVENLABS_API_KEY=${KEY}\n`, 0o644);
    t = startTestHub({ AMC_ELEVENLABS_URL: fake.url }, dir);
    expect((await status(t)).providers.elevenlabs.configured).toBe(false);
  });

  test("the environment wins over the file", async () => {
    write("ELEVENLABS_API_KEY=from-file\n", 0o600);
    t = startTestHub(
      { ELEVENLABS_API_KEY: KEY, AMC_ELEVENLABS_URL: fake.url, AMC_TTS_PREWARM: "off" },
      dir,
    );
    await speak(t, { text: "Nova is on the floor.", persona });
    expect(fake.tts[0]?.key).toBe(KEY);
  });

  test("parser: comments, export, quotes, unknown names", () => {
    expect(parseSecrets("# c\n\nexport ELEVENLABS_API_KEY='abc'\nFOO=bar\n")).toEqual({
      ELEVENLABS_API_KEY: "abc",
    });
    expect(parseSecrets("ELEVENLABS_API_KEY=\n")).toEqual({});
  });
});

describe("voice matching", () => {
  const voices: ElevenVoice[] = parseVoices({ voices: VOICES });
  const pick = (voice: Parameters<typeof pickElevenVoice>[1]["voice"], seed: number) =>
    pickElevenVoice(voices, { voice, spriteSeed: seed })?.id;

  test("personas get voices whose character fits", () => {
    expect(pick("pirate", 0)).toBe("v-callum");
    expect(pick("pirate", 7)).toBe("v-callum");
    expect(pick("bureaucrat", 1)).toBe("v-sarah");
    expect(pick("robot", 5)).toBe("v-river");
    expect(["v-laura", "v-charlie"]).toContain(pick("gungho", 0) ?? "");
    expect(["v-roger"]).toContain(pick("deadpan", 4) ?? "");
  });

  test("the seed spreads personas of one voice across the matches, best score first", () => {
    // noir: Charlie (deep), Roger (resonant), George (storyteller) all score 1.
    const picks = new Set([0, 1, 2, 3, 4, 5].map((s) => pick("noir", s)));
    expect(picks).toEqual(new Set(["v-charlie", "v-george", "v-roger"]));
    expect(pick("noir", 9)).toBe(pick("noir", 9));
  });

  test("falls back to hashing over every voice when nothing scores", () => {
    const plain = parseVoices({
      voices: [
        { voice_id: "b", name: "Bea", category: "premade" },
        { voice_id: "a", name: "Al", category: "premade" },
      ],
    });
    expect(pickElevenVoice(plain, { voice: "pirate", spriteSeed: 0 })?.id).toBe("a");
    expect(pickElevenVoice(plain, { voice: "pirate", spriteSeed: 1 })?.id).toBe("b");
  });

  test("labels count as traits and clones are skipped while stock voices exist", () => {
    expect(voices.find((v) => v.id === "v-river")?.traits).toContain("neutral");
    expect(voices.some((v) => v.id === "v-me")).toBe(false);
  });
});

describe("voice per session", () => {
  let fake: Fake;
  let t: TestHub;
  let env: Record<string, string>;
  beforeEach(() => {
    fake = fakeElevenLabs();
    env = { ELEVENLABS_API_KEY: KEY, AMC_ELEVENLABS_URL: fake.url, AMC_TTS_PREWARM: "off" };
    t = startTestHub(env);
  });
  afterEach(() => {
    t.stop();
    fake.server.stop(true);
  });

  const live = async (id: string, pid: number) => {
    await t.hook("SessionStart", pid, { session_id: id, cwd: `/tmp/${id}` });
    await t.hook("UserPromptSubmit", pid, { session_id: id, prompt: "go" });
  };
  const names = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      ((await status(t)).assignments ?? []).map((a) => [a.sessionId, a.voiceName]),
    );
  const idOf = (name: string) => VOICES.find((v) => v.name === name)?.voice_id;

  test("live sessions get distinct voices; past the pool, the least used is shared", async () => {
    for (let i = 0; i < 8; i++) await live(`s${i}`, 6000 + i);
    const got = await names();
    expect(Object.keys(got).length).toBe(8);
    const first7 = [0, 1, 2, 3, 4, 5, 6].map((i) => got[`s${i}`]);
    expect(new Set(first7).size).toBe(7);
    expect(first7).not.toContain("My Clone");
  });

  test("assignments survive a hub restart and the line uses the session's voice", async () => {
    await live("a", 7001);
    await live("b", 7002);
    const before = await names();
    expect(before.a).not.toBe(before.b);
    t = restartTestHub(t, env);
    expect(await names()).toEqual(before);
    await speak(t, { text: "Hello.", sessionId: "a" });
    expect(fake.tts[0]?.voiceId).toBe(idOf(before.a ?? "") ?? "");
  });

  test("re-roll moves to another unused voice and persists", async () => {
    await live("a", 7101);
    await live("b", 7102);
    const before = await names();
    const res = await fetch(`${t.base}/api/voice/assign`, {
      method: "POST",
      headers: JSON_TYPE,
      body: JSON.stringify({ sessionId: "a", next: true }),
    });
    const body = (await res.json()) as { voiceName: string };
    expect(res.status).toBe(200);
    expect(body.voiceName).not.toBe(before.a);
    expect(body.voiceName).not.toBe(before.b);
    const after = await names();
    expect(after.a).toBe(body.voiceName);
    expect(after.b).toBe(before.b);
    t = restartTestHub(t, env);
    expect((await names()).a).toBe(body.voiceName);
  });

  test("assign: unknown session is 404, the guard applies, status carries names only", async () => {
    const r = await fetch(`${t.base}/api/voice/assign`, {
      method: "POST",
      headers: JSON_TYPE,
      body: JSON.stringify({ sessionId: "nope", next: true }),
    });
    expect(r.status).toBe(404);
    const plain = await fetch(`${t.base}/api/voice/assign`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(plain.status).toBe(415);
    await live("a", 7201);
    const s = await status(t);
    expect(Object.keys(s.assignments?.[0] ?? {}).sort()).toEqual(["sessionId", "voiceName"]);
  });
});

describe("voice variety", () => {
  test("settings jitter per seed and stay in range", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 2000; seed += 37) {
      for (const v of ["deadpan", "pirate", "robot", "gungho"] as const) {
        const s = voiceSettings(v, seed * 7919);
        expect(s.speed).toBeGreaterThanOrEqual(0.7);
        expect(s.speed).toBeLessThanOrEqual(1.2);
        for (const x of [s.stability, s.style]) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(1);
        }
        seen.add(JSON.stringify(s));
      }
    }
    expect(seen.size).toBeGreaterThan(40);
    expect(Math.abs(voiceSettings("gungho", 0x808080).speed - 1.08)).toBeLessThanOrEqual(0.08);
  });

  test("chooseVoice keeps, skips taken, re-rolls, and shares the least used", () => {
    const voices = parseVoices({ voices: VOICES });
    const ranked = rankElevenVoices(voices, { voice: "pirate", spriteSeed: 0 });
    expect(ranked[0]?.id).toBe("v-callum");
    expect(ranked.length).toBe(voices.length);
    const none = new Map<string, number>();
    expect(chooseVoice(ranked, none)?.id).toBe("v-callum");
    expect(chooseVoice(ranked, new Map([["v-callum", 1]]))?.id).toBe(ranked[1]?.id);
    expect(chooseVoice(ranked, none, "v-sarah")?.id).toBe("v-sarah");
    expect(chooseVoice(ranked, none, "v-callum", true)?.id).toBe(ranked[1]?.id);
    const all = new Map<string, number>(ranked.map((v) => [v.id, 2]));
    all.set(ranked[3]?.id ?? "", 1);
    expect(chooseVoice(ranked, all)?.id).toBe(ranked[3]?.id);
  });

  test("prewarm covers six core lines in the persona's own phrasing", () => {
    const lines = coreLines({ name: "NOVA", voice: "pirate", spriteSeed: 42 });
    expect(lines.length).toBe(6);
    expect(lines.every((l) => l.includes("Nova"))).toBe(true);
    expect(lines.join("").length).toBeLessThan(400);
    expect(coreLines({ name: "NOVA", voice: "pirate", spriteSeed: 42 })).toEqual(lines);
  });
});
