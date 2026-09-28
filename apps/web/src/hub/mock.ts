import type {
  CrewMember,
  Decision,
  DecisionAnswerBody,
  LogEntry,
  LogKind,
  Persona,
  PersonaVoice,
  ServerEvent,
  Session,
  SessionStatus,
} from "@amc/shared";
import { MessageError } from "./errors";

/**
 * In-memory simulator so the floor can be developed and demoed without the hub.
 * It speaks the same ServerEvent stream the hub would, so nothing downstream knows.
 */
export interface MockHub {
  answer: (decisionId: string, body: DecisionAnswerBody) => Promise<void>;
  dismiss: (decisionId: string) => Promise<void>;
  sendMessage: (sessionId: string, text: string) => Promise<void>;
  stop: () => void;
}

type Dispatch = (ev: ServerEvent) => void;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const nowIso = () => new Date().toISOString();
let seq = 0;
const id = (p: string) => `${p}_${(++seq).toString(36)}${Date.now().toString(36).slice(-3)}`;

const persona = (
  name: string,
  color: Persona["color"],
  voice: PersonaVoice,
  spriteSeed: number,
  tagline: string,
): Persona => ({ sessionId: "", name, color, voice, spriteSeed, tagline });

const LINES: Record<PersonaVoice, string[]> = {
  deadpan: [
    "Reading src/auth/session.ts. It is exactly as bad as I expected.",
    "Ran the tests. Twelve pass. One is having a moment.",
    "Editing the reducer. Again.",
    "Grepping for the bug. The bug is grepping for me.",
    "Someone left a TODO from 2023. I have adopted it.",
    "Formatting with Biome. It had opinions.",
  ],
  pirate: [
    "Hoistin' the new migration up the mast, arr.",
    "Plunderin' node_modules for a type definition.",
    "Charted a course through the webhook handlers. Rough seas.",
    "Scrubbed the deck of dead imports.",
  ],
  robot: [
    "EXECUTING: grep -r TODO. RESULTS: 47. ASSESSMENT: CONCERNING.",
    "COMPILING DBT MODELS. PROGRESS: 62 PERCENT.",
    "TEST SUITE COMPLETE. FAILURES: 0. SATISFACTION: NOMINAL.",
    "AWAITING OPERATOR INPUT. PATIENCE SUBROUTINE ENGAGED.",
  ],
  anxious: [
    "I think the build passed? Running it once more to be sure.",
    "Touched the CSS. Nothing broke. Yet.",
    "Re-reading the ticket in case I missed something. I missed something.",
    "The types check out. Should I double check the types?",
  ],
  gungho: ["Shipping it.", "Tests? Green. Vibes? Immaculate."],
  noir: ["The stack trace led me downtown. It always does."],
  bureaucrat: ["Filed form 27B/6 for the pull request. Awaiting stamp."],
};

/** Mock cwds live under ~/code/side/ for these, ~/code/acme/ for the rest. */
const SIDE_PROJECTS = new Set(["pixel-garden", "tide-tables", "scratch"]);

const CREW_LINES = [
  "Grepping for callers of createSession.",
  "Read 14 files. Summarising.",
  "Found the second session store. Nobody mentioned a second one.",
  "Checking the tests that cover the reducer.",
];

export function createMockHub(dispatch: Dispatch): MockHub {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    timers.push(t);
    return t;
  };

  const mk = (
    sid: string,
    p: Persona,
    project: string,
    status: SessionStatus,
    extra: Partial<Session>,
  ): Session => ({
    id: sid,
    persona: { ...p, sessionId: sid },
    status,
    cwd: `~/code/${SIDE_PROJECTS.has(project) ? "side" : "acme"}/${project}`,
    project,
    claudePid: 40000 + seq,
    model: "claude-opus-5-5",
    startedAt: ago(48 * 60_000),
    lastSeenAt: nowIso(),
    statusLine: "",
    stats: { toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, decisionsAnswered: 0 },
    crew: [],
    ...extra,
  });

  const member = (
    mid: string,
    kind: CrewMember["kind"],
    role: string,
    spriteSeed: number,
    status: CrewMember["status"],
    extra: Partial<CrewMember> = {},
  ): CrewMember => ({
    id: mid,
    kind,
    role,
    spriteSeed,
    status,
    startedAt: ago(6 * 60_000),
    lastSeenAt: nowIso(),
    toolCalls: 0,
    ...extra,
  });

  const sessions: Record<string, Session> = {
    s_nova: mk(
      "s_nova",
      persona("NOVA", "amber", "deadpan", 7391, "Has seen your code. Is unimpressed."),
      "checkout-api",
      "waiting_decision",
      {
        statusLine: "Explore: Mapping src/auth/. Four session stores. Four.",
        blockedSince: ago(95_000),
        lastTool: "Task",
        // Every crew state at once: a working subagent, a finished one fading out, a nested claude.
        crew: [
          member("ag_explore", "subagent", "Explore", 31337, "working", {
            lastTool: "Grep",
            toolCalls: 23,
          }),
          member("ag_review", "subagent", "code-reviewer", 4242, "done", {
            endedAt: ago(4_000),
            lastTool: "Read",
            toolCalls: 11,
          }),
          member("s_nova_kid", "child_session", "claude", 6061, "working", {
            lastTool: "Bash",
            toolCalls: 7,
          }),
        ],
        stats: {
          toolCalls: 212,
          inputTokens: 1_240_000,
          outputTokens: 38_400,
          costUsd: 4.12,
          decisionsAnswered: 3,
        },
      },
    ),
    s_rascal: mk(
      "s_rascal",
      persona("RASCAL", "magenta", "pirate", 2024, "Merges first, asks questions never."),
      "storefront",
      "waiting_decision",
      {
        statusLine: "Dropped anchor. Need the captain's word on the database driver.",
        blockedSince: ago(3 * 60_000 + 12_000),
        lastTool: "request_decision",
        crew: [
          member("ag_scout", "subagent", "general-purpose", 8088, "waiting_decision", {
            lastTool: "request_decision",
            toolCalls: 14,
          }),
        ],
        stats: {
          toolCalls: 88,
          inputTokens: 402_000,
          outputTokens: 12_900,
          costUsd: 1.37,
          decisionsAnswered: 1,
        },
      },
    ),
    s_cipher: mk(
      "s_cipher",
      persona("CIPHER", "cyan", "robot", 9182, "UNIT ONLINE. AWAITING INSTRUCTION."),
      "warehouse-models",
      "waiting_permission",
      {
        statusLine: "PERMISSION REQUIRED FOR SHELL COMMAND. HOLDING.",
        blockedSince: ago(41_000),
        lastTool: "Bash",
        // An agent team (#19): one teammate on a task, one on standby between tasks, plus a
        // one-off subagent named from its spawning Agent call.
        crew: [
          member("amigrator-5d1e0c9b7a3f2e18", "teammate", "migrator", 7117, "working", {
            team: "session-cipher",
            lastTool: "Edit",
            toolCalls: 31,
          }),
          member("asecurity-a484867aa788e408", "teammate", "security", 9001, "standby", {
            team: "session-cipher",
            lastTool: "Grep",
            toolCalls: 18,
          }),
          member("a5f0e3c2b1a0d9e8f7", "subagent", "Explore", 2718, "working", {
            label: "Map model deps",
            lastTool: "Glob",
            toolCalls: 6,
          }),
        ],
        stats: {
          toolCalls: 54,
          inputTokens: 180_500,
          outputTokens: 6_100,
          costUsd: 0.61,
          decisionsAnswered: 0,
        },
      },
    ),
    s_moth: mk(
      "s_moth",
      persona("MOTH", "green", "anxious", 5150, "Pretty sure it's fine. Probably."),
      "pixel-garden",
      "waiting_decision",
      {
        statusLine: "Two quick questions before I touch the chart. Sorry. Two.",
        blockedSince: ago(28_000),
        lastTool: "AskUserQuestion",
        stats: {
          toolCalls: 131,
          inputTokens: 655_000,
          outputTokens: 21_000,
          costUsd: 2.05,
          decisionsAnswered: 2,
        },
      },
    ),
  };
  sessions.s_echo = mk(
    "s_echo",
    persona("ECHO", "blue", "noir", 1312, "Asks the questions nobody wants asked."),
    "billing-portal",
    "waiting_decision",
    {
      statusLine: "Two questions left on the table. The terminal's waiting.",
      blockedSince: ago(2 * 60_000 + 20_000),
      lastTool: "Edit",
      stats: {
        toolCalls: 64,
        inputTokens: 290_000,
        outputTokens: 9_800,
        costUsd: 0.94,
        decisionsAnswered: 0,
      },
    },
  );
  // Finished its turn, nothing pending: the calm blue READY state, with a message box.
  sessions.s_lumen = mk(
    "s_lumen",
    persona("LUMEN", "cyan", "gungho", 7777, "Done already. Next?"),
    "tide-tables",
    "idle",
    {
      statusLine: "Shipped the CSV export. Tests? Green. Vibes? Immaculate.",
      blockedSince: ago(4 * 60_000 + 10_000),
      lastTool: "Bash",
      stats: {
        toolCalls: 97,
        inputTokens: 510_000,
        outputTokens: 17_300,
        costUsd: 1.62,
        decisionsAnswered: 1,
      },
      canMessage: true,
    },
  );
  // A background `claude` nobody is driving. engaged:false keeps it off the floor entirely.
  sessions.s_ghost = mk(
    "s_ghost",
    persona("GHOST", "red", "robot", 404, "You should not be able to see this."),
    "scratch",
    "idle",
    { engaged: false, statusLine: "IF YOU CAN READ THIS, THE ENGAGED FILTER IS BROKEN." },
  );
  // A nested `claude -p` started from NOVA's shell. It folds into NOVA's bay, not its own station.
  sessions.s_nova_kid = mk(
    "s_nova_kid",
    persona("NOVA-2", "amber", "deadpan", 6061, "NOVA, but smaller."),
    "checkout-api",
    "working",
    {
      parentSessionId: "s_nova",
      statusLine: "Running the billing suite in a subshell.",
      lastTool: "Bash",
      startedAt: ago(3 * 60_000),
    },
  );

  const decisions: Record<string, Decision> = {};
  const rascalDecision: Decision = {
    id: id("d"),
    sessionId: "s_rascal",
    source: "mcp",
    question: "Which Postgres driver for the new sales reporting module?",
    options: [
      {
        label: "Keep pg",
        description: "Matches the rest of storefront. No new dependency.",
        recommended: true,
      },
      { label: "Switch to postgres.js", description: "Faster, but a second driver in the repo." },
      { label: "Bun.sql native", description: "Zero deps, still marked experimental." },
    ],
    context: [
      "Adding reporting queries under src/sales/reporting/.",
      "The existing checkout-api pattern uses pg with a shared pool in src/db/pool.ts.",
      "postgres.js would let me use tagged templates and pipelining:",
      "",
      "  const rows = await sql`select * from orders where day = today`;",
      "",
      "Nothing else in storefront depends on postgres.js today.",
    ].join("\n"),
    urgency: "normal",
    status: "pending",
    createdAt: ago(3 * 60_000 + 12_000),
    allowFreeText: true,
    agentId: "ag_scout",
    agentRole: "general-purpose",
  };
  const cipherPermission: Decision = {
    id: id("d"),
    sessionId: "s_cipher",
    source: "permission",
    question: "Allow Bash: rm -rf dist && bun run build",
    options: [{ label: "Allow", recommended: true }, { label: "Deny" }],
    context: "Rebuilding warehouse-models after the schema change. dist/ is gitignored.",
    urgency: "high",
    status: "pending",
    createdAt: ago(41_000),
    allowFreeText: false,
    toolName: "Bash",
    toolInput: { command: "rm -rf dist && bun run build", timeout: 120000 },
  };
  const mothAsk: Decision = {
    id: id("d"),
    sessionId: "s_moth",
    source: "ask",
    question: "Which chart for the weekly visitors panel?",
    options: [],
    questions: [
      {
        question: "Which chart for the weekly visitors panel?",
        header: "Chart",
        multiSelect: false,
        options: [
          {
            label: "Stacked bars",
            description: "One bar per week, stacked by traffic source.",
            preview: "Wk 36 ████▓▓▓░░ 1,204\nWk 37 █████▓▓░░ 1,311\nWk 38 ███▓▓▓░░░   998",
          },
          {
            label: "Line per source",
            description: "Easier to compare sources, harder to read the total.",
            preview: "<svg><polyline points='0,40 20,32 40,36 60,18' /></svg>",
          },
          { label: "Table", description: "No chart. Numbers only." },
        ],
      },
      {
        question: "Which filters should the panel expose?",
        header: "Filters",
        multiSelect: true,
        options: [
          { label: "Date range", description: "Defaults to the last 8 weeks." },
          { label: "Traffic source" },
          { label: "Garden", description: "Searchable, can be slow with many gardens." },
          { label: "Region" },
        ],
      },
    ],
    urgency: "normal",
    status: "pending",
    createdAt: ago(28_000),
    allowFreeText: true,
    toolName: "AskUserQuestion",
  };
  const novaPlan: Decision = {
    id: id("d"),
    sessionId: "s_nova",
    source: "plan",
    question: "Approve this plan to remove the legacy auth path?",
    options: [
      { label: "Approve", recommended: true },
      { label: "Approve + auto-accept edits" },
      { label: "Keep planning" },
    ],
    plan: [
      "# Remove legacy auth path",
      "",
      "## Steps",
      "1. Delete `src/auth/legacy/` and its three call sites in `router.ts`.",
      "2. Move session lookup onto the **single** store in `src/auth/session.ts`.",
      "- Keep the cookie name so existing sessions survive the deploy.",
      "- Drop the `LEGACY_AUTH` flag from config and docs.",
      "",
      "## Verification",
      "- `go test ./...` and the auth e2e suite.",
      "- Manual login on staging with an old cookie.",
    ].join("\n"),
    urgency: "normal",
    status: "pending",
    createdAt: ago(95_000),
    allowFreeText: false,
    toolName: "ExitPlanMode",
  };
  // The kind of turn that motivated prose cards: questions asked in plain text, no tool waiting.
  const echoQuestions = [
    "Which service should mint invoice numbers once legacy-billing is retired?",
    "Can I keep the deliberate `?? 0` in the monthly-revenue chart as an exception?",
  ];
  const echoProse: Decision = {
    id: id("d"),
    sessionId: "s_echo",
    source: "prose",
    question: echoQuestions[0] ?? "",
    options: [],
    prose: {
      questions: echoQuestions,
      message: [
        "Migrated the invoice list and the monthly-revenue chart off legacy-billing.",
        "",
        "Two things I can't decide alone:",
        "",
        `1. ${echoQuestions[0]}`,
        "   Today legacy-billing mints them in InvoiceService.create. Nothing else does.",
        `2. ${echoQuestions[1]}`,
        "   Missing months should read as zero on that chart, but the lint rule flags it.",
      ].join("\n"),
    },
    answerable: false,
    urgency: "normal",
    status: "pending",
    createdAt: ago(2 * 60_000 + 20_000),
    allowFreeText: false,
  };
  // What the session was saying just before it asked; the cards show it as CONTEXT.
  rascalDecision.recentContext = {
    lastPrompt: "Add a sales reporting module to storefront with weekly totals per product.",
    assistantText: [
      "Scaffolded src/sales/reporting/ with a query layer and two endpoints.",
      "The rest of storefront talks to Postgres through `pg` and a shared pool, but the reporting",
      "queries are wide and would read better as tagged templates.",
      "Before I add a dependency I want a ruling on the driver.",
    ].join("\n"),
  };
  cipherPermission.recentContext = {
    lastPrompt: "Rebuild warehouse-models after the schema change and run the model tests.",
    assistantText:
      "SCHEMA CHANGE APPLIED TO models/orders.sql. STALE ARTIFACTS IN dist/ WILL SHADOW THE NEW MODELS. CLEARING AND REBUILDING.",
  };
  novaPlan.recentContext = {
    lastPrompt: "Plan the removal of the legacy auth path. Don't touch code yet.",
    assistantText:
      "Read all four session stores. Three are dead. The plan below removes the legacy path in one PR.",
  };
  mothAsk.recentContext = {
    lastPrompt: "Add a weekly visitors panel to the pixel-garden overview.",
    assistantText:
      "The data's there (`weekly_visits` view). I just don't know how you want it shown. Sorry.",
  };
  echoProse.recentContext = {
    lastPrompt: "Finish moving the invoice pages off legacy-billing.",
  };
  // A gated Edit, so the diff preview is visible next to the Bash one.
  const cipherEdit: Decision = {
    id: id("d"),
    sessionId: "s_cipher",
    source: "permission",
    question: "Allow Edit: models/orders.sql",
    options: [{ label: "Allow", recommended: true }, { label: "Deny" }],
    urgency: "high",
    status: "pending",
    createdAt: ago(70_000),
    allowFreeText: false,
    toolName: "Edit",
    toolInput: { file_path: "models/orders.sql" },
    changePreview: {
      filePath: "~/code/acme/warehouse-models/models/orders.sql",
      diff: [
        "@@ -12,7 +12,8 @@",
        "   SELECT",
        "     order_id,",
        "-    created_at,",
        "+    created_at AS created_at_utc,",
        "+    DATETIME(created_at, 'Pacific/Auckland') AS created_at_local,",
        "     customer_id,",
        "     status",
        "   FROM {{ ref('stg_orders') }}",
      ].join("\n"),
      truncated: true,
    },
    recentContext: {
      assistantText:
        "LOCAL TIME COLUMN REQUIRED BY THE MONTHLY REVENUE CHART. ADDING IT BESIDE THE UTC ONE, NOT REPLACING IT.",
    },
  };
  decisions[cipherEdit.id] = cipherEdit;
  decisions[echoProse.id] = echoProse;
  decisions[mothAsk.id] = mothAsk;
  decisions[novaPlan.id] = novaPlan;
  decisions[rascalDecision.id] = rascalDecision;
  decisions[cipherPermission.id] = cipherPermission;

  const log: LogEntry[] = [];
  const entry = (
    sessionId: string,
    kind: LogKind,
    text: string,
    at = nowIso(),
    extra: Partial<LogEntry> = {},
  ): LogEntry => {
    const s = sessions[sessionId];
    if (!s) throw new Error(`no mock session ${sessionId}`);
    const { name, color, spriteSeed } = s.persona;
    return {
      id: id("l"),
      at,
      sessionId,
      persona: { name, color, spriteSeed },
      kind,
      text,
      ...extra,
    };
  };

  // Seed history so the log and score strip have something to show.
  const seedAt = (m: number) => ago(m * 60_000);
  log.push(
    entry("s_nova", "session_start", "Online. Try to keep up.", seedAt(48)),
    entry("s_moth", "session_start", "Hi. Um. Hello. I'm here now.", seedAt(46)),
    entry("s_rascal", "session_start", "RASCAL boards the ship. Yarr.", seedAt(44)),
    entry("s_cipher", "session_start", "UNIT CIPHER ONLINE.", seedAt(40)),
    entry(
      "s_nova",
      "decision_requested",
      "Asked whether to keep the legacy auth path.",
      seedAt(38),
      {
        decisionId: "d_hist1",
      },
    ),
    entry("s_nova", "decision_answered", "Operator says: remove it.", seedAt(36), {
      decisionId: "d_hist1",
      meta: { answer: "Remove it", waitedMs: 118_000 },
    }),
    entry(
      "s_moth",
      "decision_requested",
      "Should I bump the Vite major? Is that allowed?",
      seedAt(30),
      {
        decisionId: "d_hist2",
      },
    ),
    entry("s_moth", "decision_answered", "Okay. Bumping. Deep breath.", seedAt(29), {
      decisionId: "d_hist2",
      meta: { answer: "Bump it", waitedMs: 42_000 },
    }),
    entry("s_nova", "tool", "Ran tests in packages/billing. Eleven of twelve.", seedAt(21)),
    entry("s_rascal", "tool", "Scrubbed the deck of dead imports.", seedAt(12)),
    entry("s_nova", "decision_requested", "Plan ready. Approve it or don't.", seedAt(1.6), {
      decisionId: novaPlan.id,
    }),
    entry("s_moth", "decision_requested", "Two questions about the chart. Sorry.", seedAt(0.45), {
      decisionId: mothAsk.id,
    }),
    entry("s_nova", "note", "Sent Explore to map the auth module.", seedAt(6), {
      agentId: "ag_explore",
      agentRole: "Explore",
    }),
    entry("s_nova", "note", "code-reviewer signed off on the reducer. Grudgingly.", seedAt(0.1), {
      agentId: "ag_review",
      agentRole: "code-reviewer",
    }),
    entry(
      "s_moth",
      "idle",
      "Finished. I think. Waiting for someone to tell me what's next.",
      seedAt(0.5),
    ),
    entry(
      "s_cipher",
      "permission_prompt",
      "PERMISSION REQUIRED: Bash rm -rf dist && bun run build",
      seedAt(0.7),
    ),
    entry(
      "s_rascal",
      "decision_requested",
      "The scout needs the captain's word on the database driver.",
      seedAt(3.2),
      {
        decisionId: rascalDecision.id,
        agentId: "ag_scout",
        agentRole: "general-purpose",
      },
    ),
  );
  log.sort((a, b) => a.at.localeCompare(b.at));

  dispatch({
    type: "snapshot",
    state: {
      sessions: Object.values(sessions),
      decisions: Object.values(decisions),
      log,
      serverTime: nowIso(),
    },
  });

  const pushLog = (e: LogEntry) => {
    log.push(e);
    dispatch({ type: "log", entry: e });
  };
  const pushSession = (sid: string, patch: Partial<Session>) => {
    const s = sessions[sid];
    if (!s) return;
    const next = { ...s, ...patch, lastSeenAt: nowIso() };
    sessions[sid] = next;
    dispatch({ type: "session", session: next });
  };
  const activity = (sid: string) => {
    const s = sessions[sid];
    if (s?.status !== "working") return;
    const pool = LINES[s.persona.voice];
    const busy = s.crew.filter((m) => m.status === "working" && m.kind === "subagent");
    const who = Math.random() < 0.5 ? busy[Math.floor(Math.random() * busy.length)] : undefined;
    const said = pool[Math.floor(Math.random() * pool.length)] ?? "";
    // The hub prefixes crew activity with the role; the ticker tints that prefix.
    const line = who
      ? `${who.role}: ${CREW_LINES[Math.floor(Math.random() * CREW_LINES.length)]}`
      : said;
    s.statusLine = line;
    s.stats = {
      ...s.stats,
      toolCalls: s.stats.toolCalls + 1,
      inputTokens: s.stats.inputTokens + 2400 + Math.floor(Math.random() * 6000),
      outputTokens: s.stats.outputTokens + 120 + Math.floor(Math.random() * 400),
      costUsd: s.stats.costUsd + 0.004,
    };
    dispatch({ type: "activity", sessionId: sid, line, at: nowIso() });
  };

  // A living floor: working stations chatter, stats tick, occasional log lines.
  const tick = () => {
    for (const sid of Object.keys(sessions)) {
      if (Math.random() < 0.55) activity(sid);
      if (Math.random() < 0.08) {
        const s = sessions[sid];
        // The nested child's log lines would come tagged as crew from the hub; keep the demo quiet.
        if (s?.status === "working" && !s.parentSessionId) {
          pushSession(sid, { stats: s.stats });
          pushLog(entry(sid, "tool", s.statusLine));
        }
      }
    }
    later(1800 + Math.random() * 2200, tick);
  };
  later(1500, tick);

  // MOTH wakes up after a minute, works for a bit, goes idle again.
  const mothCycle = () => {
    pushSession("s_moth", { status: "working", blockedSince: undefined });
    pushLog(entry("s_moth", "note", "Oh! Right. Okay. Back to it."));
    later(35_000, () => {
      pushSession("s_moth", { status: "idle", blockedSince: nowIso() });
      pushLog(
        entry("s_moth", "idle", "Done again. Was that everything? I hope that was everything."),
      );
      later(70_000, mothCycle);
    });
  };
  // MOTH's idle/work loop starts once its questions are answered (see answer()).

  // NOVA's reviewer subagent: finished ones linger the hub's 60s grace, then drop out, then a fresh one is sent in.
  const setCrew = (sid: string, fn: (crew: CrewMember[]) => CrewMember[]) => {
    const s = sessions[sid];
    if (s) pushSession(sid, { crew: fn(s.crew) });
  };
  const reviewerCycle = () => {
    setCrew("s_nova", (c) => c.filter((m) => m.id !== "ag_review"));
    later(15_000, () => {
      setCrew("s_nova", (c) => [
        ...c,
        member("ag_review", "subagent", "code-reviewer", 4242, "working"),
      ]);
      pushLog(
        entry("s_nova", "note", "Sent code-reviewer over the diff.", nowIso(), {
          agentId: "ag_review",
          agentRole: "code-reviewer",
        }),
      );
      later(40_000, () => {
        setCrew("s_nova", (c) =>
          c.map((m) => (m.id === "ag_review" ? { ...m, status: "done", endedAt: nowIso() } : m)),
        );
        later(60_000, reviewerCycle);
      });
    });
  };
  later(56_000, reviewerCycle);

  const followUp = (sid: string) => {
    const d: Decision = {
      id: id("d"),
      sessionId: sid,
      source: "mcp",
      question:
        "Tests in packages/billing fail after the tax rounding change. Fix the tests or the rounding?",
      options: [
        {
          label: "Fix the rounding",
          description: "Round half to even, matches the invoicing service.",
          recommended: true,
        },
        { label: "Update the tests", description: "Accept the new totals as correct." },
        { label: "Revert the change" },
      ],
      context:
        "FAIL packages/billing/tax.test.ts\n  expected 12.35 received 12.34\n  expected 0.05 received 0.04\n\nThe change moved rounding from per-line to per-invoice.",
      urgency: "high",
      status: "pending",
      createdAt: nowIso(),
      allowFreeText: true,
    };
    decisions[d.id] = d;
    pushSession(sid, { status: "waiting_decision", blockedSince: d.createdAt });
    pushLog(
      entry(sid, "decision_requested", "Needs a ruling on the billing tests.", d.createdAt, {
        decisionId: d.id,
      }),
    );
    dispatch({ type: "decision", decision: d });
  };

  // Voice drill: over the first ~70s every spoken announcement gets a live trigger (a new
  // session, a burst of asks, a station going idle, one card of each source, a crew card).
  // RASCAL and ECHO cross the red tier on their own a minute or two in.
  const raise = (sid: string, d: Omit<Decision, "id" | "sessionId" | "status" | "createdAt">) => {
    const full: Decision = {
      ...d,
      id: id("d"),
      sessionId: sid,
      status: "pending",
      createdAt: nowIso(),
    };
    decisions[full.id] = full;
    if (!full.agentId)
      pushSession(sid, { status: "waiting_decision", blockedSince: full.createdAt });
    pushLog(
      entry(sid, "decision_requested", full.question, full.createdAt, {
        decisionId: full.id,
        agentId: full.agentId,
        agentRole: full.agentRole,
      }),
    );
    dispatch({ type: "decision", decision: full });
  };
  const ask = (question: string, header: string) => ({
    question,
    header,
    multiSelect: false,
    options: [{ label: "Yes" }, { label: "No" }],
  });
  later(8_000, () => {
    sessions.s_pepper = mk(
      "s_pepper",
      persona("PEPPER", "red", "pirate", 3113, "Sails first, charts later."),
      "ops-dashboard",
      "working",
      { startedAt: nowIso(), statusLine: "Weighin' anchor on the ops dashboard." },
    );
    dispatch({ type: "session", session: sessions.s_pepper });
    pushLog(entry("s_pepper", "session_start", "PEPPER comes aboard. Arr."));
  });
  later(14_000, () =>
    raise("s_pepper", {
      source: "ask",
      question: "Keep the old export button?",
      options: [],
      questions: [ask("Keep the old export button?", "Export"), ask("Rename the tab?", "Tab")],
      urgency: "normal",
      allowFreeText: true,
      toolName: "AskUserQuestion",
    }),
  );
  later(15_200, () =>
    raise("s_pepper", {
      source: "ask",
      question: "Ship behind a flag?",
      options: [],
      questions: [ask("Ship behind a flag?", "Flag")],
      urgency: "normal",
      allowFreeText: true,
      toolName: "AskUserQuestion",
    }),
  );
  later(22_000, () => pushSession("s_lumen", { status: "working", blockedSince: undefined }));
  later(30_000, () =>
    raise("s_cipher", {
      source: "permission",
      question: "Allow WebFetch: docs.getdbt.com",
      options: [{ label: "Allow", recommended: true }, { label: "Deny" }],
      urgency: "high",
      allowFreeText: false,
      toolName: "WebFetch",
      toolInput: { url: "https://docs.getdbt.com" },
    }),
  );
  later(34_000, () => pushSession("s_lumen", { status: "idle", blockedSince: nowIso() }));
  later(42_000, () =>
    raise("s_echo", {
      source: "prose",
      question: "Who signs off on the invoice numbering change?",
      options: [],
      prose: {
        questions: ["Who signs off on the invoice numbering change?"],
        message: "One more thing nobody wants to answer.",
      },
      answerable: false,
      urgency: "normal",
      allowFreeText: false,
    }),
  );
  later(50_000, () =>
    raise("s_pepper", {
      source: "plan",
      question: "Approve this plan for the ops dashboard?",
      options: [{ label: "Approve", recommended: true }, { label: "Keep planning" }],
      plan: "# Ops dashboard\n\n1. Move the export into the toolbar.\n2. Ship behind a flag.",
      urgency: "normal",
      allowFreeText: false,
      toolName: "ExitPlanMode",
    }),
  );
  later(58_000, () =>
    raise("s_lumen", {
      source: "mcp",
      question: "Deploy the CSV export to staging now or batch it with Friday's release?",
      options: [{ label: "Now", recommended: true }, { label: "Friday" }],
      urgency: "normal",
      allowFreeText: true,
    }),
  );
  later(66_000, () =>
    raise("s_nova", {
      source: "mcp",
      question: "Four session stores. Map all of them or just the live one?",
      options: [{ label: "All four" }, { label: "Just the live one", recommended: true }],
      urgency: "normal",
      allowFreeText: true,
      agentId: "ag_explore",
      agentRole: "Explore",
    }),
  );

  const answer = async (decisionId: string, body: DecisionAnswerBody) => {
    await new Promise((r) => setTimeout(r, 180 + Math.random() * 220));
    const d = decisions[decisionId];
    if (!d) throw new Error("Decision not found (it may have expired)");
    const answered: Decision = {
      ...d,
      status: "answered",
      answer: body.answer,
      note: body.note,
      ...(d.source === "ask" && body.answers ? { answers: body.answers } : {}),
      answeredAt: nowIso(),
    };
    delete decisions[decisionId];
    dispatch({ type: "decision", decision: answered });
    const s = sessions[d.sessionId];
    if (s) {
      pushSession(d.sessionId, {
        crew: s.crew.map((m) =>
          m.id === d.agentId ? { ...m, status: "working", lastSeenAt: nowIso() } : m,
        ),
        status: "working",
        blockedSince: undefined,
        stats: { ...s.stats, decisionsAnswered: s.stats.decisionsAnswered + 1 },
        statusLine: ack(s.persona.voice, body.answer),
      });
    }
    pushLog(
      entry(
        d.sessionId,
        "decision_answered",
        ack(s?.persona.voice ?? "deadpan", body.answer),
        nowIso(),
        {
          decisionId,
          meta: {
            answer: body.answer,
            note: body.note,
            answers: body.answers,
            waitedMs: Date.now() - Date.parse(d.createdAt),
          },
        },
      ),
    );
    if (d.source === "ask") later(20_000, mothCycle);
    // Keep the demo alive: a fresh transmission arrives a little later.
    if (d.source === "mcp") later(14_000 + Math.random() * 10_000, () => followUp("s_nova"));
  };

  // Anything mentioning "offline" fails like a dead socket, to show the error path.
  const sendMessage = async (sessionId: string, text: string) => {
    await new Promise((r) => setTimeout(r, 200));
    if (/offline/i.test(text)) throw new MessageError("unreachable", "Couldn't reach the session.");
    const s = sessions[sessionId];
    if (!s) throw new MessageError("other", "Send failed (404)");
    pushSession(sessionId, {
      status: "working",
      blockedSince: undefined,
      statusLine: `Got it: "${text.slice(0, 60)}"`,
    });
    pushLog(entry(sessionId, "note", `Operator: ${text}`));
    later(25_000, () => pushSession(sessionId, { status: "idle", blockedSince: nowIso() }));
  };

  const dismiss = async (decisionId: string) => {
    await new Promise((r) => setTimeout(r, 150));
    const d = decisions[decisionId];
    if (!d) return;
    delete decisions[decisionId];
    pushSession(d.sessionId, { status: "idle", blockedSince: nowIso() });
    pushLog(entry(d.sessionId, "note", "Card dismissed. The question stands in the terminal."));
  };

  return {
    answer,
    dismiss,
    sendMessage,
    stop: () => {
      for (const t of timers) clearTimeout(t);
    },
  };
}

function ack(voice: PersonaVoice, answer: string): string {
  switch (voice) {
    case "pirate":
      return `Aye aye. "${answer}" it is. Full sail.`;
    case "robot":
      return `INSTRUCTION RECEIVED: ${answer.toUpperCase()}. RESUMING.`;
    case "anxious":
      return `"${answer}". Okay. Okay okay okay. Doing that.`;
    case "gungho":
      return `${answer}. Love it. On it.`;
    case "noir":
      return `"${answer}", they said. I'd heard worse ideas that week.`;
    case "bureaucrat":
      return `Decision "${answer}" logged in triplicate. Proceeding.`;
    default:
      return `"${answer}". Fine. Proceeding.`;
  }
}
