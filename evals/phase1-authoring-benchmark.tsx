/** @jsxImportSource smthrs */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSmithers } from "smthrs";
import { renderWorkflow } from "smthrs/testing";
import { z } from "zod/v4";
import { models } from "./agents.js";
import { repoRoot } from "./lib/paths.js";

const root = repoRoot();
const gateSchema = z.object({
  passed: z.boolean(),
  graph: z.boolean(),
  noReservedColumns: z.boolean(),
  noNestedLoop: z.boolean(),
  oneMergeQueue: z.boolean(),
  topology: z.boolean(),
  typedOutputs: z.boolean(),
  noContinueOnFail: z.boolean(),
  typecheck: z.boolean(),
  testRegisteredAndGreen: z.boolean(),
  detail: z.string(),
});
const artifactSchema = z.object({ summary: z.string() });
const initSchema = z.object({ dir: z.string(), candidate: z.string(), test: z.string(), packageJson: z.string() });
const { Workflow, Sequence, Task, smithers, outputs } = createSmithers({
  input: z.object({ model: z.string().default("haiku") }),
  init: initSchema,
  artifact: artifactSchema,
  verdict: gateSchema,
});

function scratchDir(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(root, ".smithers", "eval-runs", safe);
}

function paths(runId: string) {
  const dir = scratchDir(runId);
  return { dir, candidate: join(dir, "phase1-issue-sweep.tsx"), test: join(dir, "phase1-issue-sweep.test.tsx"), packageJson: join(dir, "package.json") };
}

function run(command: string, args: string[], cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 180_000 });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

function initScratch(runId: string) {
  const target = paths(runId);
  rmSync(target.dir, { recursive: true, force: true });
  mkdirSync(target.dir, { recursive: true });
  writeFileSync(target.packageJson, JSON.stringify({
    name: "phase1-authoring-case",
    private: true,
    type: "module",
    scripts: { test: "bun test ./phase1-issue-sweep.test.tsx" },
  }, null, 2) + "\n");
  writeFileSync(join(target.dir, "tsconfig.json"), JSON.stringify({
    extends: "../../tsconfig.json",
    include: ["./phase1-issue-sweep.tsx", "./phase1-issue-sweep.test.tsx"],
  }, null, 2) + "\n");
  return target;
}

function elementRecords(node: any, ancestors: string[] = []): { node: any; ancestors: string[] }[] {
  if (node?.kind !== "element") return [];
  return [{ node, ancestors }, ...node.children.flatMap((child: any) => elementRecords(child, [...ancestors, node.tag]))];
}

async function gateCandidate(runId: string) {
  const target = paths(runId);
  const source = existsSync(target.candidate) ? readFileSync(target.candidate, "utf8") : "";
  const testSource = existsSync(target.test) ? readFileSync(target.test, "utf8") : "";
  const packageValue = existsSync(target.packageJson) ? JSON.parse(readFileSync(target.packageJson, "utf8")) : {};
  const registered = typeof packageValue.scripts?.test === "string" && packageValue.scripts.test.includes("phase1-issue-sweep.test.tsx");
  let graph = false;
  let noReservedColumns = false;
  let noNestedLoop = false;
  let topology = false;
  let typedOutputs = false;
  let noContinueOnFail = false;
  let graphDetail = "candidate missing";
  try {
    const module = await import(`${pathToFileURL(target.candidate).href}?case=${runId}`);
    const rendered = await renderWorkflow(module.default, {
      runId: `${runId}-render`,
      input: { issues: [{ id: "i1", title: "Fix type error" }, { id: "i2", title: "Add missing test" }] },
      baseRootDir: root,
      workflowPath: target.candidate,
    });
    const xml = rendered.xml as any;
    const records = elementRecords(xml);
    const nodes = records.map((record) => record.node);
    const tags = nodes.map((node) => node.tag);
    const queues = nodes.filter((node) => node.tag === "smithers:merge-queue");
    const loops = nodes.filter((node) => node.tag === "smithers:ralph");
    const parallels = nodes.filter((node) => node.tag === "smithers:parallel");
    const tasks = rendered.tasks;
    graph = true;
    noReservedColumns = !tasks.some((task: any) => ["runId", "nodeId", "iteration"].some((column) => task.outputSchema?.shape?.[column]));
    noNestedLoop = !tags.includes("NESTED_LOOP");
    const queueIsSerialized = queues.length === 1 && String(queues[0].props?.maxConcurrency) === "1";
    const queueRecord = records.find((record) => record.node === queues[0]);
    const queueIsGlobal = queues.length === 1 && Boolean(queueRecord) && !queueRecord!.ancestors.some((tag) => tag === "smithers:ralph" || tag === "smithers:parallel" || tag === "smithers:merge-queue" || tag === "smithers:worktree");
    topology = parallels.length > 0 && loops.length >= 2 && queueIsSerialized && queueIsGlobal && tasks.some((task: any) => task.parallelGroupId) && tasks.some((task: any) => task.ralphId);
    typedOutputs = tasks.length > 0 && tasks.every((task: any) => task.outputSchema && typeof task.outputSchema === "object" && task.outputSchema.shape);
    noContinueOnFail = tasks.every((task: any) => task.continueOnFail !== true);
    graphDetail = rendered.toXml();
  } catch (error) {
    graphDetail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  const typecheck = run("pnpm", ["exec", "tsc", "--noEmit", "--project", join(target.dir, "tsconfig.json")]);
  const test = registered ? run("bun", ["test", "--preload", join(root, ".smithers", "preload.ts"), target.test], target.dir) : { ok: false, output: "test is not registered" };
  const testContract = testSource.includes("renderWorkflow(") && testSource.includes("phase1-issue-sweep.tsx");
  const testRegisteredAndGreen = registered && testContract && test.ok;
  const passed = graph && noReservedColumns && noNestedLoop && topology && typedOutputs && noContinueOnFail && typecheck.ok && testRegisteredAndGreen;
  return { passed, graph, noReservedColumns, noNestedLoop, oneMergeQueue: topology, topology, typedOutputs, noContinueOnFail, typecheck: typecheck.ok, testRegisteredAndGreen, detail: [graphDetail, typecheck.output, test.output].join("\n").slice(-6000) };
}

export default smithers((ctx) => {
  const target = paths(ctx.runId);
  return (
    <Workflow name="phase1-authoring-benchmark">
      <Sequence>
        <Task id="init" output={outputs.init} noRetry>
          {() => initScratch(ctx.runId)}
        </Task>
        <Task id="author" output={outputs.artifact} agent={models.haiku} retries={0} timeoutMs={30 * 60_000}>
          {`Author a miniature issue-sweep workflow in ${target.candidate} and its production test in ${target.test}. Work only in ${target.dir}. Use typed Zod outputs, parallel per-item lanes, exactly one global <MergeQueue maxConcurrency={1}> after those lanes, and one correction <Loop> per item. The supported topology is per-item Parallel lanes containing a correction Loop; do not nest loops through a forked lane. Use ctx.latest in each loop until condition and ctx.outputMaybe(schema, {nodeId, iteration}) for a previous-iteration read. The test must import the real workflow, call renderWorkflow with representative input, and be registered by the test script in ${target.packageJson}. Do not use continueOnFail on the authoring success path, do not hand-build a graph, and do not edit files outside ${target.dir}.`}
        </Task>
        <Task id="gates" output={outputs.verdict} noRetry>
          {async () => gateCandidate(ctx.runId)}
        </Task>
      </Sequence>
    </Workflow>
  );
});
