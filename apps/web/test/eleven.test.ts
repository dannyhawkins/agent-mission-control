import { describe, expect, test } from "bun:test";
import type { VoiceProvider } from "@amc/shared";
import { type AudioLike, hubSpeaker, providerSpeaker } from "../src/audio/eleven";
import { BrowserVoiceAssigner, coreLines, pickVoice, voiceShape } from "../src/audio/phrases";
import { Announcer, type Speaker, type Utterance } from "../src/audio/voice";

const line = (extra: Partial<Utterance> = {}): Utterance => ({
  text: "Nova is on the floor.",
  seed: 7,
  pitch: 1,
  rate: 1.1,
  speed: 1.25,
  voice: "pirate",
  stationId: "s1",
  ...extra,
});

function fakeAudio() {
  const made: (AudioLike & { src: string; playing: boolean })[] = [];
  let playResult: () => Promise<void> = () => Promise.resolve();
  return {
    made,
    failPlay() {
      playResult = () => Promise.reject(new Error("NotAllowedError"));
    },
    make(url: string): AudioLike {
      const a = {
        src: url,
        playing: false,
        playbackRate: 1,
        onended: null,
        onerror: null,
        play() {
          a.playing = true;
          return playResult();
        },
        pause() {
          a.playing = false;
        },
      } as unknown as AudioLike & { src: string; playing: boolean };
      made.push(a);
      return a;
    },
  };
}

function recorder(): Speaker & { said: string[] } {
  const said: string[] = [];
  return {
    said,
    speak(u, done) {
      said.push(u.text);
      done();
    },
    cancel() {},
  };
}

const audioResponse = () =>
  new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
const flush = () => new Promise((r) => setTimeout(r, 0));

function rig(respond: (body: Record<string, unknown>) => Promise<Response>) {
  const audio = fakeAudio();
  const browser = recorder();
  const fallbacks: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const revoked: string[] = [];
  const speaker = hubSpeaker({
    fetch: (_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      return respond(body);
    },
    makeAudio: (u) => audio.make(u),
    objectUrl: { create: () => `blob:${bodies.length}`, revoke: (u) => revoked.push(u) },
    fallback: browser,
    onFallback: (r) => fallbacks.push(r),
  });
  return { speaker, audio, browser, fallbacks, bodies, revoked };
}

describe("ElevenLabs speaker", () => {
  test("plays hub audio at the operator's rate and finishes on ended", async () => {
    const r = rig(async () => audioResponse());
    let done = 0;
    r.speaker.speak(line(), () => done++);
    await flush();
    await flush();
    expect(r.bodies[0]).toEqual({
      text: "Nova is on the floor.",
      sessionId: "s1",
      persona: { voice: "pirate", spriteSeed: 7 },
    });
    const a = r.audio.made[0];
    expect(a?.playbackRate).toBe(1.25);
    expect(a?.playing).toBe(true);
    expect(done).toBe(0);
    a?.onended?.(new Event("ended"));
    expect(done).toBe(1);
    expect(r.revoked).toEqual(["blob:1"]);
    expect(r.browser.said).toEqual([]);
  });

  test("a hub refusal falls back to the browser voice for that line", async () => {
    const r = rig(async () =>
      Response.json({ error: "cap", reason: "cap_reached" }, { status: 409 }),
    );
    let done = 0;
    r.speaker.speak(line(), () => done++);
    await flush();
    await flush();
    expect(r.browser.said).toEqual(["Nova is on the floor."]);
    expect(r.fallbacks).toEqual(["daily cap reached"]);
    expect(done).toBe(1);
  });

  test("hub down and blocked playback fall back too", async () => {
    const down = rig(() => Promise.reject(new TypeError("fetch failed")));
    let done = 0;
    down.speaker.speak(line(), () => done++);
    await flush();
    expect(down.fallbacks).toEqual(["hub unreachable"]);
    expect(done).toBe(1);

    const blocked = rig(async () => audioResponse());
    blocked.audio.failPlay();
    blocked.speaker.speak(line(), () => done++);
    await flush();
    await flush();
    await flush();
    expect(blocked.fallbacks).toEqual(["playback blocked"]);
    expect(blocked.browser.said.length).toBe(1);
    expect(done).toBe(2);
  });

  test("cancel stops the line, calls done once, and never falls back", async () => {
    let release: (r: Response) => void = () => {};
    const r = rig(
      (_b) =>
        new Promise<Response>((resolve, reject) => {
          release = resolve;
          void reject;
        }),
    );
    let done = 0;
    r.speaker.speak(line(), () => done++);
    r.speaker.cancel();
    expect(done).toBe(1);
    release(audioResponse());
    await flush();
    await flush();
    expect(done).toBe(1);
    expect(r.fallbacks).toEqual([]);
    expect(r.audio.made.length).toBe(0);
  });
});

describe("provider switching", () => {
  test("each line goes to the provider selected at that moment", () => {
    const browser = recorder();
    const eleven = recorder();
    let provider: VoiceProvider = "browser";
    const s = providerSpeaker(() => provider, { browser, elevenlabs: eleven });
    s.speak(line({ text: "one" }), () => {});
    provider = "elevenlabs";
    s.speak(line({ text: "two" }), () => {});
    expect(browser.said).toEqual(["one"]);
    expect(eleven.said).toEqual(["two"]);
  });

  test("the announcer passes persona voice, station and rate through", () => {
    const got: Utterance[] = [];
    const a = new Announcer({ speak: (u, done) => (got.push(u), done()), cancel: () => {} });
    a.configure({
      active: true,
      events: { cards: true, idle: true, red: true, online: true },
      rate: 1.2,
    });
    a.announce("online", "s9", { name: "NOVA", voice: "robot", spriteSeed: 5 });
    a.say("Test.", 3, { stationId: "s8", persona: { name: "X", voice: "noir", spriteSeed: 3 } });
    expect(got[0]).toMatchObject({ stationId: "s9", voice: "robot", seed: 5, speed: 1.2 });
    expect(got[1]).toMatchObject({ stationId: "s8", voice: "noir", text: "Test." });
  });
});

describe("browser voice tiers", () => {
  const v = (name: string, lang = "en-US", localService = true) => ({
    name,
    lang,
    localService,
    voiceURI: name,
  });

  test("Premium beats Enhanced beats the rest, deterministic inside the tier", () => {
    const voices = [
      v("Samantha"),
      v("Evan (Enhanced)"),
      v("Ava (Premium)"),
      v("Zoe (Premium)"),
      v("Zarvox"),
    ];
    expect(pickVoice(voices, 0)?.name).toBe("Ava (Premium)");
    expect(pickVoice(voices, 1)?.name).toBe("Zoe (Premium)");
    expect(pickVoice(voices, 2)?.name).toBe("Ava (Premium)");
    const noPremium = voices.filter((x) => !x.name.includes("Premium"));
    expect(pickVoice(noPremium, 5)?.name).toBe("Evan (Enhanced)");
    expect(pickVoice([v("Samantha"), v("Daniel", "en-GB")], 0)?.name).toBe("Daniel");
  });

  test("tiers are English only and novelty voices never qualify", () => {
    const voices = [v("Amélie (Premium)", "fr-CA"), v("Samantha")];
    expect(pickVoice(voices, 0)?.name).toBe("Samantha");
    expect(pickVoice([v("Bells (Premium)"), v("Samantha")], 0)?.name).toBe("Samantha");
  });

  test("live stations get distinct voices, keep them, and share the least used past the pool", () => {
    const voices = [v("Ava (Premium)"), v("Evan (Enhanced)"), v("Samantha"), v("Daniel", "en-GB")];
    const a = new BrowserVoiceAssigner();
    // Same seed for everyone: without assignment they would all get the same voice.
    const st = (id: string) => ({ id, seed: 0 });
    a.setStations([st("s1"), st("s2"), st("s3")]);
    const got = ["s1", "s2", "s3"].map((id) => a.voiceFor(id, 0, voices)?.name);
    expect(got).toEqual(["Ava (Premium)", "Evan (Enhanced)", "Daniel"]);
    // A station leaving frees its voice; the others keep theirs.
    a.setStations([st("s2"), st("s3"), st("s4")]);
    expect(a.voiceFor("s2", 0, voices)?.name).toBe("Evan (Enhanced)");
    expect(a.voiceFor("s4", 0, voices)?.name).toBe("Ava (Premium)");
    a.setStations([st("s2"), st("s3"), st("s4"), st("s5"), st("s6")]);
    expect(a.voiceFor("s5", 0, voices)?.name).toBe("Samantha");
    const s6 = a.voiceFor("s6", 0, voices)?.name;
    expect(voices.map((x) => x.name)).toContain(s6 ?? "");
    // Unknown station (a test line): plain per-seed pick.
    expect(a.voiceFor("zz", 0, voices)?.name).toBe("Ava (Premium)");
  });

  test("pitch and rate spread by seed within 0.8..1.25 and 0.9..1.1", () => {
    const shapes = Array.from({ length: 4000 }, (_, i) => voiceShape(i * 131));
    const p = shapes.map((s) => s.pitch);
    const r = shapes.map((s) => s.rate);
    expect(Math.min(...p)).toBeCloseTo(0.8);
    expect(Math.max(...p)).toBeCloseTo(1.25);
    expect(Math.min(...r)).toBeCloseTo(0.9);
    expect(Math.max(...r)).toBeCloseTo(1.1);
  });

  test("each persona keeps one phrasing, the one the hub pre-renders", () => {
    const a = new Announcer({ speak: (_u, done) => done(), cancel: () => {} });
    const pirate = { name: "NOVA", voice: "pirate" as const, spriteSeed: 42 };
    const online = a.line(pirate, "online");
    expect(a.line(pirate, "online")).toBe(online);
    expect(coreLines(pirate)).toContain(online);
    expect(coreLines(pirate)).toContain(a.line(pirate, "idle"));
  });
});
