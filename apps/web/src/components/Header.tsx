import type { VoiceSettings } from "../audio/voice";
import type { Connection } from "../hub/useHub";
import { fmtClock } from "../util/time";
import { VoiceControls } from "./VoiceControls";

interface Props {
  connection: Connection;
  now: number;
  active: number;
  idle: number;
  pending: number;
  resolvedToday: number;
  audioUnlocked: boolean;
  muted: boolean;
  onAudioToggle: () => void;
  voiceSupported: boolean;
  voiceOn: boolean;
  voice: VoiceSettings;
  onVoiceToggle: () => void;
  onVoiceTest: () => void;
  /** Callsign per live session id, for the voice list in the popover. */
  callsigns: Record<string, string>;
}

const LED: Record<Connection, { tone: string; text: string }> = {
  connected: { tone: "green", text: "LINK OK" },
  connecting: { tone: "amber", text: "LINKING" },
  reconnecting: { tone: "red", text: "RELINKING" },
  mock: { tone: "amber", text: "SIMULATED" },
};

export function Header(p: Props) {
  const led = LED[p.connection];
  const audioOn = p.audioUnlocked && !p.muted;
  const audioLabel = !p.audioUnlocked ? "Enable audio" : p.muted ? "Audio off" : "Audio on";
  return (
    <header className="hdr">
      <div className="hdr__brand">
        <span className="emblem px" aria-hidden="true" />
        <span className="wordmark">MISSION CONTROL</span>
      </div>
      {p.connection === "mock" && <span className="tag tag--sim">SIM</span>}
      <span className="tag tag--link" data-tone={led.tone}>
        <span className="led" aria-hidden="true" />
        {led.text}
      </span>
      <time className="tag tag--clock" dateTime={new Date(p.now).toISOString()}>
        {fmtClock(new Date(p.now))}
      </time>

      <div className="hdr__counters">
        <Counter label="ACTIVE" value={p.active} />
        <Counter label="IDLE" value={p.idle} tone="idle" />
        <Counter label="PENDING" value={p.pending} hot={p.pending > 0} />
        <Counter label="RESOLVED TODAY" value={p.resolvedToday} />
      </div>

      <button
        type="button"
        className="btn btn--audio"
        data-audio-toggle=""
        data-on={audioOn}
        aria-pressed={audioOn}
        onClick={p.onAudioToggle}
      >
        <span className="audio-ico px" aria-hidden="true" />
        {audioLabel}
      </button>
      {p.voiceSupported && (
        <VoiceControls
          on={p.voiceOn}
          settings={p.voice}
          onToggle={p.onVoiceToggle}
          onTest={p.onVoiceTest}
          callsigns={p.callsigns}
        />
      )}
    </header>
  );
}

function Counter({
  label,
  value,
  hot,
  tone,
}: {
  label: string;
  value: number;
  hot?: boolean;
  tone?: "idle";
}) {
  return (
    <div className="counter" data-hot={hot ? "" : undefined} data-tone={tone}>
      <span className="counter__label">{label}</span>
      <span className="counter__value">{value}</span>
    </div>
  );
}
