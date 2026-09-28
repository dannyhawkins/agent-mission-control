import type { VoiceProvider, VoiceStatus } from "@amc/shared";
import { useEffect, useRef, useState } from "react";
import type { VoiceEvent } from "../audio/phrases";
import {
  updateVoiceSettings,
  useVoiceFallback,
  type VoiceFallback,
  type VoiceSettings,
} from "../audio/voice";

interface Props {
  on: boolean;
  settings: VoiceSettings;
  onToggle: () => void;
  onTest: () => void;
  callsigns: Record<string, string>;
}

const EVENTS: { key: VoiceEvent; label: string; hint: string }[] = [
  { key: "cards", label: "New cards", hint: "Pepper has a question" },
  { key: "idle", label: "Standing by", hint: "Pepper is standing by" },
  { key: "red", label: "Waiting red", hint: "Pepper has been waiting five minutes" },
  { key: "online", label: "New sessions", hint: "Nova is on the floor" },
];

/** VOICE toggle plus its settings popover, sitting next to the audio toggle in the header. */
export function VoiceControls({ on, settings, onToggle, onTest, callsigns }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const fallback = useVoiceFallback();
  const [status, setStatus] = useState<VoiceStatus | "loading" | "unreachable">("loading");
  const [refresh, setRefresh] = useState(0);
  const [rolling, setRolling] = useState<string | null>(null);
  const eleven = typeof status === "object" ? status.providers.elevenlabs : undefined;

  // Asked on every open (and after each fallback or re-roll) so a key added or rotated on the
  // hub shows up without a reload; the hub re-reads secrets.env on this request.
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch("/api/voice/status")
      .then((r) => (r.ok ? (r.json() as Promise<VoiceStatus>) : Promise.reject()))
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus("unreachable"));
    return () => {
      live = false;
    };
  }, [open, fallback, refresh]);

  const reroll = (sessionId: string) => {
    setRolling(sessionId);
    fetch("/api/voice/assign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, next: true }),
    })
      .catch(() => {})
      .finally(() => {
        setRolling(null);
        setRefresh((n) => n + 1);
      });
  };
  const assignments =
    settings.provider === "elevenlabs" && typeof status === "object"
      ? (status.assignments ?? []).filter((a) => callsigns[a.sessionId])
      : [];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrap.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="voice" ref={wrap}>
      <button
        type="button"
        className="btn btn--voice"
        data-audio-toggle=""
        data-on={on}
        aria-pressed={on}
        onClick={onToggle}
      >
        {on ? "Voice on" : "Voice off"}
      </button>
      <button
        type="button"
        className="btn btn--voice-cfg"
        aria-label="Voice settings"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="voice-pop" role="dialog" aria-label="Voice settings">
          <label className="voice-pop__provider">
            <span className="voice-pop__title">PROVIDER</span>
            <select
              value={settings.provider}
              onChange={(e) =>
                updateVoiceSettings({ provider: e.currentTarget.value as VoiceProvider })
              }
            >
              <option value="browser">Browser</option>
              <option value="elevenlabs" disabled={!eleven?.configured}>
                ElevenLabs
              </option>
            </select>
          </label>
          <ProviderStatus status={status} provider={settings.provider} fallback={fallback} />
          {assignments.length > 0 && (
            <ul className="voice-pop__voices" aria-label="Station voices">
              {assignments.map((a) => (
                <li key={a.sessionId}>
                  <span className="voice-pop__callsign">{callsigns[a.sessionId]}</span>
                  <span className="voice-pop__voice" title={a.voiceName}>
                    {a.voiceName.split(" - ")[0]}
                  </span>
                  <button
                    type="button"
                    className="btn btn--reroll"
                    disabled={rolling !== null}
                    title="Give this station a different voice"
                    onClick={() => reroll(a.sessionId)}
                  >
                    reroll
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="voice-pop__title">ANNOUNCE</div>
          {EVENTS.map((ev) => (
            <label key={ev.key} className="voice-pop__row" title={`"${ev.hint}"`}>
              <input
                type="checkbox"
                checked={settings.events[ev.key]}
                onChange={(e) =>
                  updateVoiceSettings({
                    events: { ...settings.events, [ev.key]: e.currentTarget.checked },
                  })
                }
              />
              <span>{ev.label}</span>
            </label>
          ))}
          <label className="voice-pop__rate">
            <span className="voice-pop__title">RATE</span>
            <input
              type="range"
              min={0.7}
              max={1.5}
              step={0.05}
              value={settings.rate}
              onChange={(e) => updateVoiceSettings({ rate: Number(e.currentTarget.value) })}
            />
            <span className="voice-pop__num">{settings.rate.toFixed(2)}x</span>
          </label>
          <button type="button" className="btn btn--test" onClick={onTest}>
            Test voice
          </button>
          {!on && <p className="voice-pop__note">Voice is off. Only the test line plays.</p>}
        </div>
      )}
    </div>
  );
}

/** Dim lines under the provider select: why ElevenLabs is off, today's usage, last fallback. */
function ProviderStatus({
  status,
  provider,
  fallback,
}: {
  status: VoiceStatus | "loading" | "unreachable";
  provider: VoiceProvider;
  fallback: VoiceFallback | null;
}) {
  if (status === "loading") return <p className="voice-pop__note">Checking the hub...</p>;
  if (status === "unreachable")
    return <p className="voice-pop__note">Hub unreachable. Browser voice only.</p>;
  const eleven = status.providers.elevenlabs;
  if (!eleven.configured) {
    return (
      <p
        className="voice-pop__note"
        title="Put ELEVENLABS_API_KEY=... in ~/.agent-mission-control/secrets.env (chmod 600), or in the hub's environment"
      >
        Set ELEVENLABS_API_KEY for the hub to enable ElevenLabs.
      </p>
    );
  }
  const n = (x: number) => x.toLocaleString("en-US");
  return (
    <>
      {eleven.error && <p className="voice-pop__note voice-pop__note--warn">{eleven.error}</p>}
      <p className="voice-pop__note">
        ElevenLabs today: {n(status.dailyCharsUsed)} / {n(status.dailyCharsCap)} chars
      </p>
      {provider === "elevenlabs" && fallback && Date.now() - fallback.at < 10 * 60_000 && (
        <p className="voice-pop__note voice-pop__note--warn">
          Fell back to browser voice: {fallback.reason}
        </p>
      )}
    </>
  );
}
