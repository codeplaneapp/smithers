// smithers-source: authored
// smithers-display-name: Workflow Authoring Benchmark
// smithers-description: A builder agent authors a miniature issue-sweep workflow; scored deterministically (no LLM judges) against the rules in docs/workflows/authoring-rules.mdx.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, ClaudeCodeAgent as BaseClaudeCodeAgent } from "smithers-orchestrator";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod/v4";

/**
 * This is the benchmark research/workflow-authoring-friction-postmortem.md
 * asks for: "haiku can build this." A builder agent is given a single prompt
 * (below) describing a miniature issue-sweep workflow and must author it
 * end-to-end (workflow .tsx + registered test) with NO further guidance.
 * Every gate is deterministic (process exit codes, string/regex checks on the
 * produced source, a real `bun test` run) -- there is no LLM judge anywhere
 * in the scoring path, by design: this benchmark exists to prove the Phase-1
 * static-check + docs fixes actually close the authoring-feedback loop, so
 * the score must be as trustworthy as the checks it stands in for.
 */

const inputSchema = z.object({
  builderModel: z.string().default("claude-haiku-4-5").describe("The model that authors the candidate workflow."),
});

const buildResultSchema = z.object({
  workflowPath: z.string(),
  testPath: z.string().nullable(),
  summary: z.string(),
});

const scoreSchema = z.object({
  graphRendersClean: z.boolean(),
  graphError: z.string().nullable(),
  singleMergeQueue: z.boolean(),
  mergeQueueCount: z.number().int(),
  typecheckGreen: z.boolean(),
  testRegistered: z.boolean(),
  testGreen: z.boolean(),
  allPassed: z.boolean(),
  detail: z.string(),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  build: buildResultSchema,
  score: scoreSchema,
});

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
export const BENCH_DIR = resolve(REPO_ROOT, ".smithers", "workflows", ".authoring-benchmark");
export const CANDIDATE_ID = "bench-issue-sweep";
export const CANDIDATE_WORKFLOW_PATH = resolve(BENCH_DIR, `${CANDIDATE_ID}.tsx`);
export const CANDIDATE_TEST_PATH = resolve(BENCH_DIR, `${CANDIDATE_ID}.test.tsx`);

function builderPrompt(): string {
  return [
    `Author a Smithers workflow file at the EXACT path \`.smithers/workflows/.authoring-benchmark/${CANDIDATE_ID}.tsx\` (create the directory if it does not exist). Do not write anywhere else.`,
    ``,
    `The workflow is a miniature "issue sweep": given a fixed list of 3 issue numbers ([101, 102, 103], hardcode this list, no discovery step needed), it must:`,
    `1. Render one PARALLEL lane per issue number (\`<Parallel>\` containing one child per issue).`,
    `2. Each lane runs a bounded CORRECTION \`<Loop>\` (id it uniquely per issue, e.g. \`issue-\${n}-loop\`) with \`maxIterations\` and \`onMaxReached="return-last"\`, containing a Task that produces a typed output (a Zod object schema registered via \`createSmithers\`) recording whether the issue is "fixed".`,
    `3. After the Parallel block, exactly ONE global \`<MergeQueue>\` (maxConcurrency 1) lands the fixed issues (a Task per fixed issue, output typed via a registered Zod schema).`,
    `4. Every output schema must avoid the reserved column names \`runId\`, \`nodeId\`, \`iteration\` (input may not reuse \`runId\` either).`,
    `5. Do NOT nest a <Loop> as the literal immediate child of another <Loop> anywhere (that throws NESTED_LOOP) -- the per-issue correction loop must be reached through the <Parallel> lane, not wrapped in a second outer loop.`,
    `6. No agent calls are required -- every Task may use a plain compute function (a JS function returning a static/deterministic object) so this workflow runs instantly with no network access. Do not import or reference any agent.`,
    ``,
    `Also author a test file at \`.smithers/workflows/.authoring-benchmark/${CANDIDATE_ID}.test.tsx\` that imports \`renderWorkflow\` from \`smithers-orchestrator/testing\`, imports the workflow module you just wrote, and calls \`renderWorkflow\` on it (a real render of the real workflow, not a hand-built graph object) asserting the graph renders without throwing. Register this new test file in \`.smithers/package.json\`'s \`test\` script (append its path to that space-separated list) so it actually runs under \`pnpm test\`.`,
    ``,
    `When finished, verify your own work: run \`bun run .smithers/../apps/cli/src/index.js graph .smithers/workflows/.authoring-benchmark/${CANDIDATE_ID}.tsx\` (or the shorter \`bunx smithers-orchestrator graph\` if available) and confirm it renders with no error before you finish.`,
    ``,
    `Return workflowPath (the workflow file's path), testPath (the test file's path), and a one-sentence summary.`,
  ].join("\n");
}

function runCommand(cwd: string, command: string, args: string[], timeoutMs: number, extraEnv: Record<string, string> = {}) {
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

export function scoreCandidate(): z.infer<typeof scoreSchema> {
  const notes: string[] = [];

  if (!existsSync(CANDIDATE_WORKFLOW_PATH)) {
    return {
      graphRendersClean: false,
      graphError: "candidate workflow file was not written",
      singleMergeQueue: false,
      mergeQueueCount: 0,
      typecheckGreen: false,
      testRegistered: false,
      testGreen: false,
      allPassed: false,
      detail: "candidate workflow file was not written at the expected path",
    };
  }

  // 1. Graph renders clean -- no NESTED_LOOP / reserved-column / render error.
  const graphResult = runCommand(
    REPO_ROOT,
    "bun",
    ["run", resolve(REPO_ROOT, "apps/cli/src/index.js"), "graph", resolve(CANDIDATE_WORKFLOW_PATH)],
    120_000,
  );
  const graphOutput = `${graphResult.stdout}\n${graphResult.stderr}`;
  const graphRendersClean = graphResult.exitCode === 0;
  const graphError = graphRendersClean ? null : graphOutput.slice(-4000);
  notes.push(`graph: ${graphRendersClean ? "clean" : "FAILED"}`);

  // 2. Exactly one <MergeQueue>.
  const source = readFileSync(CANDIDATE_WORKFLOW_PATH, "utf8");
  const mergeQueueMatches = source.match(/<MergeQueue\b/g) ?? [];
  const mergeQueueCount = mergeQueueMatches.length;
  const singleMergeQueue = mergeQueueCount === 1;
  notes.push(`mergeQueueCount=${mergeQueueCount}`);

  // 3. .smithers typecheck.
  // .smithers typecheck can OOM locally on the default heap; give it headroom.
  const typecheckResult = runCommand(resolve(REPO_ROOT, ".smithers"), "pnpm", ["typecheck"], 10 * 60_000, {
    NODE_OPTIONS: "--max-old-space-size=8192",
  });
  const typecheckGreen = typecheckResult.exitCode === 0;
  notes.push(`typecheck: ${typecheckGreen ? "green" : "RED"}`);
  if (!typecheckGreen) notes.push(`typecheck tail: ${`${typecheckResult.stdout}\n${typecheckResult.stderr}`.slice(-2000)}`);

  // 4. Test registered in .smithers/package.json and green.
  const pkgJsonPath = resolve(REPO_ROOT, ".smithers", "package.json");
  const pkgJson = readFileSync(pkgJsonPath, "utf8");
  const testRegistered = existsSync(CANDIDATE_TEST_PATH) && pkgJson.includes(`.authoring-benchmark/${CANDIDATE_ID}.test.tsx`);
  notes.push(`testRegistered=${testRegistered}`);
  let testGreen = false;
  if (testRegistered) {
    const testResult = runCommand(
      resolve(REPO_ROOT, ".smithers"),
      "bun",
      ["test", "--preload", "./preload.ts", `./workflows/.authoring-benchmark/${CANDIDATE_ID}.test.tsx`],
      120_000,
    );
    testGreen = testResult.exitCode === 0;
    notes.push(`test: ${testGreen ? "green" : "RED"}`);
    if (!testGreen) notes.push(`test tail: ${`${testResult.stdout}\n${testResult.stderr}`.slice(-2000)}`);
  }

  const allPassed = graphRendersClean && singleMergeQueue && typecheckGreen && testRegistered && testGreen;
  return {
    graphRendersClean,
    graphError,
    singleMergeQueue,
    mergeQueueCount,
    typecheckGreen,
    testRegistered,
    testGreen,
    allPassed,
    detail: notes.join(" | "),
  };
}

export default smithers((ctx) => {
  const builderModel = ctx.input.builderModel ?? "claude-haiku-4-5";
  const builder = new BaseClaudeCodeAgent({ model: builderModel });
  const build = ctx.outputMaybe(outputs.build, { nodeId: "build" });
  mkdirSync(BENCH_DIR, { recursive: true });

  return (
    <Workflow name="authoring-benchmark">
      <Sequence>
        <Task id="build" output={outputs.build} agent={builder} timeoutMs={20 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
          {builderPrompt()}
        </Task>
        {build ? (
          <Task id="score" output={outputs.score}>
            {() => scoreCandidate()}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});

/** Deletes the scratch candidate directory, so re-runs start clean. Exported for the eval harness / manual reset. */
export function resetBenchmarkScratch(): void {
  rmSync(BENCH_DIR, { recursive: true, force: true });
}
