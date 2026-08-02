// smithers-source: authored
// smithers-display-name: API A/B Authoring Benchmark
// smithers-description: Two arms (Effect API vs JSX/React API) author the same three workflows from one reference doc each; scored deterministically by authored/typechecks/runs/correct with no LLM judge.
/** @jsxImportSource smthrs */
import { createSmithers, ClaudeCodeAgent, UI } from "smthrs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod/v4";

/**
 * Question this benchmark answers: can agents author CORRECT Smithers
 * workflows more reliably with the Effect API than with the JSX/React API?
 *
 * Everything except the API is held constant: same builder model, same three
 * task specs (written once, in API-neutral prose), same trial count, same
 * deterministic scoring. There is no LLM judge anywhere in the scoring path --
 * a candidate is `correct` only when the harness actually EXECUTES it and the
 * final result deep-equals the expected JSON written into the spec.
 *
 * The reference-doc pairing is the main confound and is measured, not hidden:
 * each arm gets exactly one document (docs/llms-effect.txt vs the size-matched
 * docs/llms-jsx-core.txt) and both token counts land in the report.
 */

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
export const BENCH_DIR = resolve(REPO_ROOT, ".smithers", "workflows", ".api-ab-benchmark");
export const REPORT_DIR = resolve(homedir(), "Desktop", "api-ab-benchmark");
export const RESULT_SENTINEL = "__API_AB_RESULT__";

export type Arm = "effect" | "jsx";

export const ARMS: readonly Arm[] = ["effect", "jsx"];

export const ARM_CONFIG: Record<Arm, { label: string; docPath: string; extension: string; runner: string }> = {
  effect: {
    label: "Effect API",
    docPath: resolve(REPO_ROOT, "docs", "llms-effect.txt"),
    extension: "ts",
    runner: resolve(REPO_ROOT, ".smithers", "lib", "apiAbBench", "run-effect-candidate.ts"),
  },
  jsx: {
    label: "JSX/React API",
    docPath: resolve(REPO_ROOT, "docs", "llms-jsx-core.txt"),
    extension: "tsx",
    runner: resolve(REPO_ROOT, ".smithers", "lib", "apiAbBench", "run-jsx-candidate.ts"),
  },
};

export type TaskSpec = {
  id: string;
  title: string;
  /** API-neutral semantics. Rendered verbatim into both arms' prompts. */
  semantics: string[];
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
};

/**
 * The three task specs, escalating, written ONCE in API-neutral prose so the
 * neutrality is auditable in one place. Nothing here names an API, a
 * component, or a constructor: `renderBuilderPrompt` substitutes only the API
 * name, the reference-doc path, and the arm's file/export contract.
 *
 * All three are compute-only -- no agents, no network, no git -- so candidates
 * execute in about a second and scoring is fully deterministic.
 */
export const TASK_SPECS: readonly TaskSpec[] = [
  {
    id: "pipeline",
    title: "Two steps, typed hand-off",
    semantics: [
      "The workflow input is an object with one numeric field `base`.",
      "Step one, id `double`, produces `{ value: base * 2 }`.",
      "Step two, id `describe`, consumes step one's typed output and produces",
      '`{ label: "base <base> -> <total>", total: <double.value + 1> }` where `total` is a number',
      "and `label` is that exact string with the two numbers substituted.",
      "The workflow's final result is step two's output.",
    ],
    input: { base: 5 },
    expected: { label: "base 5 -> 11", total: 11 },
  },
  {
    id: "fanout",
    title: "Parallel lanes, each a bounded correction loop",
    semantics: [
      "The workflow input is an object with one field `items`, an array of numbers; it is always `[1, 2, 3]`.",
      "Run one concurrent lane per item (three lanes, concurrency 3).",
      "Each lane is a bounded correction loop: at most 3 iterations, and on overflow it returns the last",
      "iteration's outputs instead of failing. The loop's body is a single step, id `attempt-<item>`,",
      "producing the typed output `{ item: <item>, value: <item * 10> }`. The loop stops as soon as that",
      "step has produced an output, so in practice each lane converges in one iteration.",
      "Each lane's loop needs its own unique id (for example `lane-<item>-loop`).",
      "After all three lanes finish, a step with id `collect` aggregates them into",
      "`{ items: [ {item, value}, ... ] in item order, total: <sum of the three values> }`.",
      "The workflow's final result is `collect`'s output.",
    ],
    input: { items: [1, 2, 3] },
    expected: {
      items: [
        { item: 1, value: 10 },
        { item: 2, value: 20 },
        { item: 3, value: 30 },
      ],
      total: 60,
    },
  },
  {
    id: "reuse",
    title: "One parameterized fragment, mounted twice, with a conditional branch",
    semantics: [
      "The workflow input is an object with one numeric field `base`.",
      "Define ONE parameterized, reusable fragment, taking a numeric `multiplier`. The fragment contains:",
      "a step with local id `compute` producing `{ value: base * multiplier }`, followed by a conditional",
      "branch on that completed step's output: when `value >= 12` a step with local id `label-high` runs,",
      "otherwise a step with local id `label-low` runs. Both branch steps produce",
      '`{ value: <compute.value>, tier: "high" | "low" }` matching the branch they are in.',
      "Mount that same fragment TWICE, in order, under two distinct scopes/id prefixes: first `alpha` with",
      "multiplier 2, then `beta` with multiplier 3. Every step id must end up prefixed by its scope",
      "(`alpha.compute`, `beta.label-high`, ...), so the two mounts never collide.",
      "The two mounts run one after the other, and the workflow's final result is the SECOND mount's",
      "branch-step output.",
    ],
    input: { base: 5 },
    expected: { value: 15, tier: "high" },
  },
];

const inputSchema = z.object({
  builderModel: z.string().default("claude-haiku-4-5").describe("Model that authors every candidate, both arms."),
  trials: z.number().int().min(1).max(20).default(3).describe("Trials per (arm, task); 3 arms x tasks x trials."),
});

const buildSchema = z.object({
  candidateKey: z.string(),
  filePath: z.string(),
  summary: z.string(),
});

const scoreSchema = z.object({
  candidateKey: z.string(),
  arm: z.string(),
  taskId: z.string(),
  trial: z.number().int(),
  authored: z.boolean(),
  typechecks: z.boolean(),
  runs: z.boolean(),
  correct: z.boolean(),
  firstTryClean: z.boolean(),
  wallClockMs: z.number().int(),
  failureKind: z.string(),
  failureOutput: z.string(),
});

const reportSchema = z.object({
  verdict: z.string(),
  candidates: z.number().int(),
  effectFirstTryClean: z.number(),
  jsxFirstTryClean: z.number(),
  htmlPath: z.string(),
  jsonPath: z.string(),
});
const setupSchema = z.object({
  ready: z.boolean(),
  candidates: z.number().int(),
});

const { Workflow, Task, Sequence, Parallel, smithers, outputs } = createSmithers({
  input: inputSchema,
  setup: setupSchema,
  build: buildSchema,
  score: scoreSchema,
  report: reportSchema,
});

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in .smithers/tests/api-ab-benchmark.test.tsx)
// ---------------------------------------------------------------------------

export function candidateKey(arm: Arm, taskId: string, trial: number): string {
  return `${arm}-${taskId}-${trial}`;
}

export function candidateDir(arm: Arm, taskId: string, trial: number): string {
  return resolve(BENCH_DIR, arm, taskId, String(trial));
}

export function candidatePath(arm: Arm, taskId: string, trial: number): string {
  return resolve(candidateDir(arm, taskId, trial), `candidate.${ARM_CONFIG[arm].extension}`);
}

/** Whitespace-insensitive token proxy; the report shows it for both reference docs. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([l], [r]) => l.localeCompare(r))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

/**
 * Failure signatures are clustered by string prefix -- deliberately dumb, so
 * the "most common failure mode" number carries no model judgement.
 */
export function bucketFailure(failureKind: string, failureOutput: string): string {
  if (failureKind === "none") return "none";
  const lines = failureOutput
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const line = lines.find((entry) => /error|Error|not |failed|missing/.test(entry)) ?? lines[0] ?? "";
  const normalized = line
    .replace(/\/[^\s'"]+/g, "<path>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return normalized ? `${failureKind}: ${normalized}` : failureKind;
}

export type ScoreRow = z.infer<typeof scoreSchema>;

export type ArmTaskCell = {
  arm: string;
  taskId: string;
  trials: number;
  authored: number;
  typechecks: number;
  runs: number;
  correct: number;
  medianWallClockMs: number;
};

export type Aggregate = {
  candidates: number;
  cells: ArmTaskCell[];
  perArm: {
    arm: string;
    trials: number;
    authored: number;
    typechecks: number;
    runs: number;
    correct: number;
    firstTryClean: number;
    medianWallClockMs: number;
    topFailure: string;
    failureCounts: { signature: string; count: number }[];
  }[];
  verdict: string;
};

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function rate(rows: ScoreRow[], pick: (row: ScoreRow) => boolean): number {
  return rows.length === 0 ? 0 : rows.filter(pick).length / rows.length;
}

export function aggregateResults(rows: readonly ScoreRow[]): Aggregate {
  const cells: ArmTaskCell[] = [];
  for (const arm of ARMS) {
    for (const spec of TASK_SPECS) {
      const cellRows = rows.filter((row) => row.arm === arm && row.taskId === spec.id);
      cells.push({
        arm,
        taskId: spec.id,
        trials: cellRows.length,
        authored: rate(cellRows, (row) => row.authored),
        typechecks: rate(cellRows, (row) => row.typechecks),
        runs: rate(cellRows, (row) => row.runs),
        correct: rate(cellRows, (row) => row.correct),
        medianWallClockMs: median(cellRows.map((row) => row.wallClockMs)),
      });
    }
  }

  const perArm = ARMS.map((arm) => {
    const armRows = rows.filter((row) => row.arm === arm);
    const counts = new Map<string, number>();
    for (const row of armRows) {
      if (row.failureKind === "none") continue;
      const signature = bucketFailure(row.failureKind, row.failureOutput);
      counts.set(signature, (counts.get(signature) ?? 0) + 1);
    }
    const failureCounts = [...counts.entries()]
      .map(([signature, count]) => ({ signature, count }))
      .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
    return {
      arm,
      trials: armRows.length,
      authored: rate(armRows, (row) => row.authored),
      typechecks: rate(armRows, (row) => row.typechecks),
      runs: rate(armRows, (row) => row.runs),
      correct: rate(armRows, (row) => row.correct),
      firstTryClean: rate(armRows, (row) => row.firstTryClean),
      medianWallClockMs: median(armRows.map((row) => row.wallClockMs)),
      topFailure: failureCounts[0]?.signature ?? "none",
      failureCounts,
    };
  });

  const effect = perArm.find((entry) => entry.arm === "effect");
  const jsx = perArm.find((entry) => entry.arm === "jsx");
  const delta = Math.round(((effect?.correct ?? 0) - (jsx?.correct ?? 0)) * 100);
  const verdict =
    rows.length === 0
      ? "No candidates scored."
      : delta === 0
        ? `Tie: both arms produced correct workflows in ${Math.round((effect?.correct ?? 0) * 100)}% of trials.`
        : delta > 0
          ? `Effect API wins by ${delta} points of correctness (${Math.round((effect?.correct ?? 0) * 100)}% vs ${Math.round((jsx?.correct ?? 0) * 100)}%).`
          : `JSX API wins by ${-delta} points of correctness (${Math.round((jsx?.correct ?? 0) * 100)}% vs ${Math.round((effect?.correct ?? 0) * 100)}%).`;

  return { candidates: rows.length, cells, perArm, verdict };
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderReportHtml(
  aggregate: Aggregate,
  docTokens: { effect: number; jsx: number },
  meta: { builderModel: string; trials: number },
): string {
  const cellRow = (taskId: string) => {
    const cells = aggregate.cells.filter((cell) => cell.taskId === taskId);
    return `<tr><th scope="row">${escapeHtml(taskId)}</th>${cells
      .map(
        (cell) =>
          `<td><span class="k">${pct(cell.correct)}</span> correct<br><small>authored ${pct(cell.authored)} · typechecks ${pct(cell.typechecks)} · runs ${pct(cell.runs)} · ${cell.medianWallClockMs}ms median</small></td>`,
      )
      .join("")}</tr>`;
  };
  const armCard = (entry: Aggregate["perArm"][number]) => `
      <div class="card">
        <h3>${escapeHtml(entry.arm)}</h3>
        <p class="big">${pct(entry.firstTryClean)}</p>
        <p>first-try clean over ${entry.trials} trials</p>
        <ul>
          <li>authored ${pct(entry.authored)}</li>
          <li>typechecks ${pct(entry.typechecks)}</li>
          <li>runs ${pct(entry.runs)}</li>
          <li>correct ${pct(entry.correct)}</li>
          <li>median wall clock ${entry.medianWallClockMs}ms</li>
        </ul>
        <h4>Failure modes</h4>
        ${
          entry.failureCounts.length === 0
            ? "<p><small>No failures recorded.</small></p>"
            : `<ol>${entry.failureCounts.map((failure) => `<li><code>${escapeHtml(failure.signature)}</code> &times;${failure.count}</li>`).join("")}</ol>`
        }
      </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Effect API vs JSX API - authoring benchmark</title>
<style>
:root { color-scheme: light dark; --fg: #14171f; --muted: #5b6273; --bg: #f6f7fb; --card: #ffffff; --line: #dfe3ec; --accent: #3b5bdb; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8eaf1; --muted: #9aa2b6; --bg: #12141a; --card: #1a1d26; --line: #2a2f3c; --accent: #7f9cf5; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 2.5rem 1.5rem 4rem; font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); }
main { max-width: 62rem; margin: 0 auto; }
h1 { font-size: 1.9rem; margin: 0 0 .25rem; }
h2 { font-size: 1.2rem; margin: 2.25rem 0 .75rem; }
h3 { margin: 0 0 .25rem; text-transform: uppercase; letter-spacing: .06em; font-size: .8rem; color: var(--muted); }
h4 { margin: 1rem 0 .35rem; font-size: .85rem; color: var(--muted); }
p { margin: .35rem 0; }
small { color: var(--muted); }
.verdict { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 10px; padding: 1.25rem 1.4rem; }
.verdict p.headline { font-size: 1.25rem; font-weight: 650; margin: 0; }
.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1.1rem 1.2rem; }
.card ul, .card ol { margin: .4rem 0 0; padding-left: 1.1rem; }
.big { font-size: 2rem; font-weight: 700; margin: 0; }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: .7rem .9rem; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: none; }
.k { font-weight: 700; font-size: 1.05rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
.confounds li { margin: .3rem 0; }
</style>
</head>
<body>
<main>
  <h1>Effect API vs JSX API</h1>
  <p><small>Builder ${escapeHtml(meta.builderModel)} · ${meta.trials} trials per arm/task · ${aggregate.candidates} candidates · deterministic scoring, no LLM judge</small></p>

  <div class="verdict">
    <h3>Verdict</h3>
    <p class="headline">${escapeHtml(aggregate.verdict)}</p>
  </div>

  <h2>Per arm</h2>
  <div class="grid">${aggregate.perArm.map(armCard).join("")}</div>

  <h2>Arm &times; task</h2>
  <table>
    <thead><tr><th>task</th>${ARMS.map((arm) => `<th>${escapeHtml(arm)}</th>`).join("")}</tr></thead>
    <tbody>${TASK_SPECS.map((spec) => cellRow(spec.id)).join("")}</tbody>
  </table>

  <h2>Reference documents</h2>
  <table>
    <thead><tr><th>arm</th><th>document</th><th>estimated tokens</th></tr></thead>
    <tbody>
      <tr><th scope="row">effect</th><td><code>docs/llms-effect.txt</code></td><td>${docTokens.effect}</td></tr>
      <tr><th scope="row">jsx</th><td><code>docs/llms-jsx-core.txt</code></td><td>${docTokens.jsx}</td></tr>
    </tbody>
  </table>

  <h2>Confounds - what this does and does not prove</h2>
  <div class="card confounds">
    <ul>
      <li><strong>The typecheck column is not comparable across arms.</strong> The Effect API's shipped type declarations carry no generic inference (a step's <code>input</code> and its dependency values are typed <code>unknown</code>, and <code>G.step</code> returns an untyped graph value), so a strict <code>tsc</code> gate is red for every Effect candidate for reasons that have nothing to do with the agent that wrote it. So <code>typechecks</code> is recorded but excluded from <code>firstTryClean</code>, and the verdict above is computed from <strong>correct</strong>: the candidate executed and its final result deep-equalled the expected JSON.</li>
      <li><strong>Doc quality is the dominant confound.</strong> Each arm sees exactly one hand-written reference of matched length and matched section outline. Matched length is not matched quality; a difference here may be a difference between two documents, not between two APIs.</li>
      <li><strong>Doc isolation is instruction-enforced, not sandboxed.</strong> Builders are told to author only against their one document and not to read other docs or existing workflows in the repo. Nothing prevents them from doing so.</li>
      <li><strong>Compute-only tasks.</strong> No agents, no network, no git, no approvals. Nothing here measures either API on the surfaces most real workflows spend their time in.</li>
      <li><strong>One builder model.</strong> Results do not transfer to stronger or weaker models without re-running.</li>
      <li><strong>Correct means "executed and deep-equalled the expected JSON"</strong> on one fixed input. It is not a proof of general correctness.</li>
      <li><strong>Three tasks, small n.</strong> With few trials per cell, a one-trial swing moves a cell by a large percentage. Read the arm totals, not single cells.</li>
      <li>Prompts are rendered from one shared API-neutral spec array, so the semantics are identical across arms by construction; only the API name, the reference-doc path, and the file/export contract differ.</li>
    </ul>
  </div>
</main>
</body>
</html>
`;
}

/**
 * The per-arm prompt. Everything task-shaped comes from the shared spec; the
 * arm contributes only its name, its one reference doc, and the file/export
 * contract its runner needs.
 */
export function renderBuilderPrompt(arm: Arm, spec: TaskSpec, trial: number, scratchDocPath: string): string {
  const config = ARM_CONFIG[arm];
  const filePath = candidatePath(arm, spec.id, trial);
  const contract =
    arm === "effect"
      ? [
          `Export the finalized workflow as a named export called \`workflow\` (\`export const workflow = G.from(...)\`).`,
          `Do NOT execute it and do NOT provide a persistence layer: the harness executes your export and provides persistence itself.`,
        ]
      : [
          `Default-export the workflow (\`export default smithers(...)\`), and make the workflow's final result table explicit.`,
          `Do NOT execute it and do NOT configure a database: the harness runs your default export itself.`,
        ];

  return [
    `You are authoring a Smithers workflow using the ${config.label} ONLY.`,
    ``,
    `Your one and only reference document is at: ${scratchDocPath}`,
    `Read that file first. Author strictly against it: do not read any other Smithers documentation, and do not open other workflow files in this repository for examples. Everything you need is in that document.`,
    ``,
    `Write exactly one file, at this EXACT path (create parent directories if needed):`,
    filePath,
    `Do not create, edit, or delete any other file anywhere.`,
    ``,
    `## What the workflow must do`,
    ``,
    ...spec.semantics,
    ``,
    `Every step body is a plain deterministic computation. Do not use an agent, the network, git, approvals, or the filesystem.`,
    `Never declare an output field named \`runId\`, \`nodeId\`, or \`iteration\`; those column names are reserved by the runtime.`,
    ``,
    `## Contract with the harness`,
    ``,
    ...contract,
    `The harness will execute your workflow with this input:`,
    JSON.stringify(spec.input),
    `and the workflow's final result must deep-equal exactly this JSON:`,
    JSON.stringify(spec.expected),
    ``,
    `Return candidateKey ${JSON.stringify(candidateKey(arm, spec.id, trial))}, filePath (the file you wrote), and a one-sentence summary.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Deterministic scoring (process exit codes and a deep-equal; no LLM judge)
// ---------------------------------------------------------------------------

function runCommand(
  cwd: string,
  command: string,
  args: string[],
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  return {
    exitCode: typeof result.status === "number" ? result.status : -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Extracts the final-result JSON a runner prints behind the shared sentinel. */
export function parseRunnerResult(stdout: string): unknown {
  const line = stdout
    .split("\n")
    .reverse()
    .find((entry) => entry.includes(RESULT_SENTINEL));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice(line.indexOf(RESULT_SENTINEL) + RESULT_SENTINEL.length));
  } catch {
    return undefined;
  }
}

export function scoreCandidate(arm: Arm, spec: TaskSpec, trial: number): ScoreRow {
  const startedAt = Date.now();
  const dir = candidateDir(arm, spec.id, trial);
  const file = candidatePath(arm, spec.id, trial);
  const base: ScoreRow = {
    candidateKey: candidateKey(arm, spec.id, trial),
    arm,
    taskId: spec.id,
    trial,
    authored: false,
    typechecks: false,
    runs: false,
    correct: false,
    firstTryClean: false,
    wallClockMs: 0,
    failureKind: "not-authored",
    failureOutput: "",
  };

  if (!existsSync(file)) {
    return { ...base, wallClockMs: Date.now() - startedAt, failureOutput: `no file at ${file}` };
  }

  // 1. Scoped typecheck. The full .smithers typecheck OOMs locally, so this is
  //    one tsconfig per candidate with extra heap headroom.
  const tsconfigPath = resolve(dir, "tsconfig.json");
  writeFileSync(
    tsconfigPath,
    // `exclude: []` overrides the base config, which deliberately excludes this
    // whole scratch tree from the repo-wide `.smithers` typecheck.
    `${JSON.stringify({ extends: resolve(REPO_ROOT, ".smithers", "tsconfig.json"), include: [file], exclude: [] }, null, 2)}\n`,
  );
  const typecheck = runCommand(
    resolve(REPO_ROOT, ".smithers"),
    resolve(REPO_ROOT, "node_modules", ".bin", "tsc"),
    ["-p", tsconfigPath, "--noEmit"],
    5 * 60_000,
    { NODE_OPTIONS: "--max-old-space-size=8192" },
  );
  const typechecks = typecheck.exitCode === 0;

  // 2. Execute it for real, through the arm's runner, against a throwaway
  //    sqlite file OUTSIDE the checkout: a db under `.smithers/` would make the
  //    runner's chdir land inside the workspace anchor, so the candidate would
  //    open the repo's real smithers.db and snapshot this working copy.
  const runDir = mkdtempSync(join(tmpdir(), `api-ab-${candidateKey(arm, spec.id, trial)}-`));
  const dbFile = resolve(runDir, "smithers.db");
  const execution = runCommand(
    REPO_ROOT,
    "bun",
    [ARM_CONFIG[arm].runner, file, JSON.stringify(spec.input), dbFile],
    5 * 60_000,
  );
  const runs = execution.exitCode === 0 && parseRunnerResult(execution.stdout) !== undefined;
  const correct = runs && deepEqualJson(parseRunnerResult(execution.stdout), spec.expected);

  // Execution comes first in the failure ordering, and `firstTryClean` excludes
  // `typechecks` on purpose: the Effect API's shipped .d.ts has no generic
  // inference, so a strict tsc gate is red for every Effect candidate whatever
  // the agent wrote. `typechecks` is still recorded, and the report says why it
  // is not comparable across arms.
  const failureKind = !runs ? "run" : !correct ? "incorrect" : !typechecks ? "typecheck" : "none";
  const failureOutput = !runs
    ? `${execution.stderr}\n${execution.stdout}`.trim().slice(0, 2000)
    : !correct
      ? `expected ${JSON.stringify(spec.expected)}\nactual ${JSON.stringify(parseRunnerResult(execution.stdout))}`.slice(
          0,
          2000,
        )
      : !typechecks
        ? `${typecheck.stdout}\n${typecheck.stderr}`.trim().slice(0, 2000)
        : "";

  rmSync(runDir, { recursive: true, force: true });

  return {
    ...base,
    authored: true,
    typechecks,
    runs,
    correct,
    firstTryClean: runs && correct,
    wallClockMs: Date.now() - startedAt,
    failureKind,
    failureOutput,
  };
}

function scoreTaskFailure(arm: Arm, spec: TaskSpec, trial: number): ScoreRow {
  return {
    candidateKey: candidateKey(arm, spec.id, trial),
    arm,
    taskId: spec.id,
    trial,
    authored: existsSync(candidatePath(arm, spec.id, trial)),
    typechecks: false,
    runs: false,
    correct: false,
    firstTryClean: false,
    wallClockMs: 0,
    failureKind: "score",
    failureOutput: "score task failed before producing a result row",
  };
}

export function writeReport(
  rows: readonly ScoreRow[],
  meta: { builderModel: string; trials: number },
): z.infer<typeof reportSchema> {
  const aggregate = aggregateResults(rows);
  const docTokens = {
    effect: estimateTokens(readFileSync(ARM_CONFIG.effect.docPath, "utf8")),
    jsx: estimateTokens(readFileSync(ARM_CONFIG.jsx.docPath, "utf8")),
  };
  mkdirSync(REPORT_DIR, { recursive: true });
  const htmlPath = resolve(REPORT_DIR, "index.html");
  const jsonPath = resolve(REPORT_DIR, "results.json");
  writeFileSync(htmlPath, renderReportHtml(aggregate, docTokens, meta));
  writeFileSync(jsonPath, `${JSON.stringify({ meta, docTokens, aggregate, rows }, null, 2)}\n`);
  return {
    verdict: aggregate.verdict,
    candidates: aggregate.candidates,
    effectFirstTryClean: aggregate.perArm.find((entry) => entry.arm === "effect")?.firstTryClean ?? 0,
    jsxFirstTryClean: aggregate.perArm.find((entry) => entry.arm === "jsx")?.firstTryClean ?? 0,
    htmlPath,
    jsonPath,
  };
}

/** Deletes the scratch candidate tree so a re-run starts clean. */
export function resetBenchmarkScratch(): void {
  rmSync(BENCH_DIR, { recursive: true, force: true });
}

export function prepareBenchmarkScratch(trials: number): z.infer<typeof setupSchema> {
  resetBenchmarkScratch();
  let candidates = 0;
  for (const arm of ARMS) {
    for (const spec of TASK_SPECS) {
      for (let trial = 1; trial <= trials; trial += 1) {
        const dir = candidateDir(arm, spec.id, trial);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, "reference.txt"), readFileSync(ARM_CONFIG[arm].docPath, "utf8"));
        candidates += 1;
      }
    }
  }
  return { ready: true, candidates };
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export default smithers(
  (ctx) => {
    const builderModel = ctx.input.builderModel ?? "claude-haiku-4-5";
    const trials = ctx.input.trials ?? 3;
    const builder = new ClaudeCodeAgent({ model: builderModel });

    const candidates = ARMS.flatMap((arm) =>
      TASK_SPECS.flatMap((spec) => Array.from({ length: trials }, (_, index) => ({ arm, spec, trial: index + 1 }))),
    );
    const setup = ctx.outputMaybe(outputs.setup, { nodeId: "setup" });

    const scored = candidates.map((candidate) =>
      ctx.outputMaybe(outputs.score, {
        nodeId: `score-${candidateKey(candidate.arm, candidate.spec.id, candidate.trial)}`,
      }),
    );
    return (
      <Workflow name="api-ab-benchmark">
        <UI entry="../ui/api-ab-benchmark.tsx" title="API A/B Benchmark" />
        <Sequence>
          <Task id="setup" output={outputs.setup}>
            {() => prepareBenchmarkScratch(trials)}
          </Task>
          {setup?.ready ? (
            <Parallel maxConcurrency={6}>
              {candidates.map((candidate) => {
                const key = candidateKey(candidate.arm, candidate.spec.id, candidate.trial);
                const dir = candidateDir(candidate.arm, candidate.spec.id, candidate.trial);
                const scratchDocPath = resolve(dir, "reference.txt");
                return (
                  <Sequence key={key}>
                    <Task
                      id={`build-${key}`}
                      output={outputs.build}
                      agent={builder}
                      timeoutMs={20 * 60_000}
                      heartbeatTimeoutMs={10 * 60_000}
                      continueOnFail
                    >
                      {renderBuilderPrompt(candidate.arm, candidate.spec, candidate.trial, scratchDocPath)}
                    </Task>
                    <Task id={`score-${key}`} output={outputs.score} continueOnFail>
                      {() => scoreCandidate(candidate.arm, candidate.spec, candidate.trial)}
                    </Task>
                  </Sequence>
                );
              })}
            </Parallel>
          ) : null}
          {setup?.ready ? (
            <Task id="report" output={outputs.report}>
              {() =>
                writeReport(
                  candidates.map(
                    (candidate, index) =>
                      scored[index] ?? scoreTaskFailure(candidate.arm, candidate.spec, candidate.trial),
                  ),
                  { builderModel, trials },
                )
              }
            </Task>
          ) : null}
        </Sequence>
      </Workflow>
    );
  },
  { output: outputs.report },
);
