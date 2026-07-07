// Kanban workflow benchmark runner.
//
//   bun benchmarks/kanban-bench/bench.ts --label zero --tickets 12 --concurrency 4
//   bun benchmarks/kanban-bench/bench.ts --label realistic \
//     --delays '{"implement":8000,"validate":4000,"review":4000,"merge":6000}'
//   bun benchmarks/kanban-bench/bench.ts --label wide --global-concurrency 16 --delays ...
//
// Builds a hermetic sandbox repo, runs the REAL `smithers up` CLI against the
// real kanban workflow with deterministic in-process bench agents, then
// decomposes where the wall-clock went. Reports land in --out (default:
// benchmarks/kanban-bench/results/<label>/).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKanbanBenchSandbox } from "./sandbox.ts";
import { analyzeKanbanBench, parseNdjson, renderKanbanBenchReport, type AgentCall, type EngineEvent } from "./analyze.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const cliBin = join(repoRoot, "packages/smithers/src/bin/smithers.js");

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const label = arg("label", "run");
const tickets = Number(arg("tickets", "12"));
// --no-input runs the workflow with NO --input at all (the bare `smithers up`
// path: the workflow must supply its own cap default).
const noInput = process.argv.includes("--no-input");
const workflowConcurrency = Number(arg("concurrency", "4"));
const globalConcurrency = Number(arg("global-concurrency", "4"));
const delays = JSON.parse(arg("delays", "{}"));
const failValidate = arg("fail-validate", "");
const sandboxBase = arg(
  "sandbox-dir",
  process.env.KANBAN_BENCH_SANDBOX_DIR ?? join(process.env.TMPDIR ?? "/tmp", "kanban-bench-sandboxes"),
);
const outDir = arg("out", join(here, "results", label));

const runId = `kanban-bench-${label}-${Date.now()}`;
const sandboxRoot = join(sandboxBase, label);

console.log(`[bench] building sandbox at ${sandboxRoot} (${tickets} tickets)`);
const sandbox = createKanbanBenchSandbox({ root: sandboxRoot, tickets });
const benchLog = join(sandbox.root, "bench-agent-log.ndjson");

const cliArgs = [
  cliBin,
  "up",
  join(sandbox.root, ".smithers/workflows/kanban.tsx"),
  "--run-id",
  runId,
  ...(noInput ? [] : ["--input", JSON.stringify({ maxConcurrency: workflowConcurrency })]),
  "--max-concurrency",
  String(globalConcurrency),
];

console.log(`[bench] running: bun ${cliArgs.join(" ")}`);
const spawnMs = Date.now();
const proc = Bun.spawn(["bun", ...cliArgs], {
  cwd: sandbox.root,
  env: {
    ...process.env,
    KANBAN_BENCH_LOG: benchLog,
    KANBAN_BENCH_DELAYS: JSON.stringify(delays),
    KANBAN_BENCH_FAIL_VALIDATE: failValidate,
  },
  stdout: "pipe",
  stderr: "pipe",
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);
const exitMs = Date.now();
console.log(`[bench] CLI exited ${exitCode} after ${((exitMs - spawnMs) / 1000).toFixed(1)}s`);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "cli-stdout.log"), stdout);
writeFileSync(join(outDir, "cli-stderr.log"), stderr);

const streamPath = join(sandbox.root, ".smithers/executions", runId, "logs/stream.ndjson");
const events = parseNdjson<EngineEvent>(streamPath);
const agentCalls = parseNdjson<AgentCall>(benchLog);
if (events.length === 0) {
  console.error(`[bench] no engine events found at ${streamPath} — run failed? see ${join(outDir, "cli-stderr.log")}`);
  process.exit(1);
}

const report = analyzeKanbanBench({
  events,
  agentCalls,
  config: { tickets, workflowConcurrency, globalConcurrency, reviewers: 3, delays },
  spawnMs,
  exitMs,
});

writeFileSync(join(outDir, "report.json"), `${JSON.stringify({ runId, exitCode, sandboxRoot: sandbox.root, ...report }, null, 2)}\n`);
const rendered = renderKanbanBenchReport(report, `${label} (run ${runId}, exit ${exitCode})`);
writeFileSync(join(outDir, "report.md"), `${rendered}\n`);
console.log("");
console.log(rendered);
console.log(`[bench] artifacts: ${outDir}`);
