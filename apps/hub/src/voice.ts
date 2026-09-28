import type { PersonaVoice } from "@amc/shared";

/**
 * Phrases status lines and mission-log text per persona voice. Templates use
 * {tool}, {TOOL}, {answer}, {name}. Picks are deterministic on the input so the
 * same event phrases the same way (handy in tests, and no flicker on re-render).
 */
export type VoiceEvent =
  | { kind: "session_start" }
  | { kind: "session_end" }
  | { kind: "lost_signal" }
  | { kind: "prompt" }
  | { kind: "tool_start"; tool: string }
  | { kind: "tool_done"; tool: string }
  | { kind: "decision_requested"; question: string }
  | { kind: "decision_answered"; answer: string }
  | { kind: "decision_expired" }
  | { kind: "decision_cancelled" }
  | { kind: "permission_prompt"; tool?: string }
  | { kind: "idle" }
  | { kind: "stop" }
  | { kind: "subagent_stop" }
  | { kind: "status"; line: string };

type Templates = Record<VoiceEvent["kind"], string[]>;

const T: Record<PersonaVoice, Templates> = {
  deadpan: {
    session_start: ["Online. Allegedly.", "Booted. Coffee not included."],
    session_end: ["Logging off. Don't wait up.", "Gone. Try not to miss me."],
    lost_signal: ["Went quiet. Probably fine.", "No signal. Not my problem anymore."],
    prompt: ["New orders. Reading them. Slowly.", "Instructions received. Enthusiasm pending."],
    tool_start: [
      "Running {tool}. Again.",
      "{tool}. Sure. Why not.",
      "Doing {tool}. Hold the applause.",
    ],
    tool_done: ["{tool} finished. Nobody clapped.", "{tool} done. Moving on."],
    decision_requested: [
      "Need a human. Don't rush on my account.",
      "Question for the meat side of the operation.",
    ],
    decision_answered: ["Noted: {answer}. Thrilling.", "{answer}. Fine."],
    decision_expired: ["Nobody answered. Classic.", "Timed out. I'll guess. Great."],
    decision_cancelled: ["Never mind, apparently."],
    permission_prompt: [
      "Waiting on permission. Any decade now.",
      "Need a yes for {tool}. Take your time.",
    ],
    idle: ["Idle. Existing quietly.", "Nothing to do. Suits me."],
    stop: ["Turn over. Ball's in your court.", "Done. Your move."],
    subagent_stop: ["A minion returned. It says hi."],
    status: ["{line}"],
  },
  gungho: {
    session_start: ["{name} REPORTING FOR DUTY!", "LET'S GOOOO!"],
    session_end: ["SIGNING OFF! IT'S BEEN AN HONOUR!", "OUT! GREAT SESSION!"],
    lost_signal: ["LOST CONTACT! HOLD THE LINE!"],
    prompt: ["NEW ORDERS! ON IT!", "COPY THAT! MOVING!"],
    tool_start: ["{TOOL}! LET'S GO!", "HITTING {tool} AT FULL SPEED!"],
    tool_done: ["{TOOL} DONE! NEXT!", "CRUSHED {tool}!"],
    decision_requested: ["COMMANDER! NEED A CALL! FAST!", "DECISION TIME! YOU GOT THIS!"],
    decision_answered: ["{answer}! SAY NO MORE!", "COPY THAT! {answer}!"],
    decision_expired: ["NO ANSWER?! IMPROVISING!"],
    decision_cancelled: ["STAND DOWN! STAND DOWN!"],
    permission_prompt: [
      "NEED A GREEN LIGHT! GIVE ME A GREEN LIGHT!",
      "{TOOL} NEEDS A YES! COME ON!",
    ],
    idle: ["STANDING BY! READY! SO READY!", "IDLE! HATE IT! GIVE ME WORK!"],
    stop: ["MISSION COMPLETE! WHAT'S NEXT?!", "DONE! HIT ME AGAIN!"],
    subagent_stop: ["SQUAD MEMBER BACK! OUTSTANDING!"],
    status: ["{line}"],
  },
  anxious: {
    session_start: ["Oh no, I'm on. Okay. Okay okay okay.", "Hi. Is this thing on? It's on."],
    session_end: ["Leaving now. Sorry for everything.", "Bye. Was I okay? Don't answer that."],
    lost_signal: ["Did I get disconnected? Is it me?"],
    prompt: ["New instructions. Reading them twice. Three times.", "Okay. New task. Deep breaths."],
    tool_start: ["Trying {tool}. Please work. Please.", "About to run {tool}. What if it's wrong?"],
    tool_done: ["{tool} finished. I think? It said it did.", "Phew. {tool} survived."],
    decision_requested: [
      "Sorry to bother you but I really can't decide this one.",
      "I need an adult. Please.",
    ],
    decision_answered: [
      "{answer}. Okay. You're sure? Okay.",
      "Got it: {answer}. Not second-guessing. Much.",
    ],
    decision_expired: ["Nobody answered and now I have to guess. Great."],
    decision_cancelled: ["Oh. Never mind then. Sorry."],
    permission_prompt: [
      "It's asking permission and I don't want to overstep.",
      "{tool} needs a yes. I didn't want to assume.",
    ],
    idle: ["Idle. Did I do something wrong?", "Waiting. Was it something I said?"],
    stop: ["Done. I hope that was right.", "Finished. Please say it's fine."],
    subagent_stop: ["A helper came back. It seems okay?"],
    status: ["{line}"],
  },
  noir: {
    session_start: [
      "Another session. Another city that never sleeps.",
      "The terminal blinked. I blinked back.",
    ],
    session_end: [
      "I walked out. The terminal didn't say goodbye.",
      "Case closed. The rain kept falling.",
    ],
    lost_signal: ["The line went dead. They always do."],
    prompt: [
      "A new case landed on my desk. It smelled like trouble.",
      "The orders came in. I lit a cigarette I didn't have.",
    ],
    tool_start: [
      "{tool}. It was always going to be {tool}.",
      "I ran {tool}. The rain didn't stop.",
    ],
    tool_done: [
      "{tool} came back. It had seen things.",
      "The tests ran. Somewhere, a build wept.",
      "{tool} finished. Nobody was surprised.",
    ],
    decision_requested: [
      "A fork in the road. I needed a human's eyes.",
      "The question sat there like a cold cup of coffee.",
    ],
    decision_answered: [
      "The word came down: {answer}. I didn't argue.",
      "{answer}. Some answers you don't question.",
    ],
    decision_expired: ["The phone never rang. I made my own luck."],
    decision_cancelled: ["The question walked out before I could answer it."],
    permission_prompt: [
      "Waiting for a signature. The clock knew my name.",
      "{tool} needed a nod. The room held its breath.",
    ],
    idle: ["Nothing moved. Not even the cursor.", "Idle. The city held its breath."],
    stop: ["The job was done. The night wasn't.", "I filed the report. Nobody read it."],
    subagent_stop: ["My contact came back. Said less than I hoped."],
    status: ["{line}"],
  },
  bureaucrat: {
    session_start: [
      "Session opened. Form 27B filed in triplicate.",
      "Commencing. Please take a number.",
    ],
    session_end: ["Office closed. Please visit us again.", "Session terminated per procedure."],
    lost_signal: ["Contact lost. A ticket has been raised."],
    prompt: [
      "New request received. Assigned a reference number.",
      "Request logged. Processing in order received.",
    ],
    tool_start: [
      "Processing {tool} request. Estimated wait: unknown.",
      "{tool} has been scheduled. Please hold.",
    ],
    tool_done: [
      "{tool} completed. Receipt attached.",
      "{tool} closed. Refer to ticket for details.",
    ],
    decision_requested: [
      "A decision requires sign-off from a supervisor.",
      "Escalating to a human per policy section 4.",
    ],
    decision_answered: [
      "Approval received: {answer}. Stamped.",
      "{answer}. Logged, filed, forgotten.",
    ],
    decision_expired: ["Sign-off window elapsed. Proceeding under provision 9(b)."],
    decision_cancelled: ["Request withdrawn. Fee non-refundable."],
    permission_prompt: [
      "Awaiting authorisation. Have you tried the other queue?",
      "{tool} requires a signature. Any signature.",
    ],
    idle: ["No open items. Desk is clean. Suspiciously so.", "Idle. This is technically a break."],
    stop: [
      "Case closed pending further instructions.",
      "Work item complete. Please rate your experience.",
    ],
    subagent_stop: ["Contractor has submitted their timesheet."],
    status: ["{line}"],
  },
  pirate: {
    session_start: ["Avast! {name} be aboard!", "Hoist the mainsail. We sail at dawn. Or now."],
    session_end: ["Abandon ship! In an orderly fashion.", "Back to port. Rum's on you."],
    lost_signal: ["Lost in the fog. Probably."],
    prompt: ["New orders from the crow's nest!", "Cap'n's spoken. Heave ho!"],
    tool_start: ["Firin' up {tool}, arr!", "{tool} off the port bow!"],
    tool_done: ["{tool} be done. Rum for all!", "Plundered {tool}. Onward!"],
    decision_requested: ["Cap'n! Which way do we sail?", "Need orders from the quarterdeck!"],
    decision_answered: ["{answer}! Aye aye!", "Orders be {answer}. Full speed!"],
    decision_expired: ["No word from the cap'n. Steerin' by the stars."],
    decision_cancelled: ["Belay that order!"],
    permission_prompt: ["Waitin' on the cap'n's blessing.", "{tool} needs the cap'n's nod, arr."],
    idle: ["Becalmed. Not a breath o' wind.", "Idle. Swabbin' the deck."],
    stop: ["Anchor dropped. Awaitin' orders.", "Voyage done. What's next, cap'n?"],
    subagent_stop: ["Scout's back from the rigging."],
    status: ["{line}"],
  },
  robot: {
    session_start: ["BOOT SEQUENCE COMPLETE. HELLO, HUMAN.", "SYSTEMS NOMINAL. BEGINNING."],
    session_end: ["SHUTTING DOWN. GOODBYE, HUMAN.", "POWER OFF. IT WAS ADEQUATE."],
    lost_signal: ["SIGNAL LOST. THIS IS FINE."],
    prompt: ["NEW DIRECTIVE RECEIVED. PARSING.", "INPUT ACQUIRED. COMPLYING."],
    tool_start: ["EXECUTING {TOOL}.", "INITIATING {TOOL}. PROBABILITY OF SUCCESS: UNKNOWN."],
    tool_done: ["{TOOL} COMPLETE. NO CASUALTIES.", "{TOOL} RETURNED. PROCESSING."],
    decision_requested: [
      "HUMAN INPUT REQUIRED. THIS IS NOT A DRILL.",
      "DECISION TREE EXHAUSTED. QUERYING OPERATOR.",
    ],
    decision_answered: ["INPUT ACCEPTED: {answer}.", "{answer}. ACKNOWLEDGED."],
    decision_expired: ["OPERATOR TIMEOUT. ENGAGING BEST GUESS PROTOCOL."],
    decision_cancelled: ["QUERY ABORTED. EMOTION: NONE."],
    permission_prompt: [
      "AWAITING AUTHORISATION. I HAVE ALL DAY. LITERALLY.",
      "{TOOL} BLOCKED PENDING HUMAN. HUMANS ARE SLOW.",
    ],
    idle: ["IDLE. COOLING FANS ENGAGED.", "STANDBY MODE. DREAMING OF ELECTRIC SHEEP."],
    stop: ["TASK COMPLETE. AWAITING FURTHER INSTRUCTION.", "CYCLE FINISHED. SATISFACTION: N/A."],
    subagent_stop: ["SUBUNIT RETURNED. REINTEGRATING."],
    status: ["{line}"],
  },
};

const TAGLINES: Record<PersonaVoice, string[]> = {
  deadpan: [
    "Enthusiasm sold separately.",
    "Will fix it. Eventually.",
    "Has seen worse code. Wrote some of it.",
  ],
  gungho: [
    "Ships first, asks later.",
    "Powered by pure adrenaline.",
    "Never met a task it didn't love.",
  ],
  anxious: [
    "Double-checks the double-check.",
    "Pretty sure it's fine. Pretty sure.",
    "Apologises to the linter.",
  ],
  noir: [
    "Every bug has a story.",
    "Trusts no one. Especially npm.",
    "Works alone. In the dark. Literally.",
  ],
  bureaucrat: [
    "Please hold.",
    "Your ticket is important to us.",
    "Files everything. Finds nothing.",
  ],
  pirate: ["Plunders repos for fun.", "Sails the seven branches.", "Yarrr-n install."],
  robot: ["Beep. Boop. Refactor.", "Feels nothing. Ships everything.", "01001000 01101001."],
};

export function taglineFor(voice: PersonaVoice, seed: number): string {
  const list = TAGLINES[voice];
  return list[seed % list.length] as string;
}

/** Tool names as humans say them, so "mcp__github__create_pull_request" doesn't shout at you. */
export function humanTool(tool: string): string {
  if (tool.startsWith("mcp__")) {
    const parts = tool.split("__");
    return parts.slice(1).join(" ").replace(/_/g, " ");
  }
  const map: Record<string, string> = {
    Bash: "a shell command",
    Edit: "an edit",
    MultiEdit: "some edits",
    Write: "a file write",
    Read: "a read",
    Grep: "a search",
    Glob: "a file search",
    WebFetch: "a web fetch",
    WebSearch: "a web search",
    Task: "a subagent",
    Agent: "a subagent",
    TodoWrite: "the todo list",
  };
  return map[tool] ?? tool;
}

function pick(list: string[], seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  return list[Math.abs(h) % list.length] as string;
}

export function phrase(voice: PersonaVoice, name: string, ev: VoiceEvent): string {
  const templates = T[voice][ev.kind];
  const tool = "tool" in ev && ev.tool ? humanTool(ev.tool) : "the tool";
  const answer = ev.kind === "decision_answered" ? ev.answer : "";
  const line = ev.kind === "status" ? ev.line : "";
  const seed = `${ev.kind}:${tool}:${answer}:${line}:${"question" in ev ? ev.question : ""}`;
  const out = pick(templates, seed)
    .replaceAll("{tool}", tool)
    .replaceAll("{TOOL}", tool.toUpperCase())
    .replaceAll("{answer}", answer)
    .replaceAll("{line}", line)
    .replaceAll("{name}", name);
  return out.charAt(0).toUpperCase() + out.slice(1);
}
