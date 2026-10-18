import type { Scenario, Scripted } from "../scenario";
import type { DraftEvent, FrameState, Hit } from "../types";

const s = (delay: number, event: DraftEvent): Scripted => ({ delay, event });

const hit = (start_ms: number, end_ms: number, score: number, caption: string): Hit => ({ start_ms, end_ms, score, caption });

const ui = (page: "general" | "connection", value: string, o: Partial<{ typing: boolean; saved: boolean; loading: boolean }> = {}): FrameState => ({
  kind: "ui",
  page,
  value,
  typing: o.typing ?? false,
  saved: o.saved ?? false,
  loading: o.loading ?? false,
});

function bugFrame(t_ms: number): FrameState {
  const t = t_ms / 1000;
  if (t < 38) return ui("general", "30");
  if (t < 102) return ui("connection", "30");
  if (t < 105) return ui("connection", "60", { typing: true });
  if (t < 108) return ui("connection", "60", { saved: true });
  if (t < 110) return ui("connection", "60", { loading: true });
  return ui("connection", "30");
}

const SLIDES: { from: number; title: string; bullets: string[]; caption: string }[] = [
  { from: 0, title: "Make Something Agents Want", bullets: ["Agent-first products", "Build for agents as users", "Ship in a weekend"], caption: "Welcome everyone — this weekend, make something agents actually want." },
  { from: 300, title: "Agents are the new users", bullets: ["Supabase: 70% of signups are agents", "Exa: 10x growth 3 years running"], caption: "Agents are signing up, paying and growing faster than humans ever did." },
  { from: 900, title: "Sponsor tracks", bullets: ["Primitive", "Stripe", "Manufact", "Blaxel", "Armature", "Inkbox"], caption: "Each sponsor has a track with its own prize — here is the full list." },
  { from: 1500, title: "Stripe", bullets: ["$3,000 1st", "Credits", "Atlas"], caption: "Stripe is putting up three thousand dollars for first place, plus credits and Atlas." },
  { from: 1700, title: "Primitive", bullets: ["Email rebuilt for agents", "$3,000 1st"], caption: "Primitive has rebuilt email for agents, and also offers three thousand for first." },
  { from: 1860, title: "Schedule · Saturday", bullets: ["Lunch talks 12:15", "Dinner talks ~5pm"], caption: "Lunch talks start at twelve fifteen, and dinner talks around five." },
  { from: 2000, title: "Schedule · Sunday", bullets: ["Submissions due 10:00 AM", "GitHub link + video demo", "Pick 1–2 prize tracks"], caption: "Submissions are due at ten a.m. tomorrow — GitHub link plus a video demo." },
  { from: 2200, title: "Overall prize: YC interview", bullets: ["Overall winner gets a YC interview"], caption: "And the overall winner walks away with a YC interview." },
];

function talkFrame(t_ms: number): FrameState {
  const t = t_ms / 1000;
  let sl = SLIDES[0];
  for (const x of SLIDES) if (t >= x.from) sl = x;
  return { kind: "talk", title: sl.title, bullets: sl.bullets, speaker: "Kickoff host", caption: sl.caption };
}

interface Cfg {
  id: "bug" | "talk";
  n: string; // id suffix
  email: string;
  pay: string;
  sandbox: string;
  index: { segments: number; keyframes: number; ms_elapsed: number; cost_cents: number };
  job: { source_name: string; duration_ms: number; task: string; requested_by: string };
  searches: [string, Hit[], number][];
  retrieval: { start_ms: number; end_ms: number; frames_ms: number[]; clip_ms: number };
  report: Extract<DraftEvent, { type: "report.ready" }>["data"]["report"];
}

function script(c: Cfg, jobId: string): { prePay: Scripted[]; postPay: Scripted[] } {
  const allowance = { text_tokens: 2000, frames: 8, clip_ms: 15000, max_duration_ms: 180000 };
  const prePay = [
    s(0, { type: "job.created", source: "api", data: c.job }),
    s(500, { type: "quote.issued", source: "api", data: { amount_cents: 50, allowance, expires_at: "2026-10-18T10:00:00.000Z" } }),
    s(400, { type: "payment.challenge", source: "stripe", data: { challenge_id: `ch_${c.n}_link_test` } }),
  ];
  const prog = (stage: "probe" | "detect" | "transcribe" | "caption", pct: number, d: number) =>
    s(d, { type: "worker.progress", source: "worker", data: { stage, pct } });
  const postPay = [
    s(1400, { type: "payment.verified", source: "stripe", data: { payment_id: c.pay, amount_cents: 50, mode: "test" } }),
    s(700, { type: "primitive.dispatched", source: "primitive", data: { message_id: `msg_${c.n}_out`, to: "worker@mediapack.primitive.dev" } }),
    s(600, { type: "worker.started", source: "worker", data: { sandbox_id: c.sandbox } }),
    prog("probe", 10, 500),
    prog("detect", 35, 700),
    prog("transcribe", 60, 800),
    prog("caption", 85, 900),
    s(900, { type: "worker.indexed", source: "worker", data: c.index }),
    ...c.searches.map(([query, hits, text_tokens], i) =>
      s(i === 0 ? 1200 : 1400, { type: "agent.search", source: "agent", data: { query, hits, text_tokens } }),
    ),
    s(1300, { type: "agent.retrieved", source: "agent", data: c.retrieval }),
    s(1100, { type: "primitive.delivered", source: "primitive", data: { message_id: `msg_${c.n}_back`, artifacts: c.retrieval.frames_ms.length + 1 } }),
    s(900, { type: "report.ready", source: "agent", data: { report: c.report } }),
  ];
  void jobId;
  return { prePay, postPay };
}

const bugCfg: Cfg = {
  id: "bug",
  n: "1042",
  email: "worker@mediapack.primitive.dev",
  pay: "pi_3QmBug1042LinkTest",
  sandbox: "sbx_bl_1042a7",
  index: { segments: 23, keyframes: 41, ms_elapsed: 38200, cost_cents: 4 },
  job: {
    source_name: "settings-reset.mp4",
    duration_ms: 160000,
    task: "Turn this recording into a bug report I can act on: steps, screenshots, and the clip showing the failure. Spend up to $0.50.",
    requested_by: "coding-agent",
  },
  searches: [
    ["request timeout value changed", [hit(101000, 106000, 0.91, "Request timeout edited 30 → 60, Save clicked"), hit(38000, 44000, 0.42, "Opens Connection settings")], 640],
    ["page reload after save", [hit(108000, 111000, 0.88, "Page reloads (spinner)"), hit(110000, 116000, 0.83, "Request timeout shows 30 after reload")], 644],
  ],
  retrieval: { start_ms: 102000, end_ms: 114000, frames_ms: [102000, 104000, 106000, 108000, 110000, 112000], clip_ms: 12000 },
  report: {
    kind: "bug",
    title: "Timeout resets after refresh.",
    subtitle: "Source-linked steps for your coding agent.",
    findings: [
      { t_ms: 104000, text: "Set Request timeout to 60 seconds." },
      { t_ms: 106000, text: "The interface displays Saved." },
      { t_ms: 110000, text: "Refresh returns the value to 30 seconds." },
    ],
    observed: "The new value does not remain visible after refresh.",
    caveat: "Root cause: requires code investigation.",
    evidence: [
      { t_ms: 106000, label: "Before refresh" },
      { t_ms: 110000, label: "After refresh" },
    ],
  },
};

const talkCfg: Cfg = {
  id: "talk",
  n: "1043",
  email: "worker@mediapack.primitive.dev",
  pay: "pi_3QmTalk1043LinkTest",
  sandbox: "sbx_bl_1043c9",
  index: { segments: 214, keyframes: 388, ms_elapsed: 52100, cost_cents: 9 },
  job: {
    source_name: "yc-kickoff.mp4",
    duration_ms: 2480000,
    task: "When are hackathon submissions due and what must they include? Cite the moment.",
    requested_by: "research-agent",
  },
  searches: [
    ["when are submissions due", [hit(2040000, 2052000, 0.94, "Submissions due 10:00 AM Sunday"), hit(1860000, 1872000, 0.38, "Saturday schedule")], 512],
    ["what must a submission include", [hit(2048000, 2060000, 0.81, "GitHub link + video demo; pick 1–2 tracks")], 430],
  ],
  retrieval: { start_ms: 2040000, end_ms: 2054000, frames_ms: [2040000, 2044000, 2048000, 2052000], clip_ms: 14000 },
  report: {
    kind: "answer",
    title: "Submissions close Sunday at 10:00 AM.",
    subtitle: "Answer cited to the kickoff recording.",
    findings: [
      { t_ms: 2040000, text: "Submission link is sent early Sunday morning." },
      { t_ms: 2044000, text: "Due 10:00 AM: GitHub link plus a video demo." },
      { t_ms: 2052000, text: "Apply to one or two prize tracks — applying to everything is discouraged." },
    ],
    observed: "Speaker states the deadline verbatim; the on-screen schedule matches.",
    caveat: "The event end time is ambiguous in the talk (noon vs 12:30).",
    evidence: [
      { t_ms: 2040000, label: "Speaker" },
      { t_ms: 2052000, label: "Schedule slide" },
    ],
  },
};

const DELIVERED = "Your agent found the evidence.";

export const SCENARIOS: Record<"bug" | "talk", Scenario> = {
  bug: {
    id: "bug",
    label: "Bug report",
    jobId: "MP-1042",
    kind: "ui",
    thumbs: 16,
    copy: {
      quoted: { title: "Turn a bug recording into clear repro steps.", sub: "One quote. One payment. Evidence your agent can act on." },
      paying: { title: "Waiting for Link approval", sub: "Approve the test payment to start." },
      processing: { title: "Payment verified. Dispatching work.", sub: "Handing the recording to a worker by email." },
      indexing: { title: "Indexing the recording", sub: "Detecting screens, transcribing, captioning." },
      inspecting: { title: "Locating the reset", sub: "Your agent is searching the recording." },
      delivered: { title: DELIVERED, sub: "Steps, screenshots and a clip, source-linked." },
    },
    frameAt: bugFrame,
    ...script(bugCfg, "MP-1042"),
  },
  talk: {
    id: "talk",
    label: "Talk Q&A",
    jobId: "MP-1043",
    kind: "talk",
    thumbs: 16,
    copy: {
      quoted: { title: "Find the exact moment in a 41-minute talk.", sub: "One quote. One payment. A cited answer." },
      paying: { title: "Waiting for Link approval", sub: "Approve the test payment to start." },
      processing: { title: "Payment verified. Dispatching work.", sub: "Handing the talk to a worker by email." },
      indexing: { title: "Indexing the talk", sub: "Segmenting, transcribing, captioning slides." },
      inspecting: { title: "Searching the talk", sub: "Your agent is searching the transcript." },
      delivered: { title: DELIVERED, sub: "Answer, frames and a clip, cited by timestamp." },
    },
    frameAt: talkFrame,
    ...script(talkCfg, "MP-1043"),
  },
};
