import type { EscalationTier } from "@amc/shared";
import { useEffect, useMemo, useRef } from "react";
import { installAutoUnlock, play, setMuted, unlock, useAudio } from "./audio/synth";
import {
  announcer,
  browserVoices,
  updateVoiceSettings,
  useVoiceSettings,
  voiceSupported,
} from "./audio/voice";
import { EmptyState } from "./components/EmptyState";
import { Floor } from "./components/Floor";
import { Header } from "./components/Header";
import { MissionLog } from "./components/MissionLog";
import { useHub } from "./hub/useHub";
import { floorView, isReady } from "./util/crew";
import { stationTier, tierRank } from "./util/escalation";
import { isToday } from "./util/time";
import { useNow } from "./util/useNow";

export function App() {
  const hub = useHub();
  const audio = useAudio();
  const now = useNow(1000);

  useEffect(installAutoUnlock, []);

  const tiers = useMemo(() => {
    const out: Record<string, EscalationTier> = {};
    for (const s of hub.sessions) {
      out[s.id] = stationTier(
        s,
        hub.decisions.filter((d) => d.sessionId === s.id),
        now,
      );
    }
    return out;
  }, [hub.sessions, hub.decisions, now]);

  const anyAlarm = Object.values(tiers).includes("alarm");
  // Nested sessions folded into a parent's crew bay are crew, not operators on shift.
  const view = useMemo(() => floorView(hub.sessions, hub.decisions), [hub.sessions, hub.decisions]);
  const active = view.stations.length;
  // READY stations: finished their turn, nothing pending, no crew out. Calm, counted, never escalated.
  const readyIds = useMemo(
    () =>
      new Set(view.stations.filter((s) => isReady(s, view.decisions[s.id] ?? [])).map((s) => s.id)),
    [view],
  );
  const resolvedToday = hub.log.filter(
    (e) => e.kind === "decision_answered" && isToday(e.at),
  ).length;
  // Prose cards have nothing to pick, so they never own the number keys.
  const hotkeyDecisionId = hub.decisions.find((d) => d.source !== "prose")?.id;

  const voice = useVoiceSettings();
  const voiceOn = voiceSupported && voice.enabled && audio.unlocked && !audio.muted;
  useEffect(() => {
    announcer.configure({ active: voiceOn, events: voice.events, rate: voice.rate });
  }, [voiceOn, voice.events, voice.rate]);
  useEffect(() => {
    browserVoices.setStations(view.stations.map((s) => ({ id: s.id, seed: s.persona.spriteSeed })));
  }, [view.stations]);
  const callsigns = useMemo(
    () => Object.fromEntries(view.stations.map((s) => [s.id, s.persona.name])),
    [view.stations],
  );

  // Sound cues are driven by diffs against what we saw last render. The first snapshot
  // seeds the refs silently so a page load does not chirp for every existing operator.
  const seen = useRef<{
    seeded: boolean;
    snapshots: number;
    decisions: Set<string>;
    sessions: Set<string>;
    stations: Set<string>;
    ready: Set<string>;
    tiers: Record<string, EscalationTier>;
  }>({
    seeded: false,
    snapshots: 0,
    decisions: new Set(),
    sessions: new Set(),
    stations: new Set(),
    ready: new Set(),
    tiers: {},
  });
  useEffect(() => {
    if (!hub.hydrated) return;
    const s = seen.current;
    const decisionIds = new Set(hub.decisions.map((d) => d.id));
    // Sessions arrive engaged:false and flip on first real use; chirp at the flip, not for
    // every background claude process that starts and dies unengaged.
    const sessionIds = new Set(hub.sessions.filter((x) => x.engaged !== false).map((x) => x.id));
    const stationIds = new Set(view.stations.map((x) => x.id));
    // Voice speaks only about live deltas: a snapshot (load or reconnect) is a resync, not news.
    const speak = s.seeded && s.snapshots === hub.snapshots;
    if (s.seeded) {
      if ([...decisionIds].some((id) => !s.decisions.has(id))) play("incoming");
      if ([...sessionIds].some((id) => !s.sessions.has(id))) play("online");
      // Only a known station finishing its turn chimes; a brand-new idle one already got "online".
      if ([...readyIds].some((id) => s.sessions.has(id) && !s.ready.has(id))) play("idle");
      for (const [id, tier] of Object.entries(tiers)) {
        const prev = s.tiers[id] ?? "calm";
        if (tierRank(tier) <= tierRank(prev)) continue;
        // With voice on, reaching red is spoken instead of the klaxon; alarm keeps the klaxon.
        if (tier === "red" && voiceOn && voice.events.red && stationIds.has(id)) continue;
        play(tier === "amber" ? "tierUp" : "klaxon");
      }
    }
    if (voiceOn) {
      announcer.dropCards([...s.decisions].filter((id) => !decisionIds.has(id)));
      for (const st of view.stations) {
        if (!readyIds.has(st.id)) announcer.cancel(st.id, "idle");
        if (tierRank(tiers[st.id] ?? "calm") < tierRank("red")) announcer.cancel(st.id, "red");
      }
    }
    if (voiceOn && speak) {
      for (const st of view.stations) {
        if (!s.stations.has(st.id) && !s.sessions.has(st.id)) {
          announcer.announce("online", st.id, st.persona);
        }
        const fresh = (view.decisions[st.id] ?? []).filter((d) => !s.decisions.has(d.id));
        if (fresh.length) announcer.announce("cards", st.id, st.persona, fresh);
        if (readyIds.has(st.id) && s.sessions.has(st.id) && !s.ready.has(st.id)) {
          announcer.announce("idle", st.id, st.persona);
        }
        const prev = s.tiers[st.id] ?? "calm";
        if (tiers[st.id] === "red" && tierRank(prev) < tierRank("red")) {
          announcer.announce("red", st.id, st.persona);
        }
      }
    }
    s.seeded = true;
    s.snapshots = hub.snapshots;
    s.decisions = decisionIds;
    s.sessions = sessionIds;
    s.stations = stationIds;
    s.ready = readyIds;
    s.tiers = tiers;
  }, [
    hub.hydrated,
    hub.snapshots,
    hub.decisions,
    hub.sessions,
    view,
    tiers,
    readyIds,
    voiceOn,
    voice.events,
  ]);

  // Alarm tier nags every 30s until someone deals with it.
  useEffect(() => {
    if (!anyAlarm) return;
    const id = setInterval(() => play("klaxon"), 30_000);
    return () => clearInterval(id);
  }, [anyAlarm]);

  const onAudioToggle = () => {
    if (!audio.unlocked) {
      unlock();
      setMuted(false);
      return;
    }
    setMuted(!audio.muted);
  };

  // Turning voice on is itself a gesture, so it can unlock audio and warm up speech in one go.
  const onVoiceToggle = () => {
    if (voiceOn) {
      updateVoiceSettings({ enabled: false });
      return;
    }
    if (!audio.unlocked) unlock();
    if (audio.muted) setMuted(false);
    updateVoiceSettings({ enabled: true });
    announcer.say("Voice announcements on.", 0);
  };

  // Cycles through the stations on the floor so each click previews a different voice.
  const testIdx = useRef(0);
  const onVoiceTest = () => {
    if (!audio.unlocked) unlock();
    const pool = view.stations.length ? view.stations : [];
    const st = pool[testIdx.current++ % Math.max(1, pool.length)];
    const persona = st?.persona ?? { name: "NOVA", voice: "deadpan" as const, spriteSeed: 7391 };
    const cards = st ? (view.decisions[st.id] ?? []) : [];
    announcer.say(
      cards.length ? announcer.line(persona, "cards", cards) : announcer.line(persona, "online"),
      persona.spriteSeed,
      { stationId: st?.id ?? "", persona },
    );
  };

  return (
    <div className="app" data-alarm={anyAlarm ? "" : undefined}>
      <Header
        connection={hub.connection}
        now={now}
        active={active}
        idle={readyIds.size}
        pending={hub.decisions.length}
        resolvedToday={resolvedToday}
        audioUnlocked={audio.unlocked}
        muted={audio.muted}
        onAudioToggle={onAudioToggle}
        voiceSupported={voiceSupported}
        voiceOn={voiceOn}
        voice={voice}
        onVoiceToggle={onVoiceToggle}
        onVoiceTest={onVoiceTest}
        callsigns={callsigns}
      />
      <main className="main">
        {hub.sessions.length === 0 ? (
          <EmptyState loading={!hub.hydrated && hub.connection !== "reconnecting"} />
        ) : (
          <Floor
            sessions={hub.sessions}
            decisions={hub.decisions}
            activity={hub.activity}
            recent={hub.recent}
            hotkeyDecisionId={hotkeyDecisionId}
            now={now}
            onAnswer={hub.answer}
            onDismiss={hub.dismiss}
            onMessage={hub.sendMessage}
            onTransmitted={() => play("transmitted")}
          />
        )}
        <MissionLog log={hub.log} />
      </main>
      <div className="crt" aria-hidden="true" />
      <div className="edge" aria-hidden="true" />
    </div>
  );
}
