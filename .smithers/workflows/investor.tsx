// smithers-source: authored
// smithers-display-name: Investor Deck
/** @jsxImportSource smithers-orchestrator */

/**
 * A keyboard-driven Smithers investor pitch deck for a 10-20 minute screenshare.
 *
 *   ▸ / Space / Enter / Down  — next slide
 *   ◂ / Up                    — previous slide
 *   r                         — replay current slide's narration
 *   m                         — mute / unmute audio for the rest of the deck
 *   q / Esc                   — quit
 *
 * This is the investor-facing companion to demo.tsx (the technical deck).
 * Where demo.tsx sells the engineering, this deck sells the company: the
 * problem, the solution, the market (small + medium businesses automating
 * their work), traction (real npm + GitHub data, rendered as live charts),
 * the open-source flywheel, third-party ecosystem, business model, the
 * competitive landscape, and the reputation-led enterprise go-to-market.
 *
 * Every number in the TRACTION act is REAL data pulled from the npm
 * downloads API and the GitHub stargazers/contributors API on 2026-06-17.
 * Update the DATA block below before each pitch — see refreshData() notes.
 *
 * Usage (from repo root):
 *   ./.smithers/scripts/run-investor.sh
 *   ./.smithers/scripts/run-investor.sh --silent
 *   ./.smithers/scripts/run-investor.sh --start-at 10
 */

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

export const inputSchema = z.object({
  silent: z.boolean().default(false),
  voice: z.string().trim().min(1).max(128).default("Ava (Premium)"),
  rate: z.number().int().min(1).max(500).default(190),
  startAt: z.number().int().min(0).max(10_000).default(0),
  auto: z.boolean().default(false),
  autoMs: z.number().int().min(0).max(600_000).default(9000),
});

export type InvestorInput = z.infer<typeof inputSchema>;

/** Apply the same validation and defaults whether called by the CLI or a test renderer. */
export function normalizeInvestorInput(raw: unknown): InvestorInput {
  return inputSchema.parse(raw ?? {});
}

const doneSchema = z.object({ finished: z.boolean() });

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  slideshow: doneSchema,
});

// ─── live traction data (refresh before each pitch) ──────────────────────────
//
// Pulled 2026-06-17 from:
//   npm:    https://api.npmjs.org/downloads/range/<start>:<end>/smithers-orchestrator
//   GitHub: gh api repos/smithersai/smithers  (+ /stargazers /contributors)
//
// To refresh: re-run those endpoints and paste the new monthly buckets here.

const DATA = {
  asOf: "Jun 2026",
  launched: "Jan 2026",
  // npm downloads, smithers-orchestrator
  downloadsAllTime: 36_913,
  downloadsLast30d: 21_001,
  downloadsLastWeek: 7_953,
  downloadsMonthly: [
    { label: "Jan", value: 3_235, display: "3.2k" },
    { label: "Feb", value: 2_608, display: "2.6k" },
    { label: "Mar", value: 2_760, display: "2.8k" },
    { label: "Apr", value: 4_827, display: "4.8k" },
    { label: "May", value: 7_224, display: "7.2k" },
    { label: "Jun", value: 16_259, display: "16.3k · month-to-date" },
  ],
  // GitHub stars, cumulative end-of-month
  stars: 268,
  forks: 30,
  starsMonthly: [
    { label: "Jan", value: 48, display: "48" },
    { label: "Feb", value: 76, display: "76" },
    { label: "Mar", value: 96, display: "96" },
    { label: "Apr", value: 119, display: "119" },
    { label: "May", value: 232, display: "232" },
    { label: "Jun", value: 268, display: "268" },
  ],
  externalContributors: 15,
  commits: 3_018,
};

// ─── ansi + tty helpers ──────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  grey: "\x1b[90m",
  white: "\x1b[37m",
};

const write = (s: string) => process.stdout.write(s);
const clearScreen = () => write("\x1b[2J\x1b[H");
const hideCursor = () => write("\x1b[?25l");
const showCursor = () => write("\x1b[?25h");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(1, ms)));
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visibleLen = (s: string) => stripAnsi(s).length;

const hr = (color = C.grey, w = 78) => write(`${color}${"─".repeat(w)}${C.reset}\n`);

function box(title: string, lines: string[], color = C.cyan, width = 76) {
  write(`${color}┌${"─".repeat(width)}┐${C.reset}\n`);
  if (title) {
    const pad = width - title.length - 2;
    write(`${color}│${C.reset} ${C.bold}${title}${C.reset}${" ".repeat(Math.max(0, pad))}${color}│${C.reset}\n`);
    write(`${color}├${"─".repeat(width)}┤${C.reset}\n`);
  }
  for (const line of lines) {
    const pad = Math.max(0, width - visibleLen(line) - 2);
    write(`${color}│${C.reset} ${line}${" ".repeat(pad)} ${color}│${C.reset}\n`);
  }
  write(`${color}└${"─".repeat(width)}┘${C.reset}\n`);
}

// Horizontal bar chart → array of lines (feed into box()).
function barChart(
  rows: { label: string; value: number; display?: string }[],
  opts: { width?: number; color?: string; labelWidth?: number } = {},
) {
  const width = opts.width ?? 44;
  const color = opts.color ?? C.cyan;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const labelW = opts.labelWidth ?? Math.max(...rows.map((r) => r.label.length));
  return rows.map((r) => {
    const filled = r.value <= 0 ? 0 : Math.max(1, Math.round((r.value / max) * width));
    const bar = "█".repeat(filled);
    const label = `${C.dim}${r.label.padEnd(labelW)}${C.reset}`;
    const disp = r.display ?? String(r.value);
    return `${label}  ${color}${bar}${C.reset} ${C.bold}${disp}${C.reset}`;
  });
}

// ─── audio (with cancellation) ───────────────────────────────────────────────

type Ctx = InvestorInput & { muted: boolean };

type ActiveNarration = {
  child: import("node:child_process").ChildProcess;
  exited: Promise<void>;
};

let activeNarration: ActiveNarration | null = null;

async function speakStart(text: string, ctx: Ctx) {
  await speakStop();
  if (ctx.silent || ctx.muted || !text) return;

  // `say` is a macOS facility, not a runtime dependency. Other platforms run
  // the complete deck without narration unless a future native adapter is
  // added for them.
  if (process.platform !== "darwin") return;

  const { spawn } = await import("node:child_process");
  const child = spawn("say", ["-v", ctx.voice, "-r", String(ctx.rate), text], {
    stdio: "ignore",
  });

  const exited = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("close", finish);
    child.once("error", finish);
  });

  const narration = { child, exited };
  activeNarration = narration;
  void exited.then(() => {
    if (activeNarration === narration) activeNarration = null;
  });
}

async function speakStop() {
  const narration = activeNarration;
  activeNarration = null;
  if (!narration) return;

  try {
    if (narration.child.exitCode === null && narration.child.signalCode === null) {
      narration.child.kill("SIGTERM");
    }
  } catch {}

  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  if (narration.child.exitCode === null && narration.child.signalCode === null) {
    forceKillTimer = setTimeout(() => {
      try {
        narration.child.kill("SIGKILL");
      } catch {}
    }, 1_000);
  }

  try {
    await narration.exited;
  } finally {
    if (forceKillTimer) clearTimeout(forceKillTimer);
  }
}

// ─── slide chrome ────────────────────────────────────────────────────────────

const W = 78;

function header(title: string, subtitle: string, n: number, total: number) {
  clearScreen();
  hideCursor();
  const tag = "smithers · investor deck";
  write(
    `${C.dim}${tag}${C.reset}${" ".repeat(W - tag.length - `${n}/${total}`.length)}${C.dim}${n}/${total}${C.reset}\n`,
  );
  hr();
  write(`\n  ${C.bold}${C.yellow}${title}${C.reset}\n`);
  if (subtitle) write(`  ${C.dim}${subtitle}${C.reset}\n`);
  write("\n");
}

function footer() {
  write("\n");
  hr();
  const help = `${C.dim}◂ prev   ▸ next   r replay   m mute   q quit${C.reset}`;
  write(`${help}\n`);
}

// ─── keyboard input ──────────────────────────────────────────────────────────

export type InvestorKey = "next" | "prev" | "replay" | "mute" | "quit" | "skip";

const INVESTOR_KEYS = new Map<string, InvestorKey>([
  ["\x1b[C", "next"],
  ["\x1b[B", "next"],
  [" ", "next"],
  ["\r", "next"],
  ["\n", "next"],
  ["\r\n", "next"],
  ["j", "next"],
  ["l", "next"],
  ["\x1b[D", "prev"],
  ["\x1b[A", "prev"],
  ["h", "prev"],
  ["k", "prev"],
  ["r", "replay"],
  ["m", "mute"],
  ["s", "skip"],
  ["q", "quit"],
  ["\x1b", "quit"],
  ["\x03", "quit"],
]);

/** Convert one raw-mode stdin chunk into a deck action. */
export function parseInvestorKey(chunk: string): InvestorKey | null {
  const normalized = chunk.length === 1 ? chunk.toLowerCase() : chunk;
  return INVESTOR_KEYS.get(normalized) ?? null;
}

function startKeyboard(onKey: (k: InvestorKey) => void): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {};
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const handler = (chunk: string) => {
    const key = parseInvestorKey(chunk);
    if (key) onKey(key);
  };
  stdin.on("data", handler);

  return () => {
    stdin.off("data", handler);
    try {
      stdin.setRawMode?.(false);
    } catch {}
    stdin.pause();
  };
}

// ─── slide content ───────────────────────────────────────────────────────────

type Slide = {
  title: string;
  subtitle?: string;
  narration: string;
  render: (ctx: Ctx) => Promise<void> | void;
};

const SLIDES: Slide[] = [
  // ─── ACT 1 — cold open + the problem ─────────────────────────────────────
  {
    title: "SMITHERS",
    subtitle: "durable orchestration for background AI agents · investor deck",
    narration:
      "Hi. This is Smithers. " +
      "Over the next fifteen minutes I'll walk you through the problem we solve, " +
      "the product, the market we're going after, " +
      "our traction so far, and how we make money. " +
      "Short version: every company now wants AI to do real work in the background, " +
      "and the plumbing to make that reliable doesn't exist yet. We're building it.",
    render: () => {
      const banner = [
        "",
        "   ███████╗███╗   ███╗██╗████████╗██╗  ██╗███████╗██████╗ ███████╗",
        "   ██╔════╝████╗ ████║██║╚══██╔══╝██║  ██║██╔════╝██╔══██╗██╔════╝",
        "   ███████╗██╔████╔██║██║   ██║   ███████║█████╗  ██████╔╝███████╗",
        "   ╚════██║██║╚██╔╝██║██║   ██║   ██╔══██║██╔══╝  ██╔══██╗╚════██║",
        "   ███████║██║ ╚═╝ ██║██║   ██║   ██║  ██║███████╗██║  ██║███████║",
        "   ╚══════╝╚═╝     ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝",
        "",
      ];
      for (const line of banner) write(`${C.cyan}${line}${C.reset}\n`);
      write(`\n${C.dim}        the durable control plane for humans + agents doing real work${C.reset}\n`);
      write("\n");
      write(
        `     ${C.green}${DATA.downloadsAllTime.toLocaleString()}+ downloads${C.reset}${C.dim}   ·   ${C.reset}${C.yellow}${DATA.stars} stars${C.reset}${C.dim}   ·   ${C.reset}${C.cyan}${DATA.externalContributors}+ external contributors${C.reset}${C.dim}   ·   open source${C.reset}\n`,
      );
      write(`\n\n${C.dim}     press ▸ to continue${C.reset}\n`);
    },
  },

  {
    title: "THE PROBLEM",
    subtitle: "Everyone wants AI to do the work. Almost no one can make it reliable.",
    narration:
      "The problem. " +
      "Every small and medium business has dozens of multi-step processes that are begging to be automated. " +
      "And for the first time, AI agents are good enough to actually do them. " +
      "But there's a gap. " +
      "A demo that works once in a chat window is not a process you can run a thousand times a week, unattended, " +
      "where a single crash doesn't drop a customer's refund on the floor. " +
      "Going from a cool demo to something you'd actually trust with the business is where everyone gets stuck.",
    render: () => {
      box(
        "The chasm between a demo and a dependable process",
        [
          "",
          `                ${C.green}AI DEMO${C.reset}                      ${C.red}REAL BUSINESS PROCESS${C.reset}`,
          `   runs         ${C.green}once, you're watching${C.reset}        ${C.red}1000s/week, unattended${C.reset}`,
          `   a crash       ${C.green}refresh the page${C.reset}             ${C.red}a dropped customer${C.reset}`,
          `   waits         ${C.green}seconds${C.reset}                      ${C.red}days (a human must sign off)${C.reset}`,
          `   when wrong    ${C.green}shrug, retry${C.reset}                 ${C.red}money + trust on the line${C.reset}`,
          `   audit         ${C.green}nobody asks${C.reset}                  ${C.red}who approved this? when?${C.reset}`,
          "",
          `   ${C.yellow}The AI got good. The plumbing to run it like a business didn't.${C.reset}`,
          "",
        ],
        C.red,
      );
    },
  },

  {
    title: "WHY THIS IS HARD (AND STAYS HARD)",
    subtitle: "Three traps: a moving target, a substrate nobody builds, one-size-fits-all tools.",
    narration:
      "Why is this hard? Three reasons. " +
      "First, the right way to build an AI agent changes every six months. Chains, then tools, then crews, then background agents. " +
      "If a business couples its automation to this year's fashion, they rebuild it next year. " +
      "Second, the reliability layer underneath — retries, resume-after-crash, pausing for a human, an audit trail — " +
      "is about sixty percent of a real orchestration engine, " +
      "and almost everyone tries to rebuild it by hand on top of a queue and a database, and gets it wrong. " +
      "And third, the orchestration tools that do exist are one-size-fits-all. " +
      "They ship someone else's opinion of the pipeline, baked in, " +
      "and your business process is never quite their business process. " +
      "The substrate, fitted to your problem, is exactly what we sell.",
    render: () => {
      box(
        "Trap 1 — the moving target",
        [
          `   ${C.dim}chains → ReAct → tools → plan-execute → crews → background agents → ?${C.reset}`,
          `   ${C.yellow}couple your business to the topology, and you rebuild every 6 months.${C.reset}`,
        ],
        C.yellow,
      );
      box(
        "Trap 2 — the substrate nobody wants to build",
        [
          `   ${C.red}✗${C.reset} durable steps + resume    ${C.red}✗${C.reset} retries + crash recovery`,
          `   ${C.red}✗${C.reset} pause for a human, free   ${C.red}✗${C.reset} a real audit trail`,
          `   ${C.dim}Infrastructure, not app code. A queue + DB gets you ~60%, badly.${C.reset}`,
        ],
        C.red,
      );
      box(
        "Trap 3 — the tools that exist are one-size-fits-all",
        [
          `   ${C.dim}off-the-shelf orchestrators ship someone else's pipeline, baked in.${C.reset}`,
          `   ${C.yellow}your process isn't their process — and you can't reshape theirs.${C.reset}`,
        ],
        C.magenta,
      );
    },
  },

  // ─── ACT 2 — the solution ────────────────────────────────────────────────
  {
    title: "THE SOLUTION",
    subtitle: "Be the layer that doesn't change.",
    narration:
      "Our solution is to be the layer that doesn't change. " +
      "Underneath every trendy agent pattern there's a stable foundation: steps, state, retries, waiting, and an audit trail. " +
      "Smithers is that foundation, shipped as a tool a developer can drop into any project in one command. " +
      "The fashions on top can change every quarter. We're the part you build on and never throw away.",
    render: () => {
      box(
        "Three layers, three different speeds of change",
        [
          "",
          `   ${C.red}MODEL LAYER${C.reset}            ${C.dim}volatile · changes weekly${C.reset}`,
          `      ${C.dim}GPT · Claude · Gemini · Kimi · whatever wins this month${C.reset}`,
          "",
          `   ${C.yellow}AGENT / TOPOLOGY LAYER${C.reset} ${C.dim}fluid · changes quarterly${C.reset}`,
          `      ${C.dim}ReAct · crew · swarm · background agents · the next fad${C.reset}`,
          "",
          `   ${C.green}ORCHESTRATION LAYER${C.reset}    ${C.bold}stable · this is Smithers · you build on it once${C.reset}`,
          `      ${C.dim}durable steps · retries · state · human-in-the-loop · audit${C.reset}`,
          "",
          `   ${C.dim}We sell the bottom layer. It's the one a business can't live without${C.reset}`,
          `   ${C.dim}and the one they least want to maintain themselves.${C.reset}`,
          "",
        ],
        C.green,
      );
    },
  },

  // ─── ACT 3 — what Smithers actually is ───────────────────────────────────
  {
    title: "SO, WHAT IS SMITHERS?",
    subtitle: "The one sentence, now that you have the problem and the answer.",
    narration:
      "So concretely, what is Smithers? " +
      "Smithers lets a company wire humans and AI agents together as steps in a single, " +
      "long-running workflow that survives crashes, deploys, and overnight waits for a human approval. " +
      "Think of it as the durable control plane underneath all the AI automation a business is about to build.",
    render: () => {
      box(
        "The shape of the thing",
        [
          "",
          `   ${C.dim}A business process today:${C.reset}`,
          `   ${C.dim}intake → triage → draft → human approval → execute → notify${C.reset}`,
          "",
          `   ${C.bold}With Smithers, each box is a node in one durable workflow:${C.reset}`,
          "",
          `      ${C.cyan}[agent]${C.reset} ─▶ ${C.cyan}[agent]${C.reset} ─▶ ${C.yellow}[human approval]${C.reset} ─▶ ${C.cyan}[agent]${C.reset} ─▶ ${C.green}[done]${C.reset}`,
          "",
          `   ${C.green}✓${C.reset} runs for hours or days        ${C.green}✓${C.reset} survives a crash mid-step`,
          `   ${C.green}✓${C.reset} pauses for a human, for free  ${C.green}✓${C.reset} every step is auditable`,
          "",
          `   ${C.dim}Humans and agents are the SAME primitive: a step that can fail and resume.${C.reset}`,
          "",
        ],
        C.cyan,
      );
    },
  },

  {
    title: "HOW IT WORKS",
    subtitle: "A workflow is a tree of steps. State lives in a database. Crash → resume.",
    narration:
      "Here's how it works, mechanically, without the jargon. " +
      "You describe a workflow as a tree of steps. Some steps are agents, some are humans, some are plain code. " +
      "Smithers runs the steps that are ready, writes each result to a database, " +
      "and re-reads the tree against the new state. " +
      "That loop is the whole engine. " +
      "Because the state lives in the database and not in memory, " +
      "a crash isn't a catastrophe — you just re-read the database and keep going from the last finished step. " +
      "And because every step is a row, you get a complete audit trail and even time-travel for free.",
    render: () => {
      write("\n");
      const diagram = [
        `     ${C.cyan}┌────────┐${C.reset}    ${C.cyan}┌─────────┐${C.reset}    ${C.cyan}┌─────────┐${C.reset}    ${C.cyan}┌──────────┐${C.reset}`,
        `     ${C.cyan}│ read   │${C.reset} ─▶ ${C.cyan}│ run the │${C.reset} ─▶ ${C.cyan}│ write   │${C.reset} ─▶ ${C.cyan}│ re-read  │${C.reset}`,
        `     ${C.cyan}│ tree   │${C.reset}    ${C.cyan}│ ready   │${C.reset}    ${C.cyan}│ results │${C.reset}    ${C.cyan}│ w/ state │${C.reset}`,
        `     ${C.cyan}└────────┘${C.reset}    ${C.cyan}└─────────┘${C.reset}    ${C.cyan}└─────────┘${C.reset}    ${C.cyan}└────┬─────┘${C.reset}`,
        `          ${C.grey}▲                                            │${C.reset}`,
        `          ${C.grey}└────────────────────────────────────────────┘${C.reset}`,
        `                    ${C.dim}state in a database, not in memory${C.reset}`,
      ];
      for (const l of diagram) write(`${l}\n`);
      write("\n");
      box(
        "What falls out of that one design choice — for free",
        [
          "",
          `   ${C.green}✓${C.reset} ${C.bold}Crash recovery${C.reset}   ${C.dim}kill it anywhere, resume from the last saved step${C.reset}`,
          `   ${C.green}✓${C.reset} ${C.bold}Pause for humans${C.reset} ${C.dim}a waiting workflow is a row, not a running server — $0${C.reset}`,
          `   ${C.green}✓${C.reset} ${C.bold}Audit trail${C.reset}      ${C.dim}every step, attempt, and approval is queryable${C.reset}`,
          `   ${C.green}✓${C.reset} ${C.bold}Time travel${C.reset}      ${C.dim}fork from any past state, replay, diff — like git for work${C.reset}`,
          "",
          `   ${C.dim}You don't write any of this. It's the substrate. That's the whole pitch.${C.reset}`,
          "",
        ],
        C.green,
      );
    },
  },

  {
    title: "THE PRODUCT",
    subtitle: "Compose workflows from proven blocks — then run them like production.",
    narration:
      "Let me go a little deeper on the product, because the depth is the moat, in two halves. " +
      "On the build side, Smithers is a toolbox, not a rigid framework. " +
      "Three kinds of node — an agent, a human, or plain code, all the same durable step. " +
      "Control flow, human-in-the-loop gates, and a catalog of named patterns shipped as drop-in components: " +
      "review loops, panels, debates, supervisors, sagas. " +
      "We surveyed every orchestration framework and turned the patterns we saw repeatedly into blocks. " +
      "On the run side, it's real production infrastructure: " +
      "a Docker-Compose-style command line, one-command observability, durable scheduling and alerts, " +
      "per-workflow cost budgets, isolation, time travel, " +
      "and the ability for a workflow to serve its own A P I and web interface — " +
      "which is exactly how third parties built their own front-ends on us. " +
      "When we rebuilt a popular agent tool on these blocks, we cut about eighty percent of its code.",
    render: () => {
      box(
        "Compose — building blocks, not a one-size-fits-all framework",
        [
          "",
          `   ${C.cyan}Nodes${C.reset}            ${C.dim}agent · human · code — all one durable step${C.reset}`,
          `   ${C.cyan}Control flow${C.reset}     ${C.dim}sequence · parallel · branch · loop${C.reset}`,
          `   ${C.cyan}Human-in-loop${C.reset}    ${C.dim}approval gates · ask-a-human · wait-for-event${C.reset}`,
          `   ${C.cyan}Pattern catalog${C.reset}  ${C.dim}review loops · panels · debate · supervisor · saga${C.reset}`,
          `   ${C.cyan}Quality + memory${C.reset} ${C.dim}scorers + evals · facts that persist across runs${C.reset}`,
          `   ${C.cyan}Provider-neutral${C.reset} ${C.dim}Claude · GPT · Gemini · Kimi — swap or fall back${C.reset}`,
          `   ${C.cyan}Authoring${C.reset}        ${C.dim}plain TypeScript + 100+ ready-to-edit starters${C.reset}`,
          "",
        ],
        C.cyan,
      );
      box(
        "Run in production — the unsexy 60% nobody wants to build",
        [
          "",
          `   ${C.cyan}Operate${C.reset}        ${C.dim}Docker-Compose-style CLI · supervisor auto-resumes${C.reset}`,
          `   ${C.cyan}Observe${C.reset}        ${C.dim}metrics · traces · event log · one-command Grafana stack${C.reset}`,
          `   ${C.cyan}Schedule${C.reset}       ${C.dim}durable cron + pager-style alerts that survive restarts${C.reset}`,
          `   ${C.cyan}Cost control${C.reset}    ${C.dim}per-workflow token / latency / $ budgets — warn or stop${C.reset}`,
          `   ${C.cyan}Time travel${C.reset}    ${C.dim}fork any past state · replay · diff · hot-edit live runs${C.reset}`,
          `   ${C.cyan}Serve${C.reset}          ${C.dim}serves its own API + UI — what 3rd parties build on${C.reset}`,
          "",
          `   ${C.green}Rebuilt a popular agent tool on these blocks → ~80% less code.${C.reset}`,
          "",
        ],
        C.green,
      );
    },
  },

  {
    title: "WHY AGENTS BUILD BETTER ON SMITHERS",
    subtitle: "We mapped orchestration to React — the one paradigm every model already knows.",
    narration:
      "Here's a non-obvious insight that's becoming one of our biggest advantages. " +
      "Agents, and honestly humans too, are saturated with React and J S X. " +
      "It's the most heavily represented way to build software in any model's training data. " +
      "Orchestration is fundamentally a tree-of-steps problem, and React is a language for composing trees. " +
      "So we mapped the entire orchestration problem onto J S X. " +
      "The payoff is that agents produce far more correct and more complex orchestration graphs on Smithers " +
      "than on imperative code or a domain-specific language, because they're writing the exact thing they know best. " +
      "We have benchmarks proving this, releasing in full next week, " +
      "across both complex orchestration and completing long-running tasks. " +
      "Early numbers: on SWE-EVO, where frontier agents resolve only about twenty to twenty-five percent, " +
      "Smithers resolves seventy-one percent of the d-v-c subset. " +
      "On RoadmapBench we're already above the public state of the art. " +
      "And Claw-Eval-Live, a hundred and five real enterprise workflows, lands next week.",
    render: () => {
      box(
        "Why map orchestration to React?",
        [
          "",
          `   ${C.bold}The insight${C.reset}  ${C.dim}agents + humans are saturated with React / JSX —${C.reset}`,
          `   ${C.dim}the most heavily represented way to build software in training data.${C.reset}`,
          "",
          `   ${C.dim}Orchestration is a tree-of-steps problem. React composes trees.${C.reset}`,
          `   ${C.dim}So we mapped durable orchestration directly onto JSX.${C.reset}`,
          "",
          `   ${C.green}Payoff:${C.reset} ${C.dim}agents write the paradigm they know best, so they produce${C.reset}`,
          `   ${C.dim}more correct, more complex graphs than imperative code or a DSL.${C.reset}`,
          "",
        ],
        C.magenta,
      );
      box(
        "Benchmarks — full results release next week",
        [
          "",
          `   ${C.cyan}SWE-EVO${C.reset}        ${C.dim}long-horizon: build a whole release from its notes${C.reset}`,
          `   ${C.dim}48 tasks · ~874 tests each · frontier agents ~21-25% resolved${C.reset}`,
          `   ${C.green}→ Smithers: 71% resolved on the dvc subset (5/7)${C.reset}`,
          "",
          `   ${C.cyan}RoadmapBench${C.reset}   ${C.dim}multi-target: ~3,700-line, ~51-file upgrades, 5 targets${C.reset}`,
          `   ${C.dim}public SOTA ~0.39 resolved / ~0.69 completion${C.reset}`,
          `   ${C.green}→ Smithers: 0.86 completion, above SOTA (audited subset)${C.reset}`,
          "",
          `   ${C.cyan}Claw-Eval-Live${C.reset} ${C.dim}105 real enterprise workflows · 17 families · top ~84${C.reset}`,
          `   ${C.green}→ Smithers mixture-of-agents: full run lands next week${C.reset}`,
          "",
          `   ${C.dim}+ SWE-Bench Pro (731 professional tasks) on the same harness.${C.reset}`,
          "",
        ],
        C.green,
      );
    },
  },

  {
    title: "WHY IT'S STICKY",
    subtitle: "We don't automate one task. We become the fabric work flows through.",
    narration:
      "Here's why we think this gets sticky, and we're still learning the exact shape of it. " +
      "Most AI tools automate one task. We orchestrate cross-functional collaboration — " +
      "humans and agents as nodes in larger, durable workflows that span teams. " +
      "Once a company's refund process, its onboarding, its incident response, its content pipeline " +
      "all run as Smithers workflows, " +
      "we're not a feature they can swap out. We're the fabric the work flows through. " +
      "Ripping us out means re-plumbing how the company operates.",
    render: () => {
      box(
        "Single-task tool  vs  the collaboration substrate",
        [
          "",
          `   ${C.red}A point AI tool${C.reset}                  ${C.green}Smithers${C.reset}`,
          `   ${C.dim}automates one task${C.reset}               ${C.dim}orchestrates whole processes${C.reset}`,
          `   ${C.dim}one team, one box${C.reset}                ${C.dim}humans + agents across teams${C.reset}`,
          `   ${C.dim}easy to swap out${C.reset}                 ${C.dim}the rails everything else runs on${C.reset}`,
          "",
          `   ${C.dim}As more processes move onto Smithers, switching cost compounds.${C.reset}`,
          `   ${C.dim}Humans-and-agents-as-nodes is the wedge into being load-bearing.${C.reset}`,
          "",
          `   ${C.yellow}Land one workflow. Expand to how the company runs.${C.reset}`,
          "",
        ],
        C.green,
      );
    },
  },

  // ─── ACT 3 — the market ──────────────────────────────────────────────────
  {
    title: "THE MARKET",
    subtitle: "Small + medium businesses automating their workflows.",
    narration:
      "The market we're going after is small and medium businesses automating their workflows " +
      "and making them more efficient. " +
      "This is the part of the economy that has the most repetitive, multi-step process work " +
      "and the least ability to staff a platform team to build reliable automation in-house. " +
      "They can't hire a Temporal team. They can't spend a year building an orchestration layer. " +
      "But they can adopt a tool, and increasingly they can point an AI agent at that tool and have it build the workflow for them. " +
      "That's our entry point.",
    render: () => {
      box(
        "Why small + medium businesses, and why now",
        [
          "",
          `   ${C.cyan}Who${C.reset}    ${C.dim}SMBs with lots of multi-step process work, no platform team${C.reset}`,
          `   ${C.cyan}Pain${C.reset}   ${C.dim}every process is manual or a brittle script that breaks silently${C.reset}`,
          `   ${C.cyan}Now${C.reset}    ${C.dim}AI agents finally good enough to DO the steps — reliability is${C.reset}`,
          `          ${C.dim}the missing piece, and that's exactly what we sell${C.reset}`,
          "",
          `   ${C.green}The unlock:${C.reset} ${C.dim}an SMB doesn't need to hire engineers to adopt us.${C.reset}`,
          `   ${C.dim}An agent reads our docs and writes the workflow. We designed for that.${C.reset}`,
          "",
          `   ${C.yellow}Demand is already crossing the technical fence:${C.reset}`,
          `   ${C.dim}non-technical users are asking us for a Zapier / n8n replacement on Smithers.${C.reset}`,
          `   ${C.dim}That's the SMB workflow-automation market asking for us by name.${C.reset}`,
          "",
        ],
        C.cyan,
      );
    },
  },

  // ─── ACT 4 — traction ────────────────────────────────────────────────────
  {
    title: "TRACTION",
    subtitle: `${DATA.downloadsAllTime.toLocaleString()} downloads · ${DATA.stars} stars · ${DATA.externalContributors}+ external contributors · launched ${DATA.launched}`,
    narration:
      "Now, traction — all real numbers, pulled this week. We launched on N P M in January. " +
      "Downloads: about thirty-seven thousand all-time, twenty-one thousand in just the last thirty days, " +
      "and June is already more than double May with the month not over. " +
      "That's the hockey stick you want — accelerating, not flattening. " +
      "The community tracks it: two hundred sixty-eight GitHub stars, up more than five-x since launch, " +
      "thirty forks, and fifteen-plus external contributors — people who don't work for us — across three thousand commits. " +
      "Open source is our distribution engine: every star is a developer who already trusts the tool.",
    render: () => {
      box(
        "npm downloads · monthly",
        [
          ...barChart(DATA.downloadsMonthly, { color: C.green, width: 40 }),
          `   ${C.dim}all-time ${C.reset}${C.bold}${DATA.downloadsAllTime.toLocaleString()}${C.reset}${C.dim} · last 30d ${C.reset}${C.bold}${DATA.downloadsLast30d.toLocaleString()}${C.reset}${C.dim} · June 2.2× May, still climbing${C.reset}`,
        ],
        C.green,
      );
      box(
        "GitHub stars · cumulative",
        [
          ...barChart(DATA.starsMonthly, { color: C.yellow, width: 40 }),
          `   ${C.dim}${DATA.stars} stars · ${DATA.forks} forks · ${DATA.externalContributors}+ external contributors · 5.6× since launch${C.reset}`,
        ],
        C.yellow,
      );
      write(`  ${C.dim}source: npmjs.org + github.com/smithersai/smithers · as of ${DATA.asOf}${C.reset}\n`);
    },
  },

  {
    title: "WHAT USERS ARE TELLING US",
    subtitle: "A step-function moment — and demand from people who can't code.",
    narration:
      "The qualitative signal matches the numbers, and it's the part that gives me the most conviction. " +
      "Users describe Smithers as a step-function moment in their own productivity. " +
      "One called it their Claude three-point-five moment — that point where a tool quietly resets what you thought was possible. " +
      "And the demand is jumping the technical fence. " +
      "Non-technical people are asking us to build them a Zapier or an n8n replacement on top of Smithers. " +
      "That's the exact small-and-medium-business automation market, asking for us by name, " +
      "before we've spent a dollar on sales.",
    render: () => {
      box(
        "Voice of the customer",
        [
          "",
          `   ${C.green}“${C.reset}${C.bold}A Claude-3.5 step-function moment for my own productivity.${C.reset}${C.green}”${C.reset}`,
          `   ${C.dim}— how multiple users describe adopting Smithers${C.reset}`,
          "",
          `   ${C.green}“${C.reset}${C.bold}Can you build me a Zapier / n8n replacement on this?${C.reset}${C.green}”${C.reset}`,
          `   ${C.dim}— non-technical users, unprompted${C.reset}`,
          "",
          `   ${C.yellow}Why it matters${C.reset}`,
          `   ${C.dim}▸ The wedge from developers → operators → whole orgs is happening organically${C.reset}`,
          `   ${C.dim}▸ Pull from non-technical users = the SMB market is reaching past the dev seat${C.reset}`,
          `   ${C.dim}▸ "Step-function moment" is the language of retention, not curiosity${C.reset}`,
          "",
        ],
        C.green,
      );
    },
  },

  {
    title: "THE OPEN-SOURCE FLYWHEEL",
    subtitle: "Free adoption → contribution + signal → better product — and others build on us.",
    narration:
      "Open source isn't just the vibe, it's the business engine, and it's a flywheel. " +
      "Free adoption brings developers in. Some contribute code and file issues; " +
      "all of them generate signal about what real workloads need, " +
      "which directs the roadmap better than any focus group, and drives our distribution cost to nearly zero. " +
      "The clearest proof it's working: third parties are already building on us. " +
      "People we don't employ have built their own user interfaces on our engine, " +
      "and teams are automating workflows inside Kubernetes — real production infrastructure, not toys. " +
      "Their usage and feature requests feed straight back into our direction. " +
      "Other people are running our R&D in production, for free, and showing us exactly where to go.",
    render: () => {
      write("\n");
      write(
        `   ${C.green}adoption${C.reset} ${C.grey}─▶${C.reset} ${C.cyan}contribute + issues${C.reset} ${C.grey}─▶${C.reset} ${C.yellow}roadmap signal${C.reset} ${C.grey}─▶${C.reset} ${C.magenta}better product${C.reset}\n`,
      );
      write(
        `   ${C.dim}…which drives more adoption (${DATA.downloadsLast30d.toLocaleString()}/mo). Distribution cost trends to zero.${C.reset}\n`,
      );
      write("\n");
      box(
        "Proof it's working — built on Smithers, by people who don't work here",
        [
          "",
          `   ${C.cyan}▸ Third-party UIs${C.reset}         ${C.dim}dashboards + front-ends on the engine${C.reset}`,
          `   ${C.cyan}▸ Kubernetes automation${C.reset}   ${C.dim}real workflows orchestrated in prod clusters${C.reset}`,
          `   ${C.cyan}▸ Custom workflow packs${C.reset}   ${C.dim}domain patterns we never wrote${C.reset}`,
          "",
          `   ${C.dim}their production usage + feature requests ──▶ our roadmap${C.reset}`,
          `   ${C.yellow}Third parties run our R&D in production, free — and show us which${C.reset}`,
          `   ${C.yellow}features enterprises will pay for. ${C.reset}${C.dim}Distribution cost: near zero.${C.reset}`,
          "",
        ],
        C.green,
      );
    },
  },

  // ─── ACT 5 — business model + competition ────────────────────────────────
  {
    title: "HOW WE MAKE MONEY",
    subtitle: "At-cost collaboration tool → monetize enterprise features (BYOK, governance).",
    narration:
      "How we make money. We're still discovering the exact model, and I'll be honest about that, " +
      "but here's the current shape. " +
      "We're building a collaboration tool, similar in spirit to Amp Code, where we control the AI providers " +
      "and offer the AI compute at cost — no markup on tokens. " +
      "That makes us the obvious default for individuals and small teams, because we're the cheapest credible option. " +
      "Then we monetize the enterprise: bring-your-own-key, single sign-on, governance, audit, on-premise, support. " +
      "The open-source engine drives adoption. The at-cost tool drives daily usage. The enterprise features drive revenue.",
    render: () => {
      box(
        "Three tiers, one funnel",
        [
          "",
          `   ${C.green}1 · OPEN SOURCE ENGINE${C.reset}        ${C.dim}free · drives adoption + the flywheel${C.reset}`,
          `       ${C.dim}the durable orchestrator on npm${C.reset}`,
          "",
          `   ${C.cyan}2 · COLLABORATION TOOL${C.reset}        ${C.dim}at cost · we control providers, no token markup${C.reset}`,
          `       ${C.dim}Amp-Code-like · cloud workspaces + a native app · cheapest credible${C.reset}`,
          `       ${C.dim}default → daily usage where humans + agents work side by side${C.reset}`,
          "",
          `   ${C.yellow}3 · ENTERPRISE${C.reset}                ${C.bold}the revenue line${C.reset}`,
          `       ${C.dim}BYOK · SSO · governance · audit · on-prem · support / SLAs${C.reset}`,
          "",
          `   ${C.dim}Adoption is free. Usage is at-cost. Money is in governance + control.${C.reset}`,
          `   ${C.dim}Exact packaging still being worked out — the funnel shape is firm.${C.reset}`,
          "",
        ],
        C.yellow,
      );
    },
  },

  {
    title: "THE COMPETITIVE LANDSCAPE",
    subtitle: "Everyone looks like a competitor if you squint. None sit where we sit.",
    narration:
      "On competition. If you squint, everyone looks like a competitor. " +
      "Temporal is the durable-workflow leader, but it's built for platform engineers writing code, not for AI-native, human-plus-agent workflows. " +
      "The model labs ship their own workflow tools, but those are bets on one topology and they lock you to one provider. " +
      "Amp Code and the coding agents overlap on the collaboration surface, but they're products, not a substrate you build on. " +
      "Our position is the open, durable substrate where humans and agents are first-class nodes, provider-neutral, and agent-authorable. " +
      "I'm happy to go competitor by competitor on the specific differentiation.",
    render: () => {
      box(
        "If you squint, everyone competes — here's where we actually sit",
        [
          "",
          `   ${C.bold}Temporal${C.reset} ${C.dim}(durable-workflow leader)${C.reset}`,
          `      ${C.dim}for platform engineers writing code; not AI-native, no human/agent nodes${C.reset}`,
          "",
          `   ${C.bold}Model-lab workflow tools${C.reset} ${C.dim}(e.g. Claude workflows)${C.reset}`,
          `      ${C.dim}one topology, one provider — lock-in; we're provider-neutral${C.reset}`,
          "",
          `   ${C.bold}Amp Code + coding agents${C.reset}`,
          `      ${C.dim}great products, but a product — not a substrate you compose on${C.reset}`,
          "",
          `   ${C.green}Smithers${C.reset} ${C.dim}= open · durable · provider-neutral · humans + agents as nodes${C.reset}`,
          `   ${C.green}· agent-authorable.${C.reset} ${C.dim}Differentiation is case-by-case — ask me about any of them.${C.reset}`,
          "",
        ],
        C.green,
      );
    },
  },

  // ─── ACT 6 — founder, go-to-market + the ask ─────────────────────────────
  {
    title: "WHY THIS FOUNDER",
    subtitle: "A proven agentic coder building the tool that makes agentic coding a commodity.",
    narration:
      "Let me talk about why I'm the person to build this. " +
      "I'm a highly respected agentic coder. " +
      "I've shipped serious production code using models far weaker than today's — " +
      "including the fastest Ethereum virtual machine ever written, faster than the previous leader, R-E-V-M, " +
      "and I built it with Claude three-point-five. " +
      "I also spent time at Google, " +
      "and a lot of how Smithers organizes large numbers of agents working in parallel " +
      "is taken directly from how Google organizes its monorepo. " +
      "Here's the thesis that ties it together. " +
      "I believe I can raise the skill floor of agentic coders, " +
      "so that being an elite agent-wrangler stops being the differentiator, " +
      "and the only thing that still matters is being a top-tier product developer. " +
      "For my own work, I've mostly already done that with Smithers. " +
      "The company is that personal result, productized.",
    render: () => {
      box(
        "Track record, and the thesis it points to",
        [
          "",
          `   ${C.cyan}Proven operator${C.reset}`,
          `   ${C.dim}▸ Shipped hard production code on far weaker models than today's${C.reset}`,
          `   ${C.dim}▸ Built the fastest EVM ever — beating revm — with Claude 3.5${C.reset}`,
          "",
          `   ${C.cyan}Ex-Google, applied${C.reset}`,
          `   ${C.dim}▸ Smithers' high-throughput agent organization borrows Google's${C.reset}`,
          `   ${C.dim}  monorepo discipline for coordinating work at scale${C.reset}`,
          "",
          `   ${C.yellow}The thesis${C.reset}`,
          `   ${C.dim}Raise the skill floor of agentic coding → being a great agent-wrangler${C.reset}`,
          `   ${C.dim}stops being the moat; product taste does. I've already done this for${C.reset}`,
          `   ${C.dim}my own workflows with Smithers. ${C.reset}${C.green}The company is that result, productized.${C.reset}`,
          "",
        ],
        C.cyan,
      );
    },
  },

  {
    title: "GO-TO-MARKET — REPUTATION-LED",
    subtitle: "Land enterprises through relationships and credibility, not cold sales.",
    narration:
      "On go-to-market. The product lands bottom-up through open source. " +
      "But for enterprise, our wedge is reputation. " +
      "We have a product we genuinely stand by as best in class, " +
      "and we intend to leverage my relationships and standing in the industry to do reputation-based onboarding. " +
      "Concretely: we're in early conversations with Opendoor about bringing me on as a consultant " +
      "to help onboard their organization onto Smithers. " +
      "That's the model — a trusted operator walks an org onto the tool, " +
      "the workflows become load-bearing, and the enterprise relationship grows from there. " +
      "It's far cheaper and far higher-trust than a traditional sales motion.",
    render: () => {
      box(
        "The reputation-led enterprise motion",
        [
          "",
          `   ${C.cyan}1${C.reset} ${C.bold}Best-in-class product${C.reset}    ${C.dim}we stand behind it · OSS credibility de-risks it${C.reset}`,
          `   ${C.cyan}2${C.reset} ${C.bold}Founder relationships${C.reset}    ${C.dim}trust + standing in the industry opens the door${C.reset}`,
          `   ${C.cyan}3${C.reset} ${C.bold}Hands-on onboarding${C.reset}      ${C.dim}walk the org onto real workflows, not a trial${C.reset}`,
          `   ${C.cyan}4${C.reset} ${C.bold}Land + expand${C.reset}            ${C.dim}workflows go load-bearing → enterprise contract${C.reset}`,
          "",
          `   ${C.yellow}In progress: early conversations with Opendoor${C.reset}`,
          `   ${C.dim}re: a consulting engagement to onboard their org onto Smithers.${C.reset}`,
          `   ${C.dim}(early-stage — a live example of the motion, not a closed deal.)${C.reset}`,
          "",
          `   ${C.dim}Reputation-based onboarding: lower CAC, higher trust, stickier landings.${C.reset}`,
          "",
        ],
        C.cyan,
      );
    },
  },

  {
    title: "WHY NOW, WHY US",
    subtitle: "The timing is forced. The wedge is open. The data compounds.",
    narration:
      "Why now and why us. " +
      "Why now: agents just crossed the line from demo to dependable, " +
      "and the reliability layer to run them like a business does not exist yet. That window is open right now. " +
      "Why us: we already have the adoption, the contributor base, a real third-party ecosystem feeding our roadmap, " +
      "and a reputation-led path into the enterprise that most infrastructure startups would kill for. " +
      "We're early, the numbers are accelerating, and the moat — open-source distribution plus switching cost — compounds with every workflow that moves onto us.",
    render: () => {
      box(
        "The case, in five lines",
        [
          "",
          `   ${C.green}▸${C.reset} ${C.bold}Forced timing${C.reset}   ${C.dim}agents got good; the reliability layer doesn't exist yet${C.reset}`,
          `   ${C.green}▸${C.reset} ${C.bold}Real traction${C.reset}   ${C.dim}${DATA.downloadsLast30d.toLocaleString()} downloads/mo, accelerating · ${DATA.stars} stars · ${DATA.externalContributors}+ contributors${C.reset}`,
          `   ${C.green}▸${C.reset} ${C.bold}Live ecosystem${C.reset}  ${C.dim}third-party UIs + k8s automation feeding the roadmap${C.reset}`,
          `   ${C.green}▸${C.reset} ${C.bold}Compounding moat${C.reset} ${C.dim}OSS distribution + switching cost per workflow landed${C.reset}`,
          `   ${C.green}▸${C.reset} ${C.bold}Reputation GTM${C.reset}  ${C.dim}relationship-led enterprise landings (e.g. Opendoor, in progress)${C.reset}`,
          "",
        ],
        C.green,
      );
    },
  },

  {
    title: "LET'S TALK",
    subtitle: "",
    narration:
      "That's Smithers. " +
      "The durable control plane for humans and agents doing real work, " +
      "with real adoption, a turning flywheel, and a credible path into the enterprise. " +
      "I'd love to tell you more, and I want to hear where you'd push on it. Thank you.",
    render: () => {
      write("\n\n");
      write(`        ${C.bold}${C.cyan}SMITHERS${C.reset}\n`);
      write(`        ${C.dim}the durable control plane for humans + agents${C.reset}\n\n`);
      write(
        `        ${C.green}${DATA.downloadsAllTime.toLocaleString()}+ downloads${C.reset}${C.dim}  ·  ${C.reset}${C.yellow}${DATA.stars} stars${C.reset}${C.dim}  ·  ${C.reset}${C.cyan}${DATA.externalContributors}+ external contributors${C.reset}\n`,
      );
      write(
        `        ${C.dim}${DATA.downloadsLast30d.toLocaleString()} downloads in the last 30 days, accelerating${C.reset}\n\n`,
      );
      write(`        ${C.bold}smithers.sh${C.reset}${C.dim}   ·   github.com/smithersai/smithers${C.reset}\n\n`);
      write(`        ${C.dim}Let's talk.${C.reset}\n\n`);
    },
  },
];

// ─── slideshow loop ──────────────────────────────────────────────────────────

async function renderSlide(slide: Slide, idx: number, ctx: Ctx) {
  header(slide.title, slide.subtitle ?? "", idx + 1, SLIDES.length);
  await speakStart(slide.narration, ctx);
  await slide.render(ctx);
  footer();
}

async function runSlideshow(ctx: Ctx, startAt: number) {
  let idx = Math.max(0, Math.min(startAt, SLIDES.length - 1));
  let dirty = true;
  let pendingNav: "next" | "prev" | "replay" | null = null;
  let quit = false;
  let autoTimer: ReturnType<typeof setTimeout> | null = null;

  const clearAutoTimer = () => {
    if (autoTimer !== null) clearTimeout(autoTimer);
    autoTimer = null;
  };

  const isTTY = !!process.stdin.isTTY;
  const auto = ctx.auto || !isTTY;

  let stopKeyboard = () => {};

  try {
    stopKeyboard = startKeyboard((key) => {
      clearAutoTimer();
      if (key === "quit") {
        quit = true;
        return;
      }
      if (key === "mute") {
        ctx.muted = !ctx.muted;
        pendingNav = "replay";
        return;
      }
      if (key === "replay") {
        pendingNav = "replay";
        return;
      }
      if (key === "next" || key === "skip") {
        pendingNav = "next";
        return;
      }
      if (key === "prev") {
        pendingNav = "prev";
        return;
      }
    });

    while (!quit) {
      if (dirty) {
        const slide = SLIDES[idx];
        await renderSlide(slide, idx, ctx);
        dirty = false;
        if (auto) {
          clearAutoTimer();
          autoTimer = setTimeout(() => {
            autoTimer = null;
            if (!pendingNav) pendingNav = "next";
          }, ctx.autoMs);
        }
      }
      while (!pendingNav && !quit) await sleep(50);
      if (quit) break;
      const nav = pendingNav;
      pendingNav = null;
      clearAutoTimer();
      await speakStop();
      if (nav === "next" && idx < SLIDES.length - 1) {
        idx++;
        dirty = true;
      } else if (nav === "next" && idx === SLIDES.length - 1) {
        quit = true;
      } else if (nav === "prev" && idx > 0) {
        idx--;
        dirty = true;
      } else if (nav === "replay") {
        dirty = true;
      }
    }
  } finally {
    clearAutoTimer();
    await speakStop();
    stopKeyboard();
    showCursor();
    write(`\n${C.dim}        — investor deck ended —${C.reset}\n\n`);
  }
}

// ─── workflow ────────────────────────────────────────────────────────────────

export default smithers((ctx) => {
  const input = normalizeInvestorInput(ctx.input);
  const userCtx: Ctx = {
    ...input,
    muted: false,
  };

  return (
    <Workflow name="investor">
      <Task id="slideshow" output={outputs.slideshow}>
        {async () => {
          await runSlideshow(userCtx, input.startAt);
          return { finished: true };
        }}
      </Task>
    </Workflow>
  );
});
