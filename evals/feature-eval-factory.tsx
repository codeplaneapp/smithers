/** @jsxImportSource smthrs */
// feature-eval-factory — the durable smithers script behind the goal:
//
//   1. GENERATE — fan out one authoring agent per FeatureGroup in
//      .smithers/specs/features.ts (a MIX of Antigravity, Codex, and Claude
//      Code, rotated by group index). Each agent reads the docs/source and
//      writes a set of NON-TRIVIAL, REALISTIC, multi-feature eval tasks for its
//      group to its own shard (evals/_inventory/generated/<GROUP>.jsonl), then a
//      merge step folds the shards into the curated task bank and regenerates the
//      per-suite cases.jsonl.
//
//   2. OPTIMIZE — a <Loop> that runs the (weak-model) eval suites, scores
//      pass-rate + one-shot-rate, and hands the worst features + friction themes
//      to a fixer agent (same mix) that fixes the ROOT CAUSE in docs/*.mdx and
//      regenerates the bundles — repeating until the suite hits the target
//      (100% pass / 99% one-shot) or maxIterations.
//
//   bunx smthrs up evals/feature-eval-factory.tsx --detach \
//     --input '{"genConcurrency":4,"optimizeModel":"haiku"}'
//
// Per-group shards avoid the concurrent-append corruption that one shared file
// would cause; the merge step is the single writer of curated-tasks.jsonl.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AntigravityAgent,
  ClaudeCodeAgent,
  CodexAgent,
  createSmithers,
  Loop,
  Parallel,
  Sequence,
  Task,
} from "smthrs";
import { homedir } from "node:os";
import { z } from "zod/v4";
import { repoRoot } from "./lib/paths.js";

const ROOT = repoRoot();
const FEATURES = join(ROOT, ".smithers/specs/features.ts");
const CURATED = join(ROOT, "evals/_inventory/curated-tasks.jsonl");
const SHARD_DIR = join(ROOT, "evals/_inventory/generated");
const REPORT_DIR = join(ROOT, "evals/harness/.report");
const CLI = join(ROOT, "apps/cli/src/index.js");

// ── the agent mix ─────────────────────────────────────────────────────────
// Each "slot" is a failover chain led by a distinct primary so the work is a
// genuine MIX of Antigravity + Codex + Claude Code (each leads a share of the
// groups). Array failover recovers RUNTIME provider errors (rate-limit, mid-run
// auth) but NOT a preflight "CLI not installed" on the PRIMARY — that is fatal
// and skips the task. So Antigravity only LEADS when `agy` is actually on PATH
// (self-healing: install + authenticate `agy`, then resume, and it joins the
// rotation). Claude Code authoring runs on Opus — these are complex authoring
// tasks where SOTA quality matters (evals/README.md model policy).
const claude = new ClaudeCodeAgent({ model: "claude-opus-4-8" });
const codex = new CodexAgent({ model: "gpt-5.5", skipGitRepoCheck: true });
const codex1 = new CodexAgent({ model: "gpt-5.5", configDir: join(homedir(), ".codex"), skipGitRepoCheck: true });
const antigravity = new AntigravityAgent({ model: "gemini-3.5-flash", configDir: join(homedir(), ".gemini") });

const AGY_AVAILABLE = typeof Bun !== "undefined" && typeof Bun.which === "function" ? Bun.which("agy") != null : false;

const AUTHOR_SLOTS = AGY_AVAILABLE
  ? [
      [antigravity, codex, claude], // antigravity-primary
      [codex, codex1, claude], // codex-primary
      [claude, codex, codex1], // claude-primary
    ]
  : [
      [codex, codex1, claude], // codex-primary
      [claude, codex, codex1], // claude-primary
      [codex1, claude, codex], // codex1-primary
    ];
// Fixer leads with Codex (rigorous at root-causing docs gaps), then Claude, then (if present) Antigravity.
const FIX_SLOTS = AGY_AVAILABLE
  ? [
      [codex, claude, codex1],
      [claude, codex, codex1],
      [antigravity, codex, claude],
    ]
  : [
      [codex, claude, codex1],
      [claude, codex, codex1],
      [codex1, codex, claude],
    ];

// ── inputs ──────────────────────────────────────────────────────────────────
const inputSchema = z.object({
  groups: z.array(z.string()).nullable().default(null).describe("Subset of FeatureGroup names to cover; null = all 40."),
  genConcurrency: z.number().int().min(1).max(8).default(4).describe("Parallel authoring agents."),
  minTasksPerGroup: z.number().int().min(1).max(60).default(10).describe("Lower bound on complex tasks each agent authors."),
  runOptimization: z.boolean().default(true).describe("Run Phase 2 after generation."),
  optimizeSuites: z.array(z.string()).default(["knowledge-cli", "authoring-workflows"]).describe("Suites the optimization loop runs each iteration."),
  optimizeModel: z.string().default("haiku").describe("Weak candidate model the loop stresses (evals/agents.ts name)."),
  maxCasesPerSuite: z.number().int().min(1).max(200).default(8).describe("Cases per suite per iteration (cost cap)."),
  maxIterations: z.number().int().min(1).max(20).default(3).describe("Optimization-loop iteration cap."),
  targetPass: z.number().min(0).max(1).default(1.0).describe("Target pass rate."),
  targetOneShot: z.number().min(0).max(1).default(0.99).describe("Target one-shot rate."),
});

// ── outputs ───────────────────────────────────────────────────────────────
const authorResult = z.object({
  group: z.string(),
  shardPath: z.string(),
  authored: z.number().describe("Task lines written to the shard."),
  featuresCovered: z.array(z.string()).default([]),
  verifyKinds: z.array(z.string()).default([]),
  sampleIds: z.array(z.string()).default([]),
  notes: z.string().default(""),
});

const mergeResult = z.object({
  shardsRead: z.number(),
  linesSeen: z.number(),
  accepted: z.number().describe("New, schema-valid task lines added to curated."),
  rejectedInvalid: z.number(),
  duplicateSkipped: z.number(),
  curatedTotal: z.number(),
  generatedCases: z.number(),
  deferred: z.number(),
  perSuite: z.array(z.object({ suite: z.string(), count: z.number() })).default([]),
});

const runEvalResult = z.object({
  round: z.number(),
  suites: z.array(z.string()),
  model: z.string(),
  n: z.number(),
  passed: z.number(),
  passRate: z.number(),
  oneShot: z.number(),
  oneShotRate: z.number(),
  worstFeatures: z.array(z.object({ feature: z.string(), passRate: z.number(), n: z.number() })).default([]),
  frictionThemes: z.array(z.object({ kind: z.string(), detail: z.string(), docPointer: z.string().nullable().default(null), count: z.number() })).default([]),
  failures: z.array(z.object({ caseId: z.string(), feature: z.string(), reason: z.string() })).default([]),
});

const fixResult = z.object({
  noChange: z.boolean().default(false),
  docsFiles: z.array(z.string()).default([]),
  evalsRefined: z.array(z.string()).default([]),
  regeneratedBundles: z.boolean().default(false),
  summary: z.string().default(""),
});

const { Workflow, smithers, outputs } = createSmithers(
  { input: inputSchema, author: authorResult, merge: mergeResult, runEval: runEvalResult, fix: fixResult },
  { dbPath: join(ROOT, ".smithers/state/eval-factory.db") },
);

// ── input coalescing ────────────────────────────────────────────────────────
// ctx.input does NOT get zod `.default()`s applied: unprovided fields arrive as
// null, and array fields arrive as JSON STRINGS (e.g. '["a"]'), not arrays. We
// coalesce + parse every field by hand (a documented Smithers footgun).
function asArray(v: unknown, dflt: string[]): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string" && v.trim()) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? (p as string[]) : dflt;
    } catch {
      return dflt;
    }
  }
  return dflt;
}
const asNum = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
const asBool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);
const asStr = (v: unknown, dflt: string): string => (typeof v === "string" && v ? v : dflt);

// ── feature parsing (runtime-safe; no cross-tsconfig import) ─────────────────
// A line-based state machine, NOT a single regex: the `FeatureGroups` literal has
// 2-space `NAME: [` openers, 4-space `"FEATURE",` members, and 2-space `],`
// closers (plus inline empties like `TUI_DASHBOARD: [],`). A non-greedy regex
// mis-pairs the brackets across consecutive groups and silently drops groups, so
// we walk lines and track the open group explicitly.
const GROUP_OPEN = /^ {2}([A-Z][A-Z0-9_]*):\s*\[(.*)$/;
const FEATURE_TOKEN = /"([A-Z][A-Z0-9_]*)"/g;
function parseFeatureGroups(file: string): Array<{ name: string; features: string[] }> {
  const out: Array<{ name: string; features: string[] }> = [];
  let cur: { name: string; features: string[] } | null = null;
  const flush = () => {
    if (cur && cur.features.length) out.push(cur);
    cur = null;
  };
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const open = line.match(GROUP_OPEN);
    if (open) {
      flush();
      cur = { name: open[1], features: [] };
      for (const mm of open[2].matchAll(FEATURE_TOKEN)) cur.features.push(mm[1]);
      if (open[2].includes("]")) flush(); // closed on the same line
      continue;
    }
    if (!cur) continue;
    if (/^ {2}\]/.test(line)) {
      flush();
      continue;
    }
    for (const mm of line.matchAll(FEATURE_TOKEN)) cur.features.push(mm[1]);
  }
  flush();
  if (out.length < 30) throw new Error(`parseFeatureGroups: only found ${out.length} groups in ${file}`);
  return out;
}

// The area vocabulary `generate-cases.ts#routeSuite` understands. A task whose
// `area` is outside this set (and isn't judge-verifiable) gets DEFERRED — i.e.
// dropped from the runnable suites. Authors must pick from here.
const AREA_CHEATSHEET = `VALID \`area\` VALUES (a task with any other area is dropped):
 knowledge/CLI ops  → cli, workflow-execution, workflow-monitoring, workflow-discovery, run-control,
                      agent-interaction, diagnostics, project-setup, testing-evaluation, approvals, configuration
 components         → components-control-flow, components-advanced, control-flow, output-handling, capabilities, patterns
 concepts           → concepts, runtime-concepts, durability-model, knowledge, aspects-budgets
 time travel        → time-travel, time-travel-deep
 scorers/evals      → scorers, evals
 memory             → memory
 examples           → examples
 observability      → observability, devtools
 integrations       → mcp, integrations, human-inbox, scheduling, scheduling-cron-poller
 gateway/serving    → gateway-http-api
 tools              → openapi-tools, openapi-tools-deep, built-in-tools, tool-context
 sandbox/vcs        → sandboxing, vcs, sandbox-runtimes
 agents/models      → agents (anything starting "agent")
 workflow misc      → workflow-integration, optimize`;

const TASK_SCHEMA = `EACH LINE is one JSON object (the eval "task" schema generate-cases.ts consumes):
 {
   "id":            kebab-case, globally unique, prefix "ff-" (feature-factory). REQUIRED.
   "feature":       the FeatureGroups id this primarily exercises (e.g. "CLI_PS_COMMAND"). REQUIRED.
   "area":          one value from the cheatsheet above. REQUIRED.
   "kind":          "knowledge" (name/recall a fact) | "authoring" (write a workflow/code). REQUIRED.
   "tier":          "weak" (default) | "sota" (ONLY for genuinely complex multi-feature authoring). REQUIRED.
   "verify":        "deterministic" (equals/contains/graph chosen automatically) | "judge" (open-ended). REQUIRED.
   "task":          the EXACT prompt handed to the candidate model. REQUIRED. Make it realistic (see below).
   "canonicalAnswer": for knowledge → the short token/CLI verb/component to grep for;
                      for authoring → a sketch listing the <Component> tags the workflow MUST use
                      (the verifier renders via \`smithers graph\` and requires those tags). For judge: omit/"".
   "mustNot":       optional array of forbidden tokens (a hallucinated API the candidate must NOT use).
   "notes":         for verify:"judge" → the GRADING RUBRIC (what a correct answer must contain/do). REQUIRED for judge.
   "source":        "feature-factory"
 }`;

const REALISM = `MAKE THEM NON-TRIVIAL AND REALISTIC — this is the whole point:
 - Do NOT write hyper-isolated "what flag does X" trivia only. Prefer how the feature is REALLY invoked.
 - Many tasks should be MULTI-FEATURE: a realistic workflow/scenario that uses this feature together with
   2-4 others (e.g. a Worktree + Parallel + Approval + scorer; a run that suspended then needs time-travel
   recovery; a db query over a run that has retries, failed children, and approvals in its history).
 - Embed COMPLICATED context: a populated run history, multiple agents, nested child workflows, partial
   failures, loops with accumulated outputs — so the task mirrors a messy real session, not a clean fixture.
 - For authoring (verify:"deterministic" → graph): require several real <Component> tags in canonicalAnswer
   so the render check actually proves composition (Sequence/Parallel/Loop/Worktree/Approval/HumanTask/Signal/
   WaitForEvent/Timer/ReviewLoop/Optimizer/Panel/Debate/Saga/Subflow/MergeQueue/Sandbox — only ones that exist).
 - For knowledge: ask the question the way a confused agent would actually ask it mid-task, not as a quiz.
 - Include some ADVERSARIAL cases that bait a common hallucination (then forbid it via mustNot).
 - Vary verify kinds across the group; cover EVERY feature id in the group with at least one task.`;

function authorPrompt(group: { name: string; features: string[] }, minTasks: number): string {
  return [
    "You are an expert Smithers eval author. Smithers is a durable control plane for coding agents; it is",
    "driven by an AI agent reading its DOCS/SKILL/CLI, so an eval that a weak model fails points at a doc to fix.",
    "",
    `YOUR FEATURE GROUP: ${group.name}`,
    `ITS FEATURE IDS (cover every one with >=1 non-trivial task):`,
    group.features.map((f) => `  - ${f}`).join("\n"),
    "",
    "GROUND YOURSELF IN THE REAL APIS (read, do not rely on memory):",
    "  • skills/smithers/llms-full.txt and docs/llms-*.txt (the shipped docs bundle)",
    "  • .smithers/specs/features.ts (what each id means)",
    "  • evals/README.md (verify kinds) and evals/_inventory/curated-tasks.jsonl (existing tasks — match the format, do NOT duplicate ids/questions)",
    "  • evals/harness/generate-cases.ts (how area→suite routing + verify selection works)",
    "  • the actual source under packages/* and apps/cli/src when you need the precise component name, CLI verb, or signature.",
    "",
    AREA_CHEATSHEET,
    "",
    TASK_SCHEMA,
    "",
    REALISM,
    "",
    `DELIVERABLE: WRITE at least ${minTasks} (ideally ${minTasks * 2}) task objects, one JSON per line, to the file:`,
    `  ${join(SHARD_DIR, `${group.name}.jsonl`)}`,
    "Create the evals/_inventory/generated/ directory if needed. Overwrite that shard file (do not append to a stale one).",
    "Every line MUST be valid JSON with all REQUIRED fields and a real, correct answer grounded in the source.",
    "Then return the structured manifest (group, shardPath, authored count, featuresCovered, verifyKinds, sampleIds, notes).",
    "Do NOT touch any other file. Do NOT run the eval suite.",
  ].join("\n");
}

// ── merge: shards → curated task bank → regenerated suites ───────────────────
const REQUIRED_FIELDS = ["id", "feature", "area", "kind", "tier", "verify", "task"];

function mergeAndRegenerate(): z.infer<typeof mergeResult> {
  const existingIds = new Set<string>();
  if (existsSync(CURATED)) {
    for (const l of readFileSync(CURATED, "utf8").split(/\r?\n/)) {
      const t = l.trim();
      if (!t) continue;
      try {
        existingIds.add(JSON.parse(t).id);
      } catch {
        /* ignore */
      }
    }
  }
  let shardsRead = 0;
  let linesSeen = 0;
  let accepted = 0;
  let rejectedInvalid = 0;
  let duplicateSkipped = 0;
  const toAppend: string[] = [];
  const seenThisRun = new Set<string>();
  if (existsSync(SHARD_DIR)) {
    for (const f of readdirSync(SHARD_DIR).filter((f) => f.endsWith(".jsonl"))) {
      shardsRead += 1;
      for (const l of readFileSync(join(SHARD_DIR, f), "utf8").split(/\r?\n/)) {
        const t = l.trim();
        if (!t) continue;
        linesSeen += 1;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(t);
        } catch {
          rejectedInvalid += 1;
          continue;
        }
        const ok = REQUIRED_FIELDS.every((k) => typeof obj[k] === "string" && (obj[k] as string).length > 0);
        if (!ok || (obj.verify === "judge" && !((obj.notes as string) ?? "").trim())) {
          rejectedInvalid += 1;
          continue;
        }
        const id = obj.id as string;
        if (existingIds.has(id) || seenThisRun.has(id)) {
          duplicateSkipped += 1;
          continue;
        }
        seenThisRun.add(id);
        if (!obj.source) obj.source = "feature-factory";
        toAppend.push(JSON.stringify(obj));
        accepted += 1;
      }
    }
  }
  if (toAppend.length) appendFileSync(CURATED, `${toAppend.join("\n")}\n`);

  // Regenerate every suite's cases.jsonl from the updated bank.
  const gen = spawnSync("bun", [join(ROOT, "evals/harness/generate-cases.ts")], { cwd: ROOT, encoding: "utf8" });
  const stdout = `${gen.stdout ?? ""}`;
  const totalMatch = stdout.match(/Generated (\d+) cases/);
  const deferredMatch = stdout.match(/deferred (\d+)/);
  const perSuite: Array<{ suite: string; count: number }> = [];
  for (const m of stdout.matchAll(/^\s*(\d+)\s+([a-z0-9-]+)\s*$/gm)) perSuite.push({ suite: m[2], count: Number(m[1]) });

  const curatedTotal = existsSync(CURATED)
    ? readFileSync(CURATED, "utf8").split(/\r?\n/).filter((l) => l.trim()).length
    : 0;
  return {
    shardsRead,
    linesSeen,
    accepted,
    rejectedInvalid,
    duplicateSkipped,
    curatedTotal,
    generatedCases: totalMatch ? Number(totalMatch[1]) : 0,
    deferred: deferredMatch ? Number(deferredMatch[1]) : 0,
    perSuite,
  };
}

// ── optimization: run scoped suites, aggregate the report ────────────────────
type CaseRow = {
  caseId: string;
  passed: boolean;
  input?: { model?: string; feature?: string };
  metadata?: { feature?: string };
  output?: {
    candidate?: Array<{ oneShot?: boolean; friction?: Array<{ kind?: string; detail?: string; docPointer?: string | null }> }>;
    verdict?: Array<{ reason?: string }>;
  };
};

function runEvalsAndScore(opts: {
  round: number;
  suites: string[];
  model: string;
  maxCases: number;
}): z.infer<typeof runEvalResult> {
  mkdirSync(REPORT_DIR, { recursive: true });
  const rows: CaseRow[] = [];
  for (const suite of opts.suites) {
    const dir = join(ROOT, "evals/suites", suite);
    if (!existsSync(join(dir, "cases.jsonl"))) continue;
    spawnSync(
      "bun",
      [join(ROOT, "evals/harness/run-suite.ts"), suite, "--only-model", opts.model, "--max-cases", String(opts.maxCases), "-j", "4"],
      { cwd: ROOT, encoding: "utf8", stdio: "inherit", timeout: 45 * 60_000 },
    );
    const reportFile = join(REPORT_DIR, `${suite}-${opts.model}.json`);
    if (!existsSync(reportFile)) continue;
    try {
      const report = JSON.parse(readFileSync(reportFile, "utf8")) as { results?: CaseRow[] };
      for (const r of report.results ?? []) rows.push(r);
    } catch {
      /* skip unreadable */
    }
  }

  const n = rows.length;
  const passed = rows.filter((r) => r.passed).length;
  const oneShot = rows.filter((r) => r.output?.candidate?.[0]?.oneShot).length;

  const feat: Record<string, { n: number; passed: number }> = {};
  const friction: Record<string, { kind: string; detail: string; docPointer: string | null; count: number }> = {};
  const failures: Array<{ caseId: string; feature: string; reason: string }> = [];
  for (const r of rows) {
    const feature = r.metadata?.feature ?? r.input?.feature ?? "unknown";
    (feat[feature] ??= { n: 0, passed: 0 }).n += 1;
    if (r.passed) feat[feature].passed += 1;
    else
      failures.push({
        caseId: r.caseId,
        feature,
        reason: (r.output?.verdict?.[0]?.reason ?? "no verdict").slice(0, 180),
      });
    for (const fr of r.output?.candidate?.[0]?.friction ?? []) {
      const key = `${fr.kind ?? "other"}::${(fr.docPointer ?? "?").slice(0, 50)}`;
      const slot = (friction[key] ??= { kind: fr.kind ?? "other", detail: fr.detail ?? "", docPointer: fr.docPointer ?? null, count: 0 });
      slot.count += 1;
      if (!slot.detail && fr.detail) slot.detail = fr.detail;
    }
  }
  const worstFeatures = Object.entries(feat)
    .map(([feature, v]) => ({ feature, passRate: v.passed / v.n, n: v.n }))
    .filter((x) => x.passRate < 1)
    .sort((a, b) => a.passRate - b.passRate || b.n - a.n)
    .slice(0, 15);
  const frictionThemes = Object.values(friction).sort((a, b) => b.count - a.count).slice(0, 15);

  return {
    round: opts.round,
    suites: opts.suites,
    model: opts.model,
    n,
    passed,
    passRate: n ? passed / n : 0,
    oneShot,
    oneShotRate: n ? oneShot / n : 0,
    worstFeatures,
    frictionThemes,
    failures: failures.slice(0, 25),
  };
}

function fixPrompt(run: z.infer<typeof runEvalResult> | undefined, targetPass: number, targetOneShot: number): string {
  if (!run) return "Awaiting the eval report. Output noChange:true.";
  const green = run.passRate >= targetPass && run.oneShotRate >= targetOneShot;
  return [
    "You are improving Smithers so that a WEAK model can one-shot real tasks from the shipped docs.",
    `LATEST EVAL REPORT (round ${run.round}, model ${run.model}, suites ${run.suites.join(", ")}):`,
    `  pass ${(run.passRate * 100).toFixed(0)}% (${run.passed}/${run.n}) · one-shot ${(run.oneShotRate * 100).toFixed(0)}% · target ${(targetPass * 100).toFixed(0)}%/${(targetOneShot * 100).toFixed(0)}%`,
    green
      ? "The suite already MEETS the target. Make NO changes; output noChange:true with a one-line summary."
      : [
          "WORST FEATURES:",
          run.worstFeatures.map((w) => `  - ${w.feature}: ${(w.passRate * 100).toFixed(0)}% over ${w.n}`).join("\n") || "  (none)",
          "FRICTION THEMES (the agents' own report of what the docs lacked):",
          run.frictionThemes.map((f) => `  - [${f.kind}] ${f.detail} (doc: ${f.docPointer ?? "?"}) ×${f.count}`).join("\n") || "  (none)",
          "SAMPLE FAILURES:",
          run.failures.slice(0, 12).map((f) => `  - ${f.caseId} (${f.feature}): ${f.reason}`).join("\n") || "  (none)",
          "",
          "FIX THE ROOT CAUSE so the NEXT run one-shots these:",
          "  • Prefer fixing the DOCS at source: edit the relevant docs/*.mdx (NOT the generated llms-*.txt),",
          "    making the missing/ambiguous/wrong thing clear and correct. Ground every fix in the real source.",
          "  • After editing docs, regenerate the bundles: run `pnpm docs:llms` (CI gates on check-docs/check-llms).",
          "  • If a failure is the EVAL'S fault (wrong canonicalAnswer / impossible task), you may refine that one",
          "    line in evals/_inventory/curated-tasks.jsonl, then run `bun evals/harness/generate-cases.ts`.",
          "  • Do not weaken evals to pass them. Do not edit files under evals/harness/.report or .smithers/state.",
          "Return what you changed (docsFiles, evalsRefined, regeneratedBundles, summary).",
        ].join("\n"),
  ].join("\n");
}

export default smithers((ctx) => {
  const input = ctx.input;
  const cfg = {
    groups: asArray(input.groups, []),
    genConcurrency: asNum(input.genConcurrency, 4),
    minTasksPerGroup: asNum(input.minTasksPerGroup, 10),
    runOptimization: asBool(input.runOptimization, true),
    optimizeSuites: asArray(input.optimizeSuites, ["knowledge-cli", "authoring-workflows"]),
    optimizeModel: asStr(input.optimizeModel, "haiku"),
    maxCasesPerSuite: asNum(input.maxCasesPerSuite, 8),
    maxIterations: asNum(input.maxIterations, 3),
    targetPass: asNum(input.targetPass, 1.0),
    targetOneShot: asNum(input.targetOneShot, 0.99),
  };
  const allGroups = parseFeatureGroups(FEATURES);
  const wanted = cfg.groups.length ? new Set(cfg.groups) : null;
  const workGroups = wanted ? allGroups.filter((g) => wanted.has(g.name)) : allGroups;

  // Author outputs only include SUCCESSES; failed (continueOnFail) authors produce
  // no row. We do NOT gate merge on a success count — the enclosing <Sequence>
  // already guarantees merge runs only once the whole <Parallel> is terminal
  // (every author succeeded OR was skipped), so a few author failures never stall
  // the pipeline. merge folds in whatever shards were written.
  const merge = ctx.outputMaybe("merge", { nodeId: "merge" }) as z.infer<typeof mergeResult> | undefined;

  const runs = (ctx.outputs.runEval ?? []) as Array<z.infer<typeof runEvalResult>>;
  const latestRun = runs[runs.length - 1];
  const targetMet = !!latestRun && latestRun.passRate >= cfg.targetPass && latestRun.oneShotRate >= cfg.targetOneShot;
  const iterationIndex = runs.length; // 0-based index of the iteration about to run

  return (
    <Workflow name="feature-eval-factory">
      <Sequence>
        {/* ── Phase 1: author complex evals, one agent per FeatureGroup ── */}
        <Parallel maxConcurrency={cfg.genConcurrency}>
          {workGroups.map((group, i) => (
            <Task
              key={group.name}
              id={`author:${group.name}`}
              agent={AUTHOR_SLOTS[i % AUTHOR_SLOTS.length]}
              output={outputs.author}
              retries={1}
              continueOnFail
              timeoutMs={60 * 60_000}
              heartbeatTimeoutMs={12 * 60_000}
            >
              {authorPrompt(group, cfg.minTasksPerGroup)}
            </Task>
          ))}
        </Parallel>

        {/* ── Phase 1b: merge shards → curated bank → regenerate suites ──
            Always rendered; <Sequence> runs it after the <Parallel> is terminal. */}
        <Task id="merge" output={outputs.merge} heartbeatTimeoutMs={10 * 60_000}>
          {() => mergeAndRegenerate()}
        </Task>

        {/* ── Phase 2: optimization loop toward 100% pass / 99% one-shot ── */}
        {merge && cfg.runOptimization ? (
          <Loop until={targetMet} maxIterations={cfg.maxIterations} onMaxReached="return-last">
            <Sequence>
              <Task id="opt:run" output={outputs.runEval} heartbeatTimeoutMs={50 * 60_000}>
                {() =>
                  runEvalsAndScore({
                    round: iterationIndex,
                    suites: cfg.optimizeSuites,
                    model: cfg.optimizeModel,
                    maxCases: cfg.maxCasesPerSuite,
                  })
                }
              </Task>
              <Task
                id="opt:fix"
                agent={FIX_SLOTS[iterationIndex % FIX_SLOTS.length]}
                output={outputs.fix}
                retries={1}
                continueOnFail
                timeoutMs={45 * 60_000}
                heartbeatTimeoutMs={15 * 60_000}
              >
                {fixPrompt(latestRun, cfg.targetPass, cfg.targetOneShot)}
              </Task>
            </Sequence>
          </Loop>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
