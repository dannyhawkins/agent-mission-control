import type { SpeakFailure, SpeakRequest, VoiceProvider } from "@amc/shared";
import type { Speaker, Utterance } from "./voice";

/**
 * Speaker that plays hub-rendered ElevenLabs audio (POST /api/voice/speak) and drops to the
 * browser voice for any line it cannot get: hub down, no key, cap reached, upstream error,
 * autoplay refusal. Same contract as the browser speaker: `done` exactly once per line.
 */

/** The bits of HTMLAudioElement we use, so tests can stub it. */
export type AudioLike = Pick<
  HTMLAudioElement,
  "playbackRate" | "play" | "pause" | "onended" | "onerror"
>;

export interface HubSpeakerDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  makeAudio: (url: string) => AudioLike;
  objectUrl: { create(b: Blob): string; revoke(url: string): void };
  fallback: Speaker;
  /** A line went to the browser voice instead; `reason` is short and shown in the popover. */
  onFallback: (reason: string) => void;
  /** Upper bound on the fetch. Cache hits take milliseconds, misses usually under a second. */
  fetchTimeoutMs?: number;
}

interface Line {
  abort: AbortController;
  audio?: AudioLike;
  url?: string;
  cancelled: boolean;
  /** Ends the line: stops audio, frees the blob URL, calls `done` once. */
  end: () => void;
}

export function hubSpeaker(deps: HubSpeakerDeps): Speaker {
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? 10_000;
  let current: Line | null = null;

  return {
    speak(u: Utterance, done) {
      let over = false;
      const line: Line = {
        abort: new AbortController(),
        cancelled: false,
        end: () => {
          if (over) return;
          over = true;
          clearTimeout(guard);
          line.audio?.pause();
          if (line.url) deps.objectUrl.revoke(line.url);
          if (current === line) current = null;
          done();
        },
      };
      current = line;
      const fallBack = (reason: string) => {
        if (over) return;
        if (line.cancelled) {
          line.end();
          return;
        }
        over = true;
        clearTimeout(guard);
        if (line.url) deps.objectUrl.revoke(line.url);
        if (current === line) current = null;
        deps.onFallback(reason);
        deps.fallback.speak(u, done);
      };
      // Never let the queue jam on a stuck fetch or an audio element that never ends.
      const guard = setTimeout(
        () => (line.audio ? line.end() : fallBack("timed out")),
        fetchTimeoutMs + 4_000 + u.text.length * 150,
      );
      const fetchTimer = setTimeout(() => line.abort.abort(), fetchTimeoutMs);

      const body: SpeakRequest = {
        text: u.text,
        ...(u.stationId ? { sessionId: u.stationId } : {}),
        persona: { voice: u.voice, spriteSeed: u.seed },
      };
      deps
        .fetch("/api/voice/speak", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: line.abort.signal,
        })
        .then(async (res) => {
          if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("audio/")) {
            const fail = (await res.json().catch(() => undefined)) as SpeakFailure | undefined;
            fallBack(reasonText(fail?.reason, res.status));
            return;
          }
          const blob = await res.blob();
          clearTimeout(fetchTimer);
          if (over) return;
          line.url = deps.objectUrl.create(blob);
          const audio = deps.makeAudio(line.url);
          line.audio = audio;
          // The rate slider scales playback, so one cached file serves every rate.
          audio.playbackRate = u.speed;
          audio.onended = line.end;
          audio.onerror = () => fallBack("audio error");
          await audio.play().catch(() => fallBack("playback blocked"));
        })
        .catch(() => fallBack(line.abort.signal.aborted ? "hub timed out" : "hub unreachable"))
        .finally(() => clearTimeout(fetchTimer));
    },
    cancel() {
      const line = current;
      current = null;
      if (line) {
        line.cancelled = true;
        line.abort.abort();
        line.end();
      }
      deps.fallback.cancel();
    },
  };
}

function reasonText(reason: SpeakFailure["reason"] | undefined, status: number): string {
  switch (reason) {
    case "not_configured":
      return "no ElevenLabs key";
    case "cap_reached":
      return "daily cap reached";
    case "timeout":
      return "ElevenLabs timed out";
    case "upstream":
      return "ElevenLabs error";
    case "no_voice":
      return "no ElevenLabs voices";
    default:
      return `hub answered ${status}`;
  }
}

/** Routes each line to the provider selected right now, so switching takes effect at once. */
export function providerSpeaker(
  pick: () => VoiceProvider,
  speakers: Record<VoiceProvider, Speaker>,
): Speaker {
  return {
    speak(u, done) {
      (speakers[pick()] ?? speakers.browser).speak(u, done);
    },
    cancel() {
      for (const s of Object.values(speakers)) s.cancel();
    },
  };
}
