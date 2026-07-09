// smithers-source: authored
// smithers-display-name: Slideshow Demo
/** @jsxImportSource smithers-orchestrator */

/**
 * A keyboard-driven Smithers slide deck for a 5–15 minute screenshare.
 *
 *   ▸ / Space / Enter / Down  — next slide
 *   ◂ / Up                    — previous slide
 *   r                         — replay current slide's narration
 *   m                         — mute / unmute audio for the rest of the deck
 *   q / Esc                   — quit
 *
 * Each slide auto-plays its narration via macOS `say`. Navigating away kills
 * the in-flight `say` process so audio never bleeds into the next slide.
 *
 * Two slides (DURABILITY and TIME TRAVEL) run a REAL nested `smithers up`
 * against the stage workflow at `.smithers/workflows/demo-stage/sample.tsx`.
 *
 * Content tracks the narrative in /docs/why/background-agents.mdx — the
 * shift from synchronous chat to durable background agents, the framework
 * trap, the five primitives, declarative authoring, and named patterns as
 * composable components.
 *
 * Usage (from repo root):
 *   ./.smithers/scripts/run-demo.sh
 *   ./.smithers/scripts/run-demo.sh --silent
 *   ./.smithers/scripts/run-demo.sh --voice Daniel
 */

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const inputSchema = z.object({
  silent: z.boolean().default(false),
  voice: z.string().default("Ava (Premium)"),
  rate: z.number().int().default(195),
  startAt: z.number().int().default(0),
  auto: z.boolean().default(false),
  autoMs: z.number().int().default(8000),
});

const doneSchema = z.object({ finished: z.boolean() });

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  slideshow: doneSchema,
});

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

function printCode(code: string, indent = "  ") {
  const KW = /\b(import|from|export|default|const|let|return|function|async|await|if|else|for|of|new|class|interface|type)\b/g;
  for (const rawLine of code.split("\n")) {
    const line = rawLine
      .replace(/(\/\/[^\n]*)/g, `${C.grey}$1${C.reset}`)
      .replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, `${C.green}$1${C.reset}`)
      .replace(KW, `${C.magenta}$1${C.reset}`)
      .replace(/(<\/?\w+)/g, `${C.cyan}$1${C.reset}`)
      .replace(/(\b\w+)(?==)/g, `${C.yellow}$1${C.reset}`);
    write(`${indent}${line}\n`);
  }
}

// ─── audio (with cancellation) ───────────────────────────────────────────────

type Ctx = { silent: boolean; voice: string; rate: number; muted: boolean; auto: boolean; autoMs: number };

let activeSay: { kill: () => void } | null = null;

async function speakStart(text: string, ctx: Ctx) {
  speakStop();
  if (ctx.silent || ctx.muted || !text) return;
  const { spawn } = await import("node:child_process");
  const p = spawn("say", ["-v", ctx.voice, "-r", String(ctx.rate), text], {
    stdio: "ignore",
  });
  activeSay = { kill: () => { try { p.kill("SIGTERM"); } catch {} } };
  p.on("close", () => {
    if (activeSay && p.killed === false) activeSay = null;
  });
}

function speakStop() {
  if (activeSay) {
    activeSay.kill();
    activeSay = null;
  }
}

// ─── slide chrome ────────────────────────────────────────────────────────────

const W = 78;

function header(title: string, subtitle: string, n: number, total: number) {
  clearScreen();
  hideCursor();
  write(`${C.dim}smithers · slideshow${C.reset}${" ".repeat(W - "smithers · slideshow".length - `${n}/${total}`.length)}${C.dim}${n}/${total}${C.reset}\n`);
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

type Key = "next" | "prev" | "replay" | "mute" | "quit" | "skip";

function startKeyboard(onKey: (k: Key) => void): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {};
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const handler = (chunk: string) => {
    // Arrow keys arrive as escape sequences
    if (chunk === "\x1b[C" || chunk === "\x1b[B" || chunk === " " || chunk === "\r" || chunk === "\n" || chunk === "j" || chunk === "l") onKey("next");
    else if (chunk === "\x1b[D" || chunk === "\x1b[A" || chunk === "h" || chunk === "k") onKey("prev");
    else if (chunk === "r") onKey("replay");
    else if (chunk === "m") onKey("mute");
    else if (chunk === "s") onKey("skip");
    else if (chunk === "q" || chunk === "\x1b" || chunk === "\x03") onKey("quit");
  };
  stdin.on("data", handler);

  return () => {
    stdin.off("data", handler);
    try { stdin.setRawMode?.(false); } catch {}
    stdin.pause();
  };
}

// ─── child process helpers (for real smithers sub-runs) ──────────────────────

const STAGE_DIR = ".smithers/workflows/demo-stage";

function forcedColorEnv() {
  const { NO_COLOR: _noColor, ...env } = process.env;
  return { ...env, FORCE_COLOR: "1" };
}

async function runReal(args: string[], opts: { allowFailure?: boolean } = {}): Promise<number> {
  const { spawn } = await import("node:child_process");
  return new Promise<number>((resolve, reject) => {
    const p = spawn("bun", ["run", "smithers", ...args], {
      cwd: STAGE_DIR,
      stdio: "inherit",
      env: forcedColorEnv(),
    });
    p.on("close", (code) => {
      if (code === 0 || opts.allowFailure) resolve(code ?? 0);
      else reject(new Error(`smithers ${args.join(" ")} exited ${code}`));
    });
    p.on("error", reject);
  });
}

async function startReal(args: string[]) {
  const { spawn } = await import("node:child_process");
  const p = spawn("bun", ["run", "smithers", ...args], {
    cwd: STAGE_DIR,
    stdio: "inherit",
    env: forcedColorEnv(),
  });
  const exited = new Promise<number>((resolve) => p.on("close", (c) => resolve(c ?? 0)));
  return { p, exited };
}

async function wipeStageDb() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  for (const f of ["smithers.db", "smithers.db-shm", "smithers.db-wal"]) {
    try { fs.unlinkSync(path.join(STAGE_DIR, f)); } catch {}
  }
}

// ─── slide content ───────────────────────────────────────────────────────────

type Slide = {
  title: string;
  subtitle?: string;
  narration: string;
  // `render` draws the slide body. It must NOT block on user input — keyboard
  // is handled by the outer slideshow loop.
  render: (ctx: Ctx) => Promise<void> | void;
  // Slides with `demo: true` run an interactive sub-process during render.
  // Keyboard nav is disabled while the demo runs.
  demo?: boolean;
};

// State that demo slides share (the sub-run-id from durability is read back
// by the time-travel slide).
const demoState: { subRunId?: string } = {};

const SLIDES: Slide[] = [
  // ─── ACT 1 — the problem ─────────────────────────────────────────────────
  {
    title: "SMITHERS",
    subtitle: "durable orchestration for background AI agents",
    narration:
      "Hi. This is Smithers. " +
      "Over the next few minutes I'm going to walk through the problem it solves, " +
      "the full set of features it ships with, and a couple of live demos of it doing things " +
      "a queue and a database can't.",
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
      write(`\n${C.dim}            durable AI workflow orchestration as a JSX runtime${C.reset}\n`);
      write(`\n\n${C.dim}     press ▸ to continue${C.reset}\n`);
    },
  },

  // ─── ACT 1 — the problem ─────────────────────────────────────────────────
  {
    title: "THE TREADMILL",
    subtitle: "Every six months, the right way to build an AI agent changes.",
    narration:
      "Every six months, the right way to build an AI agent changes. " +
      "Chains. ReAct. Tools. Plan and execute. Multi-agent. Crews. Swarms. " +
      "If you coupled your infrastructure to any one of these, you've already rebuilt twice. " +
      "And you'll rebuild again.",
    render: () => {
      box(
        "Six months apart, every time",
        [
          "",
          `   2023 Q1   ${C.dim}chains${C.reset}`,
          `   2023 Q3   ${C.dim}ReAct${C.reset}`,
          `   2024 Q1   ${C.dim}tools / function calling${C.reset}`,
          `   2024 Q3   ${C.dim}plan-and-execute, planner+worker${C.reset}`,
          `   2025 Q1   ${C.dim}multi-agent / crews / swarms${C.reset}`,
          `   2025 Q3   ${C.dim}background agents${C.reset}`,
          `   2026 Q1   ${C.dim}? (the meta keeps moving)${C.reset}`,
          "",
          `   ${C.yellow}If your infra is coupled to the topology, you rebuild every time.${C.reset}`,
          "",
        ],
        C.yellow,
      );
    },
  },

  {
    title: "BACKGROUND AGENTS ARE DIFFERENT",
    subtitle: "Synchronous chat is forgiving. Background work isn't.",
    narration:
      "Synchronous chat is forgiving. The user is staring at the screen, retries are free, " +
      "a five minute Lambda is fine. Background agents are a different shape. " +
      "They run for hours. They survive deploys. They pause for a human approval " +
      "that won't arrive until tomorrow. And they have to wake up at the right step.",
    render: () => {
      box(
        "Chat agent vs background agent",
        [
          "",
          `                  ${C.dim}chat${C.reset}                    ${C.dim}background${C.reset}`,
          `   runtime        ${C.green}seconds${C.reset}                 ${C.yellow}hours · days${C.reset}`,
          `   user           ${C.green}staring at screen${C.reset}       ${C.yellow}offline${C.reset}`,
          `   approval       ${C.green}immediate${C.reset}               ${C.yellow}tomorrow morning${C.reset}`,
          `   crash          ${C.green}page refresh${C.reset}            ${C.yellow}lost work${C.reset}`,
          `   deploy         ${C.green}reconnect${C.reset}               ${C.yellow}interrupted mid-task${C.reset}`,
          `   observability  ${C.green}console${C.reset}                 ${C.yellow}???${C.reset}`,
          "",
        ],
        C.magenta,
      );
    },
  },

  {
    title: "THE NAIVE FIX DOESN'T WORK",
    subtitle: "A queue plus a database is 60% of an orchestrator, badly.",
    narration:
      "You can build durable background agents with a queue and a database. " +
      "But you'll reinvent sixty percent of what an honest durable execution layer already does, " +
      "and you'll do it more poorly. " +
      "Retries. Heartbeats. Resume from the right step. Approval suspension. Observability. " +
      "None of these are application code you want to write.",
    render: () => {
      box(
        "What you'll re-implement (and get wrong)",
        [
          "",
          `   ${C.red}✗${C.reset}  durable step state machine`,
          `   ${C.red}✗${C.reset}  heartbeat + stale-claim recovery`,
          `   ${C.red}✗${C.reset}  retry policies with backoff`,
          `   ${C.red}✗${C.reset}  suspension on approval / signal / event`,
          `   ${C.red}✗${C.reset}  resume-at-the-right-step semantics`,
          `   ${C.red}✗${C.reset}  cancellation propagation`,
          `   ${C.red}✗${C.reset}  per-step / per-graph sandboxing`,
          `   ${C.red}✗${C.reset}  structured observability (not just logs)`,
          "",
          `   ${C.dim}This isn't infrastructure you sprinkle on later. It's the substrate.${C.reset}`,
          "",
        ],
        C.red,
      );
    },
  },

  // ─── ACT 2 — the shape of the answer ─────────────────────────────────────
  {
    title: "THE LAYER THAT DOESN'T CHANGE",
    subtitle: "Durable orchestration is the stable layer.",
    narration:
      "Here's the thesis. Underneath every named topology — chains, ReAct, crews, swarms, background agents — " +
      "there's a layer that doesn't change. " +
      "Steps. State. Events. Retries. Observability. " +
      "Smithers exists to be that layer.",
    render: () => {
      box(
        "Three layers, different velocities",
        [
          "",
          `   ${C.red}MODEL LAYER${C.reset}            ${C.dim}volatile · changes weekly${C.reset}`,
          `      ${C.dim}GPT, Claude, Gemini, Kimi, …${C.reset}`,
          "",
          `   ${C.yellow}AGENT / TOPOLOGY LAYER${C.reset} ${C.dim}fluid · changes quarterly${C.reset}`,
          `      ${C.dim}ReAct · crew · swarm · plan-execute · background${C.reset}`,
          "",
          `   ${C.green}ORCHESTRATION LAYER${C.reset}    ${C.bold}stable · this is Smithers${C.reset}`,
          `      ${C.dim}durable steps · retries · state · events · observability${C.reset}`,
          "",
        ],
        C.green,
      );
    },
  },

  {
    title: "THE FIVE PRIMITIVES",
    subtitle: "Five capabilities the substrate has to provide.",
    narration:
      "Five things show up underneath every pattern. " +
      "Durable steps. Persistent state. Parallel work. Event-driven control flow. Structured observability. " +
      "Get these five right and the topology layer above becomes composable, " +
      "not a runtime opinion.",
    render: () => {
      box(
        "Five primitives — uniform Effect-ts effects",
        [
          "",
          `   ${C.cyan}1${C.reset} ${C.bold}Durable steps${C.reset}         ${C.dim}<Task> · output decoded against a Zod schema, persisted${C.reset}`,
          `   ${C.cyan}2${C.reset} ${C.bold}Persistent state${C.reset}      ${C.dim}every output schema becomes a typed SQLite table${C.reset}`,
          `   ${C.cyan}3${C.reset} ${C.bold}Parallel work${C.reset}         ${C.dim}<Parallel> · structured concurrency on Effect fibers${C.reset}`,
          `   ${C.cyan}4${C.reset} ${C.bold}Event-driven flow${C.reset}     ${C.dim}<Signal> <WaitForEvent> <Approval> · durable suspension${C.reset}`,
          `   ${C.cyan}5${C.reset} ${C.bold}Observability${C.reset}         ${C.dim}Prometheus + SQLite event log · every transition is a row${C.reset}`,
          "",
          `   ${C.dim}A retry policy is a Schedule. A dependency is a Layer.${C.reset}`,
          `   ${C.dim}A timeout is Effect.timeout. We didn't invent a parallel ecosystem.${C.reset}`,
          "",
        ],
        C.cyan,
      );
    },
  },

  {
    title: "THE FRAMEWORK TRAP",
    subtitle: "Abstract the primitives. Not the topology.",
    narration:
      "Agent frameworks aren't libraries. They're bets on which agent pattern wins. " +
      "When the pattern shifts, you don't refactor. You rewrite. " +
      "Smithers doesn't pick a topology for you. It hands you a primitive — " +
      "a durable, retryable, observable task — and lets you compose whatever shape your problem needs.",
    render: () => {
      box(
        "Frameworks that age out vs frameworks that don't",
        [
          "",
          `   ${C.red}Topology-shaped${C.reset}                   ${C.green}Substrate-shaped${C.reset}`,
          `   ${C.dim}AutoGPT-style agent loops${C.reset}         ${C.dim}Temporal, Durable Functions${C.reset}`,
          `   ${C.dim}Crew / swarm runtimes${C.reset}             ${C.dim}Effect-ts schedules${C.reset}`,
          `   ${C.dim}Graph-shaped DSL frameworks${C.reset}       ${C.dim}Smithers${C.reset}`,
          "",
          `   ${C.dim}A framework that abstracts the substrate ages fine.${C.reset}`,
          `   ${C.dim}A framework that abstracts the topology ages out when the topology does.${C.reset}`,
          `   ${C.dim}The mistake is conflating the two and throwing both away when one expires.${C.reset}`,
          "",
        ],
        C.green,
      );
    },
  },

  {
    title: "ONE-SIZE-FITS-ALL ORCHESTRATORS",
    subtitle: "Gstack. Paperclips. Smithers is one layer down.",
    narration:
      "Tools like Gstack and Paperclips are one-size-fits-all orchestrators. " +
      "They're useful, they're real products, and they're also topology-shaped — " +
      "they bet on what the right agent pipeline looks like, and they ship that pipeline. " +
      "Smithers is one layer down from that. " +
      "We believe the correct level of abstraction isn't a pre-built orchestrator. " +
      "It's a framework you use to build your own, custom-fitted to your problem. " +
      "Your taste, your topology, your shape. " +
      "We took Gstack, an existing high-token agentic workflow, " +
      "and cut it by roughly eighty percent of its lines of code just by composing Smithers components " +
      "instead of hand-writing the orchestration.",
    render: () => {
      box(
        "Two layers of abstraction. Pick the right one.",
        [
          "",
          `   ${C.red}ONE-SIZE-FITS-ALL ORCHESTRATOR${C.reset}      ${C.dim}what Gstack / Paperclips / etc. ship${C.reset}`,
          `   ${C.dim}└── opinionated pipeline (planner → coder → reviewer → land)${C.reset}`,
          `   ${C.dim}    ├── prompts you can't easily change${C.reset}`,
          `   ${C.dim}    ├── topology you can't easily reshape${C.reset}`,
          `   ${C.dim}    └── ages out when the meta shifts${C.reset}`,
          "",
          `   ${C.green}ORCHESTRATION FRAMEWORK${C.reset}             ${C.dim}what Smithers ships${C.reset}`,
          `   ${C.dim}└── primitives (durable steps, retries, suspension, state)${C.reset}`,
          `   ${C.dim}    └── you compose your own orchestrator on top${C.reset}`,
          "",
          `   ${C.yellow}Gstack rewritten as Smithers components: ~80% fewer lines.${C.reset}`,
          `   ${C.dim}Custom-fitted beats one-size-fits-all every time you can afford to write it.${C.reset}`,
          `   ${C.dim}With agents writing the orchestrator, you can always afford it.${C.reset}`,
          "",
        ],
        C.green,
      );
    },
  },

  {
    title: "PATTERNS AS COMPONENTS",
    subtitle: "We surveyed the field. Anything we saw twice became a component.",
    narration:
      "We did deep research across every agentic orchestration framework and library we could find — " +
      "LangGraph, Crew, Inngest, Temporal, AutoGen, Mastra, " +
      "academic papers, vendor blog posts, open-source repos. " +
      "Any pattern we saw more than once, and felt deserved promotion, " +
      "we abstracted into a Smithers component. " +
      "Anything that didn't quite earn a component lives in the examples folder as a recipe you can copy. " +
      "Review loops. Optimizers. Scan-fix-verify. Panels. Debates. Escalation chains. Sagas. " +
      "Every one ships as a composition on top of the substrate. None baked into the runtime. " +
      "You can read the source. You can fork it. " +
      "When the next pattern with no name yet shows up — and it will — you compose it from the same primitives.",
    render: () => {
      box(
        "How this catalog got built",
        [
          "",
          `   ${C.dim}We surveyed every agentic orchestration framework we could find${C.reset}`,
          `   ${C.dim}— vendors, OSS, papers — and codified what we saw repeatedly.${C.reset}`,
          "",
          `   ${C.green}seen 2+ times · earned promotion${C.reset}     →  ${C.cyan}built-in component${C.reset}`,
          `   ${C.yellow}seen, but pattern is project-specific${C.reset}  →  ${C.cyan}examples/ folder (101 files)${C.reset}`,
          "",
        ],
        C.green,
      );
      box(
        "Patterns shipped as components",
        [
          "",
          `   ${C.cyan}<ReviewLoop>${C.reset}              ${C.dim}producer + reviewer, loop until approved${C.reset}`,
          `   ${C.cyan}<Optimizer>${C.reset}               ${C.dim}generator + evaluator, loop until score${C.reset}`,
          `   ${C.cyan}<ScanFixVerify>${C.reset}           ${C.dim}scanner → parallel fixers → verifier, retry survivors${C.reset}`,
          `   ${C.cyan}<Panel>${C.reset}                   ${C.dim}N reviewers in parallel, moderator synthesizes${C.reset}`,
          `   ${C.cyan}<Debate>${C.reset}                  ${C.dim}proposer vs opponent for N rounds, judge decides${C.reset}`,
          `   ${C.cyan}<GatherAndSynthesize>${C.reset}     ${C.dim}fan out, fan in${C.reset}`,
          `   ${C.cyan}<ClassifyAndRoute>${C.reset}        ${C.dim}classifier → category specialists in parallel${C.reset}`,
          `   ${C.cyan}<EscalationChain>${C.reset}         ${C.dim}tier 1 → tier 2 → human if confidence low${C.reset}`,
          `   ${C.cyan}<Supervisor>${C.reset}              ${C.dim}boss plans, workers execute, boss re-delegates${C.reset}`,
          `   ${C.cyan}<Saga>${C.reset}                    ${C.dim}forward steps + compensations on failure${C.reset}`,
          "",
        ],
        C.cyan,
      );
    },
  },

  // ─── ACT 3 — how Smithers does it ────────────────────────────────────────
  {
    title: "THE RUNTIME LOOP",
    subtitle: "Render → execute → persist → re-render.",
    narration:
      "Mechanically, Smithers is a loop. Render your workflow tree. " +
      "Extract the list of tasks. Execute the ones that are ready. " +
      "Persist their outputs to SQLite. Re-render against the new state. " +
      "That is the entire model.",
    render: () => {
      write("\n");
      const diagram = [
        `       ${C.cyan}┌────────┐${C.reset}     ${C.cyan}┌─────────┐${C.reset}     ${C.cyan}┌─────────┐${C.reset}     ${C.cyan}┌─────────┐${C.reset}`,
        `       ${C.cyan}│ Render │${C.reset} ──▶ ${C.cyan}│ Extract │${C.reset} ──▶ ${C.cyan}│ Execute │${C.reset} ──▶ ${C.cyan}│ Persist │${C.reset}`,
        `       ${C.cyan}│  tree  │${C.reset}     ${C.cyan}│  tasks  │${C.reset}     ${C.cyan}│  ready  │${C.reset}     ${C.cyan}│ outputs │${C.reset}`,
        `       ${C.cyan}└────────┘${C.reset}     ${C.cyan}└─────────┘${C.reset}     ${C.cyan}└─────────┘${C.reset}     ${C.cyan}└────┬────┘${C.reset}`,
        `             ${C.grey}▲                                                │${C.reset}`,
        `             ${C.grey}└────────────────────────────────────────────────┘${C.reset}`,
        `                          ${C.dim}re-render with new state${C.reset}`,
      ];
      for (const l of diagram) write(`${l}\n`);
      write("\n");
      box(
        "Why one-way data flow matters",
        [
          "",
          `   Events update state. State is the source of truth.`,
          `   The plan is a ${C.bold}pure function${C.reset} of state.`,
          "",
          `   ${C.dim}Free time travel — a frame is a snapshot, forking is "throw away rows".${C.reset}`,
          `   ${C.dim}Free resume     — re-render from current state, no event log to replay.${C.reset}`,
          `   ${C.dim}Free SQL debug  — state is queryable, an event chain is not.${C.reset}`,
          "",
        ],
        C.magenta,
      );
    },
  },

  {
    title: "THE AUTHORING LAYER",
    subtitle: "The fourth layer — legible to the agents that edit it.",
    narration:
      "Inngest's three layer model is missing a fourth. " +
      "In twenty twenty six a lot of workflow code is written and re-tuned by other agents. " +
      "The authoring surface has to be legible to the agents that increasingly edit it, " +
      "and to the humans auditing what those agents wrote.",
    render: () => {
      box(
        "Why TypeScript + JSX for authoring",
        [
          "",
          `   ${C.bold}TypeScript${C.reset} because prompts are template strings.`,
          `   ${C.dim}Interpolate. Refactor. Type-check. No DSL.${C.reset}`,
          "",
          `   ${C.bold}JSX${C.reset} because agents are disproportionately good at it.`,
          `   ${C.dim}React is the densest domain in any LLM's training corpus.${C.reset}`,
          `   ${C.dim}Agents write it fluently. Humans audit declarative trees better than imperative graphs.${C.reset}`,
          "",
          `   ${C.bold}MDX${C.reset} because prompt fragments should compose like components.`,
          "",
          `   ${C.dim}This is one bet among many. The substrate would work with any authoring surface.${C.reset}`,
          `   ${C.dim}We picked the one agents already speak.${C.reset}`,
          "",
        ],
        C.yellow,
      );
    },
  },

  {
    title: "A WORKFLOW",
    subtitle: "Three tasks. One real conditional.",
    narration:
      "Here is a real workflow. " +
      "Three tasks in a sequence. " +
      "Sequence already enforces order — fix waits for analyze without you doing anything. " +
      "The interesting bit is the middle one: " +
      "If analyze says a security review is required, an Approval mounts and the workflow durably suspends until a human answers. " +
      "If it doesn't, the approval never exists. " +
      "That conditional is real business logic flowing through J S X, " +
      "and the entire shape of the run can change based on what the agent found.",
    render: () => {
      write("\n");
      printCode(
`<Workflow name="review">
  <Sequence>
    <Task id="analyze" output={outputs.analysis} agent={analyst} retries={3}>
      Analyze {ctx.input.repo}@{ctx.input.sha}
    </Task>

    {analysis?.requiresSecurityReview && (
      <Approval
        id="security-review"
        output={outputs.securityReview}
        request={{
          title:   \`Security review · \${ctx.input.repo}\`,
          summary: analysis.summary,
          severity: analysis.severity,
        }}
        onDeny="fail"
      />
    )}

    <Task id="fix" output={outputs.fix} agent={fixer}>
      Fix the issues:
      {analysis?.issues.map((i) => \`- [\${i.severity}] \${i.description}\`).join("\\n")}
    </Task>
  </Sequence>
</Workflow>`,
      );
      write("\n");
      box(
        "What this gives you, for free",
        [
          "",
          `   ${C.green}✓${C.reset}  Sequence orders execution. ${C.dim}No dependency wiring. No hooks.${C.reset}`,
          `   ${C.green}✓${C.reset}  Output of \`analyze\` is decoded against a Zod schema, persisted.`,
          `   ${C.green}✓${C.reset}  ${C.bold}Real conditional${C.reset} on \`requiresSecurityReview\` — the plan reshapes per run.`,
          `   ${C.green}✓${C.reset}  Approval durably suspends. Run exits cleanly. Costs zero while waiting.`,
          `   ${C.green}✓${C.reset}  Retries default-on. LLMs fail constantly. You shouldn't write that loop.`,
          `   ${C.green}✓${C.reset}  Crash anywhere → resume from the last persisted frame.`,
          "",
        ],
        C.green,
      );
    },
  },

  // ─── ACT 4 — built-in components catalog ────────────────────────────────
  {
    title: "CONTROL FLOW + HITL",
    subtitle: "The core JSX surface.",
    narration:
      "Everything is built on top of nine primitives. " +
      "Workflow, Task, Sequence, Parallel, Branch, Loop for control flow. " +
      "Approval, Signal, and Wait-for-event for durable human-in-the-loop suspension.",
    render: () => {
      box(
        "Control flow",
        [
          "",
          `   ${C.cyan}<Workflow>${C.reset}    ${C.dim}root — names the run, owns the SQLite namespace${C.reset}`,
          `   ${C.cyan}<Task>${C.reset}         ${C.dim}durable step · 3 modes: agent · compute · static${C.reset}`,
          `   ${C.cyan}<Sequence>${C.reset}    ${C.dim}children execute in order${C.reset}`,
          `   ${C.cyan}<Parallel>${C.reset}    ${C.dim}children execute concurrently, maxConcurrency knob${C.reset}`,
          `   ${C.cyan}<Branch>${C.reset}       ${C.dim}if / then / else over persisted state${C.reset}`,
          `   ${C.cyan}<Loop>${C.reset}         ${C.dim}until / maxIterations / onMaxReached${C.reset}`,
          "",
        ],
        C.cyan,
      );
      box(
        "Human-in-the-loop · durable suspension",
        [
          "",
          `   ${C.yellow}<Approval>${C.reset}      ${C.dim}pause for approve / deny, runtime exits, resumes when answered${C.reset}`,
          `   ${C.yellow}<HumanTask>${C.reset}      ${C.dim}structured ask — schema + form, durably waits for response${C.reset}`,
          `   ${C.yellow}<Signal>${C.reset}        ${C.dim}wake on \`smithers signal <run> <name>\`${C.reset}`,
          `   ${C.yellow}<WaitForEvent>${C.reset}   ${C.dim}wake on a webhook, HTTP POST, or external trigger${C.reset}`,
          "",
          `   ${C.dim}A suspended run is a row, not a process. Costs zero while waiting.${C.reset}`,
          "",
        ],
        C.yellow,
      );
    },
  },

  {
    title: "<ReviewLoop> + <Optimizer>",
    subtitle: "Producer/reviewer and generator/evaluator, shipped as JSX.",
    narration:
      "Review-loop pairs a producer with a reviewer and loops until the reviewer approves. " +
      "Optimizer pairs a generator with an evaluator and loops until a target score is reached. " +
      "Both ship in the box. Both are forty lines of source you can read and copy.",
    render: () => {
      printCode(
`<ReviewLoop
  producer={coder}
  reviewer={[primaryReviewer, secondaryReviewer]}     // array = consensus
  produceOutput={outputs.code}
  reviewOutput={outputs.review}                       // must include approved: boolean
  maxIterations={5}
>
  Produce a function that {ctx.input.task}.
</ReviewLoop>

<Optimizer
  generator={promptEngineer}
  evaluator={evaluator}                               // agent or compute fn
  generateOutput={outputs.prompt}
  evaluateOutput={outputs.evaluation}                 // must include score: number
  targetScore={90}
  maxIterations={5}
>
  Generate a prompt for summarising legal documents.
</Optimizer>`,
      );
    },
  },

  {
    title: "…AND HERE IS THEIR SOURCE",
    subtitle: "Pattern components are just compositions. You can read them.",
    narration:
      "And here is what those components actually are. " +
      "Twenty lines of J S X each. Loop wrapping a Sequence wrapping two Tasks. " +
      "Nothing baked into the runtime. " +
      "You can read them. You can fork them. " +
      "When the next pattern with no name yet shows up — and it will — you compose it from the same primitives.",
    render: () => {
      write("\n");
      printCode(
`// packages/components/src/ReviewLoop.tsx
export function ReviewLoop({
  id = "review-loop", producer, reviewer,
  produceOutput, reviewOutput,
  maxIterations = 5, onMaxReached = "return-last",
  children,
}: ReviewLoopProps) {
  const reviewers = Array.isArray(reviewer) ? reviewer : [reviewer];
  return (
    <Loop id={id} until={false} maxIterations={maxIterations} onMaxReached={onMaxReached}>
      <Sequence>
        <Task id={\`\${id}-produce\`} output={produceOutput} agent={producer}>
          {children}
        </Task>
        <Task id={\`\${id}-review\`} output={reviewOutput}
              agent={reviewers.length === 1 ? reviewers[0] : reviewers}
              needs={{ produced: \`\${id}-produce\` }}>
          Review the produced work and decide whether to approve.
        </Task>
      </Sequence>
    </Loop>
  );
}

// packages/components/src/Optimizer.tsx — same shape, swap names
export function Optimizer({
  id = "optimizer", generator, evaluator,
  generateOutput, evaluateOutput,
  maxIterations = 10, onMaxReached = "return-last",
  children,
}: OptimizerProps) {
  const isAgent = typeof evaluator !== "function";
  return (
    <Loop id={id} until={false} maxIterations={maxIterations} onMaxReached={onMaxReached}>
      <Sequence>
        <Task id={\`\${id}-generate\`} output={generateOutput} agent={generator}>
          {children}
        </Task>
        {isAgent
          ? <Task id={\`\${id}-evaluate\`} output={evaluateOutput} agent={evaluator}
                  needs={{ candidate: \`\${id}-generate\` }}>
              Evaluate the generated candidate and provide a score.
            </Task>
          : <Task id={\`\${id}-evaluate\`} output={evaluateOutput}
                  needs={{ candidate: \`\${id}-generate\` }}>
              {evaluator}
            </Task>}
      </Sequence>
    </Loop>
  );
}`,
      );
    },
  },

  {
    title: "<ScanFixVerify> + <Debate> + <Panel>",
    subtitle: "Composable adversarial and parallel-fan-out patterns.",
    narration:
      "Scan-fix-verify: a scanner finds issues, fixers run in parallel, a verifier confirms each fix, survivors retry. " +
      "Debate: a proposer and an opponent argue for N rounds, a judge synthesises. " +
      "Panel: N specialist reviewers in parallel, a moderator synthesises by vote, consensus, or merge.",
    render: () => {
      printCode(
`<ScanFixVerify
  scanner={lintAgent}
  fixer={[fixerA, fixerB, fixerC]}                    // array cycles across issues
  verifier={verifyAgent}
  scanOutput={outputs.scan}     fixOutput={outputs.fix}
  verifyOutput={outputs.verify} reportOutput={outputs.report}
  maxConcurrency={4}            maxRetries={3}
/>

<Debate proposer={pro} opponent={con} judge={judge}
  rounds={3} verdictOutput={outputs.verdict}>
  Should we migrate from Postgres to ClickHouse?
</Debate>

<Panel reviewers={[security, perf, ux, infra]}
  moderator={pm} synthesis="consensus"
  reviewOutput={outputs.reviews} verdictOutput={outputs.verdict}>
  Review the RFC.
</Panel>`,
      );
    },
  },

  {
    title: "MORE PATTERNS",
    subtitle: "All composable. None baked into the runtime.",
    narration:
      "Supervisor is a boss agent that plans, dispatches to workers in parallel, reviews their work, and re-delegates failures. " +
      "Saga runs forward steps with compensations that fire in reverse on failure. " +
      "Kanban runs work items through a configurable column pipeline. " +
      "Escalation chain tries tier one, escalates to tier two if confidence is low, then to a human. " +
      "Classify-and-route sorts items into categories and dispatches to category specialists. " +
      "All of these are JSX components on top of the substrate.",
    render: () => {
      box(
        "Built-in pattern components",
        [
          "",
          `   ${C.cyan}<Supervisor>${C.reset}            ${C.dim}boss plans · workers parallel · re-delegate failures${C.reset}`,
          `   ${C.cyan}<Saga>${C.reset}                  ${C.dim}forward steps + compensations on failure${C.reset}`,
          `   ${C.cyan}<Kanban>${C.reset}                ${C.dim}items flow through configurable columns${C.reset}`,
          `   ${C.cyan}<MergeQueue>${C.reset}            ${C.dim}serialise risky ops · single in-flight rule${C.reset}`,
          `   ${C.cyan}<EscalationChain>${C.reset}       ${C.dim}tier 1 → tier 2 → human on low confidence${C.reset}`,
          `   ${C.cyan}<ClassifyAndRoute>${C.reset}      ${C.dim}classifier → category specialists in parallel${C.reset}`,
          `   ${C.cyan}<GatherAndSynthesize>${C.reset}   ${C.dim}fan out to N sources · synthesise the result${C.reset}`,
          `   ${C.cyan}<CheckSuite>${C.reset}            ${C.dim}declare must-pass checks · gate downstream${C.reset}`,
          `   ${C.cyan}<DecisionTable>${C.reset}         ${C.dim}rule-based dispatch, deterministic${C.reset}`,
          `   ${C.cyan}<Poller>${C.reset}                ${C.dim}poll external condition with backoff${C.reset}`,
          `   ${C.cyan}<Runbook>${C.reset}               ${C.dim}declarative ops procedures${C.reset}`,
          `   ${C.cyan}<DriftDetector>${C.reset}         ${C.dim}detect changes against a baseline${C.reset}`,
          `   ${C.cyan}<ContentPipeline>${C.reset}       ${C.dim}staged content transforms${C.reset}`,
          `   ${C.cyan}<LoopUntilScored>${C.reset}       ${C.dim}like Loop but exits on score threshold${C.reset}`,
          `   ${C.cyan}<TryCatchFinally>${C.reset}       ${C.dim}structured error handling${C.reset}`,
          `   ${C.cyan}<Timer>${C.reset}                 ${C.dim}durable sleep${C.reset}`,
          "",
        ],
        C.cyan,
      );
    },
  },

  {
    title: "ISOLATION",
    subtitle: "Sandboxes, worktrees, subflows, and sub-workflows.",
    narration:
      "Tasks need isolation. Sometimes per-step, sometimes per-graph. " +
      "Sandbox runs a child workflow or a single step in an isolated runtime. " +
      "Worktree gives each parallel agent its own git worktree so they don't fight over port five thousand one seventy three. " +
      "Subflow embeds another workflow file as a single node. " +
      "Super-smithers spawns a whole nested workflow with its own database scope.",
    render: () => {
      printCode(
`const remoteVmProvider = {
  id: "remote-vm",
  async run(request) {
    return runRemoteVm(request);
  },
};

<Worktree path=".worktrees/feature-a" baseBranch="main">
  <Parallel>
    <Task id="fix-a" output={outputs.patch} agent={fixer}>Fix issue A</Task>
    <Task id="fix-b" output={outputs.patch} agent={fixer}>Fix issue B</Task>
  </Parallel>
</Worktree>

<Sandbox
  id="exec"
  provider={remoteVmProvider}
  workflow={testWorkflow}
  input={{ patch: outputs.patch }}
  output={outputs.sandbox}
/>

<Subflow workflow={reviewWorkflow} input={{ repo, sha }} output={outputs.review} />
<SuperSmithers strategy={strategyDoc} agent={engineer} reportOutput={outputs.report} />`,
      );
      write("\n");
      write(`  ${C.dim}Pluggable sandbox providers: VM adapters, local transports, or custom runners.${C.reset}\n`);
    },
  },

  // ─── ACT 5 — beyond the JSX surface ──────────────────────────────────────
  {
    title: "<Aspects>",
    subtitle: "Cross-cutting budgets — tokens, latency, cost.",
    narration:
      "Wrap any subtree in Aspects to propagate budgets to descendant tasks. " +
      "Token budget. Latency S L O. Cost budget. Each can fail, warn, or skip-remaining when exceeded. " +
      "Nested Aspects inherit. Inner fields override per-config.",
    render: () => {
      printCode(
`<Workflow name="budgeted">
  <Aspects
    tokenBudget={{ max: 100_000, perTask: 25_000, onExceeded: "warn" }}
    latencySlo ={{ maxMs: 30_000,                onExceeded: "fail" }}
    costBudget ={{ maxUsd: 5.0,                  onExceeded: "skip-remaining" }}
    tracking   ={{ tokens: true, latency: true, cost: true }}
  >
    <Task id="analyse" output={outputs.analysis} agent={analyst}>...</Task>
    <Task id="review"  output={outputs.review}   agent={reviewer}>...</Task>
  </Aspects>
</Workflow>`,
      );
      write("\n");
      box(
        "Budget enforcement",
        [
          "",
          `   ${C.dim}Token / latency / cost counts are accumulated per-run.${C.reset}`,
          `   ${C.dim}Reset on resume. Emitted to Prometheus.${C.reset}`,
          `   ${C.dim}A retry policy is a Schedule. A timeout is Effect.timeout.${C.reset}`,
          `   ${C.dim}You're composing Effect-ts primitives, not bespoke knobs.${C.reset}`,
          "",
        ],
        C.green,
      );
    },
  },

  {
    title: "SCORERS · EVALS",
    subtitle: "Quality gates on every task output.",
    narration:
      "Every task can have scorers attached. Smithers ships built-ins for faithfulness, relevancy, schema adherence, toxicity, and latency. " +
      "Plus an L L M judge scorer for everything else. " +
      "Scores aggregate. They emit to Prometheus. They show up in the dashboard, and you can query them from the C L I with smithers scores.",
    render: () => {
      printCode(
`import { llmJudge, faithfulness, relevancy, schemaAdherence } from
  "smithers-orchestrator/scorers";

<Task
  id="answer"
  output={outputs.answer}
  agent={researcher}
  scorers={[
    faithfulness({ source: "context" }),               // grounded in the input
    relevancy({ question: ctx.input.question }),       // answers the question
    schemaAdherence(),                                 // matches the Zod schema
    llmJudge({                                         // custom L L M judge
      model: openai("gpt-5.6-sol"),
      rubric: "Score 0-100 on clarity and concision.",
    }),
  ]}
>
  {\`Answer: \${ctx.input.question}\`}
</Task>`,
      );
      write(`\n  ${C.dim}smithers scores <run-id>    # tabular view, per-task, per-scorer${C.reset}\n`);
    },
  },

  {
    title: "MEMORY",
    subtitle: "Cross-run state. Outputs are per-run, memory survives.",
    narration:
      "Outputs are per-run. Memory is per-namespace and survives every workflow execution. " +
      "Three layers — facts with optional T T L, ordered message history, and maintenance for compaction. " +
      "On any task you can set memory dot recall to auto-inject the top K most relevant past facts into the prompt.",
    render: () => {
      printCode(
`import { createMemoryStore } from "smithers-orchestrator/memory";
const ns = { kind: "workflow", id: "code-review" };

<Task
  id="review"
  output={outputs.review}
  agent={reviewer}
  memory={{
    recall: { namespace: ns, topK: 3 },              // auto-inject past facts
    save:   { namespace: ns, key: ({ run, out }) =>
                              \`review:\${run.id}\` },    // persist this output
  }}
>
  Review {ctx.input.diff}
</Task>

// Or imperatively:
store.setFact(ns, "code-style", { tabs: 2, semi: true }, 30 * 24 * 3600_000);`,
      );
    },
  },

  {
    title: "TOOLS · AGENTS · MCP",
    subtitle: "Sandboxed tools, any agent CLI, OpenAPI generator, MCP server.",
    narration:
      "Smithers ships read, write, edit, bash, and grep tools with path containment — pass --root to set the sandbox boundary. " +
      "Agents are pluggable: claude, codex, antigravity, kimi, amp, forge, or anything that implements the Agent interface. " +
      "Agent fallback lets you write agent equals an array — primary first, fallback on failure. " +
      "Smithers openapi generates AI SDK tools from an OpenAPI spec. " +
      "And smithers itself can run as an M C P server with smithers mcp add.",
    render: () => {
      box(
        "Tools, agents, integrations",
        [
          "",
          `   ${C.cyan}Built-in tools${C.reset}     ${C.dim}read · write · edit · bash · grep · ls (path-contained)${C.reset}`,
          `   ${C.cyan}Agent fallback${C.reset}     ${C.dim}agent={[codex, claude]}  // codex first, claude on fail${C.reset}`,
          `   ${C.cyan}Agent runtimes${C.reset}     ${C.dim}claude · codex · antigravity · kimi · amp · forge · Effect-native${C.reset}`,
          `   ${C.cyan}MDX prompts${C.reset}        ${C.dim}prompt fragments with typed props · imports compose${C.reset}`,
          `   ${C.cyan}OpenAPI tools${C.reset}      ${C.dim}smithers openapi <spec> → typed AI SDK tool surface${C.reset}`,
          `   ${C.cyan}MCP server${C.reset}         ${C.dim}smithers mcp add  // call workflows from any MCP agent${C.reset}`,
          `   ${C.cyan}Skills sync${C.reset}        ${C.dim}smithers skills add  // bundle skills into agent dirs${C.reset}`,
          "",
        ],
        C.cyan,
      );
    },
  },

  {
    title: "HOT MODE",
    subtitle: "Edit prompts and workflow code while a run is in flight.",
    narration:
      "Pass --hot true to smithers up. Edit the workflow file, edit any M D X prompt, save. " +
      "The runtime detects the change, re-renders the tree against the current persisted state, " +
      "and continues from where it was. " +
      "Tasks that already completed stay in the database. Tasks that haven't run yet use the new code.",
    render: () => {
      box(
        "Hot reload in practice",
        [
          "",
          `   ${C.grey}$${C.reset} ${C.bold}smithers up workflow.tsx --hot true${C.reset}`,
          `   ${C.dim}[00:00:02] ✓ analyze (attempt 1)${C.reset}`,
          `   ${C.dim}[00:00:02] → fix (attempt 1, iteration 0)${C.reset}`,
          "",
          `   ${C.dim}      …meanwhile, in another pane:${C.reset}`,
          `   ${C.green}vim .smithers/prompts/fix.mdx${C.reset}`,
          "",
          `   ${C.dim}[00:00:14] ↻ hot reload — re-rendering tree${C.reset}`,
          `   ${C.dim}[00:00:14] → fix (attempt 2, iteration 0)  ← new prompt, same DB${C.reset}`,
          "",
          `   ${C.dim}Frame numbers march on. The DB is your time machine.${C.reset}`,
          "",
        ],
        C.magenta,
      );
    },
  },

  // ─── ACT 6 — CLI surface ─────────────────────────────────────────────────
  {
    title: "CLI · RUN LIFECYCLE",
    subtitle: "Compose-style commands for managing runs.",
    narration:
      "The C L I follows compose semantics. Up. Ps. Inspect. Logs. Cancel. Down. " +
      "Plus supervise, which polls for stale heartbeats and auto-resumes orphaned runs.",
    render: () => {
      box(
        "Lifecycle commands",
        [
          "",
          `   ${C.cyan}smithers up${C.reset} <file>          ${C.dim}start a run · -d for detached · --serve for HTTP API${C.reset}`,
          `   ${C.cyan}smithers ps${C.reset}                  ${C.dim}active · paused · recently completed${C.reset}`,
          `   ${C.cyan}smithers inspect${C.reset} <run>       ${C.dim}structured state · -w for watch mode${C.reset}`,
          `   ${C.cyan}smithers logs${C.reset} <run>          ${C.dim}NDJSON event log · streamable${C.reset}`,
          `   ${C.cyan}smithers node${C.reset} <run> <node>   ${C.dim}per-task detail: attempts, tool calls, output${C.reset}`,
          `   ${C.cyan}smithers cancel${C.reset} <run>        ${C.dim}safely halt agents · terminate${C.reset}`,
          `   ${C.cyan}smithers down${C.reset}                ${C.dim}cancel ALL active runs · docker-compose-down energy${C.reset}`,
          `   ${C.cyan}smithers supervise${C.reset}           ${C.dim}auto-resume stale runs · --stale-threshold 30s${C.reset}`,
          `   ${C.cyan}smithers why${C.reset} <run>           ${C.dim}explain why a run is blocked / paused${C.reset}`,
          `   ${C.cyan}smithers up --interactive${C.reset}    ${C.dim}pick a workflow · live status card${C.reset}`,
          "",
          `   ${C.dim}--format toon | json | yaml | md | jsonl  — pick your output${C.reset}`,
          "",
        ],
        C.cyan,
      );
    },
  },

  {
    title: "CLI · TIME TRAVEL",
    subtitle: "Every frame is a row. Replay, fork, diff.",
    narration:
      "Every render frame is a database row. " +
      "Timeline lists them. Fork branches from any frame. Replay forks and resumes. " +
      "Diff compares two snapshots. Rewind walks a run back. " +
      "Timetravel reverts the filesystem alongside the database. " +
      "Retry-task re-runs one node without resetting the rest.",
    render: () => {
      box(
        "Time-travel commands",
        [
          "",
          `   ${C.magenta}smithers timeline${C.reset} <run>            ${C.dim}list every frame · --tree includes forks${C.reset}`,
          `   ${C.magenta}smithers fork${C.reset}     <run> --frame N  ${C.dim}branch from any frame${C.reset}`,
          `   ${C.magenta}smithers replay${C.reset}   <run> --frame N  ${C.dim}fork + immediately resume${C.reset}`,
          `   ${C.magenta}smithers rewind${C.reset}   <run> --frame N  ${C.dim}rewind in-place${C.reset}`,
          `   ${C.magenta}smithers diff${C.reset}     <a> <b>          ${C.dim}DiffBundle as a unified diff${C.reset}`,
          `   ${C.magenta}smithers timetravel${C.reset} <wf> -r <run>  ${C.dim}+ revert filesystem state${C.reset}`,
          `   ${C.magenta}smithers retry-task${C.reset} <run> -n <id>  ${C.dim}re-run one node, resume the workflow${C.reset}`,
          `   ${C.magenta}smithers revert${C.reset}   <run> --attempt N ${C.dim}revert FS to a prior task attempt${C.reset}`,
          "",
          `   ${C.dim}State lives in SQLite. Time travel is just SELECT, fork, REPLACE.${C.reset}`,
          "",
        ],
        C.magenta,
      );
    },
  },

  {
    title: "CLI · CRON · ALERTS · HITL",
    subtitle: "Durable scheduling, alerts, signals, human queues.",
    narration:
      "Cron schedules a recurring workflow trigger durably — survives restarts. " +
      "Alerts is the durable equivalent of a pager — a run can raise one and humans can resolve it. " +
      "Signal wakes a workflow blocked on wait-for-event. " +
      "Approve, deny, and human resolve the human-in-the-loop suspension points. " +
      "Memory exposes cross-run facts. Events queries the structured event log. " +
      "Token mints short-lived gateway bearer tokens.",
    render: () => {
      box(
        "Durable extras",
        [
          "",
          `   ${C.yellow}smithers cron${C.reset}             ${C.dim}schedule recurring triggers · durable${C.reset}`,
          `   ${C.yellow}smithers alerts${C.reset}           ${C.dim}list/resolve durable alert instances${C.reset}`,
          `   ${C.yellow}smithers signal${C.reset}           ${C.dim}wake a run blocked on <WaitForEvent>${C.reset}`,
          `   ${C.yellow}smithers approve / deny${C.reset}   ${C.dim}resolve <Approval> gates${C.reset}`,
          `   ${C.yellow}smithers human${C.reset}            ${C.dim}list/resolve <HumanTask> requests${C.reset}`,
          `   ${C.yellow}smithers memory${C.reset}           ${C.dim}query cross-run facts · semantic recall${C.reset}`,
          `   ${C.yellow}smithers events${C.reset}           ${C.dim}query event log · NDJSON · filters · grouping${C.reset}`,
          `   ${C.yellow}smithers token${C.reset}            ${C.dim}issue/revoke short-lived Gateway bearer tokens${C.reset}`,
          `   ${C.yellow}smithers scores${C.reset}           ${C.dim}view scorer results for a run${C.reset}`,
          `   ${C.yellow}smithers ask${C.reset}              ${C.dim}ask the docs MCP server in natural language${C.reset}`,
          "",
        ],
        C.yellow,
      );
    },
  },

  // ─── ACT 7 — live demo ──────────────────────────────────────────────────
  {
    title: "LIVE DEMO — DURABILITY",
    subtitle: "Real workflow. Real crash. Real resume.",
    narration:
      "I'm going to run a real workflow now. Three tasks. " +
      "I'll kill the process while the second task is running, " +
      "then resume it. Watch what gets re-run and what doesn't.",
    demo: true,
    render: async () => {
      write("\n");
      printCode(
`<Workflow name="ship-it">
  <Sequence>
    <Task id="research"  output={outputs.research}>  {/* fast */}
      {async () => { await wait(1.2); return { message: "scanned repo" }; }}
    </Task>
    <Task id="plan"      output={outputs.plan}>      {/* slow on purpose */}
      {async () => { await wait(7);   return { message: "drafted plan" }; }}
    </Task>
    <Task id="implement" output={outputs.implement}>
      {async () => { await wait(1.2); return { message: "patches applied" }; }}
    </Task>
  </Sequence>
</Workflow>`,
      );
      write("\n");

      const subRunId = `demo-${Date.now()}`;
      demoState.subRunId = subRunId;
      await wipeStageDb();

      write(`${C.grey}$${C.reset} ${C.bold}smithers up sample.tsx --run-id ${subRunId}${C.reset}\n\n`);
      const { p, exited } = await startReal(["up", "sample.tsx", "--run-id", subRunId]);
      await sleep(3500);

      write(`\n${C.red}${C.bold}^C${C.reset}  ${C.dim}(closing the laptop)${C.reset}\n\n`);
      p.kill("SIGTERM");
      await exited;
      await sleep(400);

      // release the heartbeat lock (process died ungracefully)
      await runReal(["cancel", subRunId], { allowFailure: true });
      await sleep(200);

      write(`\n${C.grey}$${C.reset} ${C.bold}smithers up sample.tsx --run-id ${subRunId} --resume true --force${C.reset}\n\n`);
      await runReal(["up", "sample.tsx", "--run-id", subRunId, "--resume", "true", "--force"]);
      await sleep(400);

      write(`\n${C.green}✓${C.reset} ${C.bold}Look at the second run:${C.reset}\n`);
      write(`  ${C.dim}research was skipped — already in the database${C.reset}\n`);
      write(`  ${C.dim}plan re-ran as ${C.bold}attempt 2${C.reset}${C.dim} because it was interrupted${C.reset}\n`);
      write(`  ${C.dim}implement ran for the first time${C.reset}\n`);
      write(`  ${C.green}no work lost.${C.reset}\n`);
    },
  },

  {
    title: "LIVE DEMO — TIME TRAVEL",
    subtitle: "Every frame is a snapshot.",
    narration:
      "Every render of the workflow tree is committed to the database as a frame. " +
      "Let me show you the frames from the run we just finished. " +
      "Not a log of what happened — the actual state.",
    demo: true,
    render: async () => {
      const subRunId = demoState.subRunId;
      if (!subRunId) {
        write(`\n  ${C.yellow}(skip — durability demo hasn't run yet; advance back to it first)${C.reset}\n`);
        return;
      }
      write(`\n${C.grey}$${C.reset} ${C.bold}smithers timeline ${subRunId}${C.reset}\n`);
      await runReal(["timeline", subRunId, "--format", "md"], { allowFailure: true });
      write("\n");
      box(
        "What you can do with frames",
        [
          "",
          `   ${C.bold}smithers fork${C.reset}        ${C.dim}branch from any frame${C.reset}`,
          `   ${C.bold}smithers replay${C.reset}      ${C.dim}re-execute from a checkpoint${C.reset}`,
          `   ${C.bold}smithers diff${C.reset}        ${C.dim}compare two snapshots${C.reset}`,
          `   ${C.bold}smithers timetravel${C.reset}  ${C.dim}rewind FS state, edit an output, replay forward${C.reset}`,
          "",
          `   ${C.dim}Git history for AI workflows. The actual state, not just logs of it.${C.reset}`,
          "",
        ],
        C.magenta,
      );
    },
  },

  // ─── ACT 8 — production extras ──────────────────────────────────────────
  {
    title: "OBSERVABILITY",
    subtitle: "Grafana, Prometheus, Tempo, OTLP — one command.",
    narration:
      "Smithers observability brings up a full local stack with one command. " +
      "Grafana for dashboards. Prometheus for metrics. Tempo for traces. " +
      "An OTLP collector so any task can emit spans. " +
      "Every state transition, every attempt, every retry is already a row in the event log — you can SQL it.",
    render: () => {
      box(
        "Bring up the full local stack",
        [
          "",
          `   ${C.grey}$${C.reset} ${C.bold}smithers observability up${C.reset}`,
          `   ${C.dim}→ Grafana       http://localhost:3000${C.reset}`,
          `   ${C.dim}→ Prometheus    http://localhost:9090${C.reset}`,
          `   ${C.dim}→ Tempo         http://localhost:3200${C.reset}`,
          `   ${C.dim}→ OTLP collector :4317 (gRPC) :4318 (HTTP)${C.reset}`,
          "",
          `   ${C.dim}Pre-wired dashboards. No setup. Just \`up\` and open the link.${C.reset}`,
          "",
          `   ${C.green}smithers up workflow.tsx --serve --metrics${C.reset}`,
          `   ${C.dim}→ HTTP API at :7331  /v1/runs  /v1/runs/:id/events (SSE)${C.reset}`,
          `   ${C.dim}→ Prometheus scrape endpoint at :7331/metrics${C.reset}`,
          "",
        ],
        C.green,
      );
    },
  },

  {
    title: "HTTP SERVER · WORKFLOW APPS",
    subtitle: "A workflow can serve its own React UI.",
    narration:
      "Smithers up dash dash serve runs an H T T P server alongside the workflow. " +
      "Routes for listing runs, inspecting one, and a server-sent-events stream for live updates. " +
      "Bearer-token auth. " +
      "Workflows can also serve their own front-end — a workflow ships an H T M L bundle alongside the T S X file, " +
      "and Smithers hands it to any client that asks. Workflows as full apps, not just task graphs.",
    render: () => {
      printCode(
`// .smithers/workflows/kanban.tsx
// .smithers/workflows/kanban.frontend/
//   index.html · assets/ · manifest.json   ← React app, served by smithers

bunx smithers-orchestrator up workflow.tsx \\
  --serve --port 7331 \\
  --auth-token "$SMITHERS_API_KEY" \\
  --metrics

GET  /v1/runs                       # list
GET  /v1/runs/:id                   # detail
GET  /v1/runs/:id/events            # SSE stream
GET  /v1/workflows/:name/app/*      # served front-end
GET  /metrics                       # Prometheus`,
      );
    },
  },

  {
    title: "EFFECT-TS API",
    subtitle: "The substrate, exposed.",
    narration:
      "Underneath the J S X surface is Effect-ts. " +
      "For users who already think in Effect dot gen, Smithers exposes a slightly lower-level Effect A P I " +
      "with full access to schedules, layers, fibers, and resource lifetimes. " +
      "Same substrate. Different authoring surface. You can mix both in one workflow.",
    render: () => {
      printCode(
`import { Smithers } from "smithers-orchestrator";
import { Effect, Schema } from "effect";

const G = Smithers.workflow({
  name: "review",
  input: Schema.Struct({ repo: Schema.String, sha: Schema.String }),
});

const analyze = G.step("analyze", {
  output: Schema.Struct({ summary: Schema.String, risk: Schema.Literal("low","med","high") }),
  timeout: "2m",
  retry: { maxAttempts: 3, backoff: "exponential", initialDelay: "1s" },
  run: ({ input, heartbeat, signal }) =>
    Effect.gen(function* () {
      heartbeat({ phase: "analyzing" });
      return yield* analyzeRepo(input, { signal });
    }),
});`,
      );
      write(`\n  ${C.dim}A retry policy is a Schedule. A dependency is a Layer. A timeout is Effect.timeout.${C.reset}\n`);
    },
  },

  {
    title: "101 EXAMPLES",
    subtitle: "A starter zoo. Pick one and edit.",
    narration:
      "The examples folder ships over a hundred real workflows. " +
      "Review loops, debates, optimizers, parallel ticket processors, refactor pipelines, " +
      "kanban boards, supervisors, classifier switchboards, alert suppressors, doc sync, repo janitors, " +
      "ransomware isolation coordinators, financial inbox guards, " +
      "and a Ralph loop that keeps going until the work is done. " +
      "All on the same substrate.",
    render: () => {
      box(
        "Pick something to start from",
        [
          "",
          `   ${C.cyan}code-review-loop${C.reset}    ${C.dim}producer + reviewer + agent fallback${C.reset}`,
          `   ${C.cyan}debate${C.reset}              ${C.dim}two agents argue, a judge decides${C.reset}`,
          `   ${C.cyan}supervisor${C.reset}          ${C.dim}boss plans, workers in worktrees, re-delegates${C.reset}`,
          `   ${C.cyan}parallel-tickets${C.reset}    ${C.dim}ingest tickets → triage → fix in waves${C.reset}`,
          `   ${C.cyan}kanban${C.reset}              ${C.dim}configurable column pipeline${C.reset}`,
          `   ${C.cyan}prompt-optimizer${C.reset}    ${C.dim}generator + evaluator + target score${C.reset}`,
          `   ${C.cyan}migration${C.reset}           ${C.dim}schema migration with checkpoints + revert${C.reset}`,
          `   ${C.cyan}repo-janitor${C.reset}        ${C.dim}scan, fix, verify across a whole repo${C.reset}`,
          `   ${C.cyan}friday-bot${C.reset}          ${C.dim}weekly digest, cron-triggered${C.reset}`,
          `   ${C.cyan}ralph-loop${C.reset}          ${C.dim}keep going until done${C.reset}`,
          "",
          `   ${C.dim}101 files in examples/. Read one, copy it, edit it.${C.reset}`,
          `   ${C.green}bunx smithers-orchestrator init${C.reset}${C.dim}    ← scaffolds seeded workflows into your repo${C.reset}`,
          "",
        ],
        C.cyan,
      );
    },
  },

  // ─── ACT 9 — what Smithers is ───────────────────────────────────────────
  {
    title: "ONE MORE THING",
    subtitle: "This slideshow is itself a Smithers workflow.",
    narration:
      "Everything you just watched — every slide, the live crash demo, the time travel — " +
      "is itself a Smithers workflow. " +
      "Each slide is rendered by a Task. The keyboard nav is wrapped in the workflow tag. " +
      "If I had killed this process two slides ago and resumed, you would have picked up where I left off.",
    render: () => {
      write("\n");
      printCode(
`export default smithers((ctx) => (
  <Workflow name="demo">
    <Task id="slideshow" output={outputs.slideshow}>
      {async () => {
        for (let i = ctx.input.startAt; i < SLIDES.length; i++) {
          await renderSlide(SLIDES[i], i, ctx);
          await waitForArrowKey();
        }
        return { finished: true };
      }}
    </Task>
  </Workflow>
));`,
      );
      write("\n");
      write(`  ${C.dim}.smithers/workflows/demo.tsx · the whole deck is a single Task${C.reset}\n`);
    },
  },

  {
    title: "THREE LAYERS",
    subtitle: "smithers-orchestrator. The forge. The GUI.",
    narration:
      "Smithers is three things. " +
      "The orchestrator — what you just watched — shipped today on N P M. " +
      "The forge — a J J native code host with cloud workspaces — in build, AGPL. " +
      "And a native macOS app you can download right now.",
    render: () => {
      box(
        "Smithers, three layers",
        [
          "",
          `   ${C.cyan}1${C.reset} ${C.bold}smithers-orchestrator${C.reset}   ${C.dim}shipped today · OSS · npm${C.reset}`,
          `       the durable JSX workflow runtime`,
          `       ${C.green}bunx smithers-orchestrator init${C.reset}`,
          "",
          `   ${C.cyan}2${C.reset} ${C.bold}Smithers (the forge)${C.reset}      ${C.dim}AGPL · in build · ~78% of MVP${C.reset}`,
          `       jj-native code host · landing requests · agent runtime`,
          `       cloud workspaces on Freestyle VMs · BYOK for LLM keys`,
          "",
          `   ${C.cyan}3${C.reset} ${C.bold}Smithers GUI${C.reset}              ${C.dim}native macOS · download today${C.reset}`,
          `       embedded Ghostty terminal · time-travel scrubber`,
          `       picks any agent CLI on PATH (claude / codex / antigravity / kimi / amp / forge)`,
          "",
        ],
        C.cyan,
      );
    },
  },

  {
    title: "READY TO TRY?",
    subtitle: "",
    narration:
      "Try it. B U N X smithers-orchestrator init. Thanks for watching.",
    render: () => {
      write("\n\n\n");
      write(`        ${C.bold}${C.green}bunx smithers-orchestrator init${C.reset}\n`);
      write(`        ${C.dim}scaffolds .smithers/ in any project${C.reset}\n\n\n`);
      write(`        ${C.bold}smithers.sh${C.reset}\n`);
      write(`        ${C.dim}docs · llms-full.txt · GUI download${C.reset}\n\n\n`);
    },
  },
];

// ─── slideshow loop ──────────────────────────────────────────────────────────

async function renderSlide(slide: Slide, idx: number, ctx: Ctx) {
  header(slide.title, slide.subtitle ?? "", idx + 1, SLIDES.length);
  if (!slide.demo) speakStart(slide.narration, ctx);
  await slide.render(ctx);
  footer();
  // for demo slides, narration starts here (after the live process finishes
  // wouldn't make sense; we start it on entry but demos may overlap)
  if (slide.demo) speakStart(slide.narration, ctx);
}

async function runSlideshow(ctx: Ctx, startAt: number) {
  let idx = Math.max(0, Math.min(startAt, SLIDES.length - 1));
  let dirty = true;
  let pendingNav: "next" | "prev" | "replay" | null = null;
  let quit = false;
  let demoInFlight = false;

  // Auto mode kicks in if explicitly requested OR if stdin isn't a TTY (e.g.
  // run from CI or piped). In auto mode each slide advances after autoMs.
  const isTTY = !!process.stdin.isTTY;
  const auto = ctx.auto || !isTTY;

  const stopKeyboard = startKeyboard((key) => {
    if (key === "quit") { quit = true; speakStop(); return; }
    if (demoInFlight) return; // ignore nav while a demo is running
    if (key === "mute") { ctx.muted = !ctx.muted; speakStop(); pendingNav = "replay"; return; }
    if (key === "replay") { pendingNav = "replay"; speakStop(); return; }
    if (key === "next" || key === "skip") { pendingNav = "next"; speakStop(); return; }
    if (key === "prev") { pendingNav = "prev"; speakStop(); return; }
  });

  try {
    while (!quit) {
      if (dirty) {
        const slide = SLIDES[idx];
        demoInFlight = !!slide.demo;
        await renderSlide(slide, idx, ctx);
        demoInFlight = false;
        dirty = false;
        if (auto) {
          // Schedule auto-advance — keyboard nav still wins if user hits a key
          setTimeout(() => { if (!pendingNav) pendingNav = "next"; }, ctx.autoMs);
        }
      }
      while (!pendingNav && !quit) await sleep(50);
      if (quit) break;
      const nav = pendingNav;
      pendingNav = null;
      if (nav === "next" && idx < SLIDES.length - 1) { idx++; dirty = true; }
      else if (nav === "next" && idx === SLIDES.length - 1) { quit = true; }
      else if (nav === "prev" && idx > 0) { idx--; dirty = true; }
      else if (nav === "replay") { dirty = true; }
    }
  } finally {
    speakStop();
    stopKeyboard();
    showCursor();
    write(`\n${C.dim}        — slideshow ended —${C.reset}\n\n`);
  }
}

// ─── workflow ────────────────────────────────────────────────────────────────

export default smithers((ctx) => {
  const userCtx: Ctx = {
    silent: ctx.input.silent,
    voice: ctx.input.voice,
    rate: ctx.input.rate,
    muted: false,
    auto: ctx.input.auto,
    autoMs: ctx.input.autoMs,
  };

  return (
    <Workflow name="demo">
      <Task id="slideshow" output={outputs.slideshow}>
        {async () => {
          await runSlideshow(userCtx, ctx.input.startAt);
          return { finished: true };
        }}
      </Task>
    </Workflow>
  );
});
