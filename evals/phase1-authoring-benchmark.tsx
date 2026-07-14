/** @jsxImportSource smithers-orchestrator */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { models } from "./agents.js";
import { repoRoot } from "./lib/paths.js";

const root = repoRoot();
const candidate = join(root, ".smithers", "evals", "fixtures", "phase1-issue-sweep.tsx");
const productionTest = join(root, ".smithers", "tests", "phase1-issue-sweep.test.tsx");
const packageJson = join(root, ".smithers", "package.json");

const gateSchema = z.object({
  passed: z.boolean(),
  graph: z.boolean(),
  noReservedColumns: z.boolean(),
  noNestedLoop: z.boolean(),
  oneMergeQueue: z.boolean(),
  bindings: z.boolean(),
  typecheck: z.boolean(),
  testRegisteredAndGreen: z.boolean(),
  detail: z.string(),
});
const artifactSchema = z.object({ summary: z.string() });

const { Workflow, Sequence, Task, smithers, outputs } = createSmithers({ input: z.object({ model: z.string().default("haiku") }), artifact: artifactSchema, verdict: gateSchema });

function run(command: string, args: string[], cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 180_000 });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

function resetCandidate() {
  rmSync(candidate, { force: true });
  rmSync(productionTest, { force: true });
  if (existsSync(packageJson)) {
    const packageSource = readFileSync(packageJson, "utf8");
    const withoutCandidate = packageSource.replace(/\s+\.\/tests\/phase1-issue-sweep\.test\.tsx/g, "");
    if (withoutCandidate !== packageSource) writeFileSync(packageJson, withoutCandidate);
  }
}

function gateCandidate() {
  const source = existsSync(candidate) ? readFileSync(candidate, "utf8") : "";
  const testSource = existsSync(productionTest) ? readFileSync(productionTest, "utf8") : "";
  const packageSource = existsSync(packageJson) ? readFileSync(packageJson, "utf8") : "";
  const packageJsonValue = packageSource ? JSON.parse(packageSource) as { scripts?: { test?: string } } : {};
  mkdirSync(join(root, ".smithers", "state"), { recursive: true });
  const graph = source ? run("bun", [join(root, "apps/cli/src/index.js"), "graph", candidate, "--input", JSON.stringify({ issues: [{ id: "i1", title: "Fix type error" }, { id: "i2", title: "Add missing test" }] })]) : { ok: false, output: "candidate missing" };
  const typecheck = source ? run("pnpm", ["-C", ".smithers", "typecheck"]) : { ok: false, output: "candidate missing" };
  const registered = typeof packageJsonValue.scripts?.test === "string" && packageJsonValue.scripts.test.includes("./tests/phase1-issue-sweep.test.tsx");
  const testContract = /from ["']smithers-orchestrator\/testing["']/.test(testSource) && /renderWorkflow\s*\(/.test(testSource) && /phase1-issue-sweep\.tsx/.test(testSource);
  const test = registered && testContract ? run("bun", ["test", "--preload", "./preload.ts", "./tests/phase1-issue-sweep.test.tsx"], join(root, ".smithers")) : { ok: false, output: "test is not registered or does not use renderWorkflow" };
  // Graph extraction is the source of truth for reserved metadata and loop
  // topology. The representative input ensures dynamic lanes are rendered.
  const noReservedColumns = graph.ok && !/RESERVED_COLUMN|reserved column/i.test(graph.output);
  const noNestedLoop = graph.ok && !/NESTED_LOOP|Nested <Loop>/i.test(graph.output);
  const oneMergeQueue = (source.match(/<MergeQueue\b/g) ?? []).length === 1;
  const bindings = /ctx\.latest\s*\(/.test(source) && /outputMaybe\s*\([\s\S]{0,500}\{[\s\S]{0,300}nodeId[\s\S]{0,300}iteration\s*:\s*(?:ctx\.iteration\s*-\s*1|previousIteration)/.test(source);
  const testRegisteredAndGreen = registered && testContract && test.ok;
  const passed = graph.ok && noReservedColumns && noNestedLoop && oneMergeQueue && bindings && typecheck.ok && testRegisteredAndGreen;
  return {
    passed, graph: graph.ok, noReservedColumns, noNestedLoop, oneMergeQueue, bindings,
    typecheck: typecheck.ok, testRegisteredAndGreen,
    detail: [graph.output, typecheck.output, test.output].filter(Boolean).join("\n").slice(-4000),
  };
}

export default smithers((ctx) => {
  const artifact = ctx.outputMaybe(outputs.artifact, { nodeId: "author" });
  if (!artifact) resetCandidate();
  return (
    <Workflow name="phase1-authoring-benchmark">
      <Sequence>
        {!artifact ? <Task id="author" output={outputs.artifact} agent={models.haiku} retries={0} continueOnFail timeoutMs={30 * 60_000}>
          {`Author a miniature issue-sweep Smithers workflow in ${candidate} and a production test in ${productionTest}. Use typed Zod outputs. Render parallel per-item lanes, each with a correction <Loop>; use exactly ONE global <MergeQueue maxConcurrency={1}> for landing; use ctx.latest in the loop until condition and outputMaybe({nodeId, iteration}) for a cross-iteration read. The test MUST import the real workflow and call renderWorkflow, then be registered in ${packageJson}. Do not hand-build a graph copy. Make the files compile and pass their test. You may edit only those three paths.`}
        </Task> : null}
        {!artifact ? <Task id="gates" output={outputs.verdict} retries={0}>{() => gateCandidate()}</Task> : null}
      </Sequence>
    </Workflow>
  );
});
