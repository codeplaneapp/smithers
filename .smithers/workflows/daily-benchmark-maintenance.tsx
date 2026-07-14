// smithers-display-name: Daily benchmark maintenance (system)
// smithers-description: Daily workflow-backed SOTA and benchmark maintenance: refresh model registry research, smoke-run benchmark/eval harnesses, and let a smart model research benchmark updates.
// smithers-tags: system, benchmarks, evals, research
// smithers-system: true
/** @jsxImportSource smithers-orchestrator */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { ClaudeCodeAgent, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";

const inputSchema = z.object({
  runLabel: z.string().default(() => new Date().toISOString().slice(0, 10)),
  summaryPath: z.string().default("/tmp/smithers-daily-research-summary.md"),
  sotaSummaryPath: z.string().default("/tmp/sota-research-summary.md"),
  runSotaResearch: z.boolean().default(true),
  runBenchmarkSmoke: z.boolean().default(true),
  runEvalSmoke: z.boolean().default(true),
  evalModel: z.string().default("codex"),
  evalMaxCases: z.number().int().positive().default(1),
  evalConcurrency: z.number().int().positive().default(2),
});

const commandSchema = z.object({
  command: z.string(),
  ok: z.boolean(),
  status: z.number().nullable(),
  durationMs: z.number(),
  stdout: z.string(),
  stderr: z.string(),
});

const inventorySchema = z.object({
  benchmarks: z.array(z.string()),
  benchmarkResults: z.string(),
  seededEvalSuites: z.array(z.string()),
  fluencyEvalSuites: z.array(z.string()),
});

const commandGroupSchema = z.object({
  ok: z.boolean(),
  commands: z.array(commandSchema),
  summary: z.string(),
});

const researchSchema = z.looseObject({
  summary: z.string().default(""),
  newBenchmarks: z.array(z.string()).default([]),
  benchmarkUpdates: z.array(z.string()).default([]),
  filesChanged: z.array(z.string()).default([]),
  shouldOpenPr: z.boolean().default(false),
  details: z.string().default(""),
});

const outputSchema = z.object({
  ok: z.boolean(),
  summaryPath: z.string(),
  summary: z.string(),
  commands: z.array(commandSchema),
  benchmarkResearch: researchSchema.nullable(),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  inventory: inventorySchema,
  sota: commandGroupSchema,
  smoke: commandGroupSchema,
  benchmarkResearch: researchSchema,
  output: outputSchema,
});

const ROOT = resolve(import.meta.dir, "../..");
const MAX_OUTPUT = 20_000;

const smartResearcher = codexFirst({
  model: "gpt-5.6-luna",
  config: { model_reasoning_effort: "medium" },
  cwd: ROOT,
  sandbox: "workspace-write",
  fullAuto: true,
  skipGitRepoCheck: true,
  extraArgs: ["-c", "tools.web_search=true"],
  timeoutMs: 45 * 60_000,
}, [new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd: ROOT })]);

function truncate(text: string, max = MAX_OUTPUT): string {
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

function run(command: string, args: string[], env: Record<string, string> = {}): z.infer<typeof commandSchema> {
  const started = Date.now();
  const res = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, SMITHERS_NO_UPDATE_CHECK: "1", ...env },
    timeout: 35 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    command: [command, ...args].join(" "),
    ok: !res.error && res.status === 0,
    status: res.status ?? null,
    durationMs: Date.now() - started,
    stdout: truncate(res.stdout ?? ""),
    stderr: truncate(res.error ? res.error.message : res.stderr ?? ""),
  };
}

function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function walkFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function readMaybe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export default smithers((ctx) => {
  const inventory = ctx.outputMaybe(outputs.inventory, { nodeId: "inventory" });
  const sota = ctx.outputMaybe(outputs.sota, { nodeId: "sota-research" });
  const smoke = ctx.outputMaybe(outputs.smoke, { nodeId: "run-existing-benchmarks-and-evals" });
  const research = ctx.outputMaybe(outputs.benchmarkResearch, { nodeId: "research-benchmark-updates" });
  const runLabel = ctx.input.runLabel ?? new Date().toISOString().slice(0, 10);
  const summaryPath = ctx.input.summaryPath ?? "/tmp/smithers-daily-research-summary.md";
  const sotaSummaryPath = ctx.input.sotaSummaryPath ?? "/tmp/sota-research-summary.md";
  const runSotaResearch = ctx.input.runSotaResearch ?? true;
  const runBenchmarkSmoke = ctx.input.runBenchmarkSmoke ?? true;
  const runEvalSmoke = ctx.input.runEvalSmoke ?? true;
  const evalModel = ctx.input.evalModel ?? "codex";
  const evalMaxCases = ctx.input.evalMaxCases ?? 1;
  const evalConcurrency = ctx.input.evalConcurrency ?? 2;

  return (
    <Workflow name="daily-benchmark-maintenance">
      <Sequence>
        <Task id="inventory" output={outputs.inventory} retries={0}>
          {() => ({
            benchmarks: listDirs(join(ROOT, "benchmarks")).filter((name) => name !== "site"),
            benchmarkResults: readMaybe(join(ROOT, "benchmarks/results.json")).slice(0, 30_000),
            seededEvalSuites: walkFiles(join(ROOT, ".smithers/evals"))
              .filter((file) => file.endsWith(".jsonl"))
              .map((file) => file.slice(ROOT.length + 1))
              .sort(),
            fluencyEvalSuites: listDirs(join(ROOT, "evals/suites")),
          })}
        </Task>

        {runSotaResearch ? (
          <Task id="sota-research" output={outputs.sota} retries={0}>
            {() => {
              const cmd = run("bun", ["scripts/sota-research.ts"], {
                SOTA_SUMMARY_PATH: sotaSummaryPath,
              });
              return {
                ok: cmd.ok,
                commands: [cmd],
                summary: cmd.ok ? "SOTA registry research completed." : "SOTA registry research failed.",
              };
            }}
          </Task>
        ) : null}

        {inventory && (runBenchmarkSmoke || runEvalSmoke) ? (
          <Task id="run-existing-benchmarks-and-evals" output={outputs.smoke} retries={0}>
            {() => {
              const commands: z.infer<typeof commandSchema>[] = [];
              if (runBenchmarkSmoke) {
                commands.push(run("bun", ["test", "benchmarks/fleet"]));
                commands.push(run("bun", ["benchmarks/site/make-site.ts"]));
              }
              if (runEvalSmoke) {
                commands.push(
                  run("bun", [
                    "evals/harness/run-all.ts",
                    "--only-model",
                    evalModel,
                    "--max-cases",
                    String(evalMaxCases),
                    "-j",
                    String(evalConcurrency),
                  ]),
                );
              }
              const failed = commands.filter((cmd) => !cmd.ok);
              return {
                ok: failed.length === 0,
                commands,
                summary:
                  failed.length === 0
                    ? `Ran ${commands.length} benchmark/eval smoke command(s).`
                    : `${failed.length}/${commands.length} benchmark/eval smoke command(s) failed.`,
              };
            }}
          </Task>
        ) : null}

        {inventory && smoke ? (
          <Task id="research-benchmark-updates" output={outputs.benchmarkResearch} agent={smartResearcher}>
            {`You maintain Smithers' benchmark registry and benchmark/eval harnesses.

Use web search against primary sources (benchmark papers, official repos, official leaderboards) and inspect this repository. Decide whether Smithers should add, remove, or update benchmarks/evals.

Current benchmark inventory:
${JSON.stringify(inventory, null, 2)}

Latest smoke results:
${JSON.stringify(smoke, null, 2)}

SOTA research result:
${JSON.stringify(sota ?? null, null, 2)}

Rules:
- Prefer primary sources. Do not cite blogs as source of truth for benchmark numbers.
- Keep benchmark rows honest: every result row must carry n, subset, status, and caveat. Never imply a small/pending run is a full-benchmark claim.
- If a new benchmark should be tracked and the change is straightforward, update benchmarks/results.json and regenerate benchmarks/site/index.html with \`bun benchmarks/site/make-site.ts\`.
- If the right update needs a larger harness or credentials, do not fake it. Return a clear recommendation instead.
- You may update docs/specs under .smithers/specs when the benchmark fleet design has drifted.
- Do not touch unrelated product UI or unrelated source files.

Return JSON with:
{
  "summary": "short result",
  "newBenchmarks": ["..."],
  "benchmarkUpdates": ["..."],
  "filesChanged": ["..."],
  "shouldOpenPr": true|false,
  "details": "primary-source evidence and commands run"
}`}
          </Task>
        ) : null}

        {inventory && smoke && research ? (
          <Task id="output" output={outputs.output} retries={0}>
            {() => {
              mkdirSync(dirname(summaryPath), { recursive: true });
              const allCommands = [...(sota?.commands ?? []), ...(smoke?.commands ?? [])];
              const ok = (sota?.ok ?? true) && smoke.ok;
              const summary = [
                `# Daily Smithers benchmark maintenance: ${runLabel}`,
                "",
                `Overall: ${ok ? "ok" : "attention needed"}`,
                "",
                "## SOTA research",
                sota?.summary ?? "Skipped.",
                readMaybe(sotaSummaryPath),
                "",
                "## Existing benchmark/eval smoke",
                smoke.summary,
                ...smoke.commands.map((cmd) => `- ${cmd.ok ? "PASS" : "FAIL"} \`${cmd.command}\` (${cmd.durationMs}ms)`),
                "",
                "## Benchmark research",
                research.summary || "(no summary)",
                research.details || "",
              ].join("\n");
              writeFileSync(summaryPath, `${summary.trim()}\n`);
              if (!ok) {
                throw new Error(`Daily benchmark maintenance failed; see ${summaryPath}`);
              }
              return {
                ok,
                summaryPath,
                summary,
                commands: allCommands,
                benchmarkResearch: research,
              };
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
