// smithers-source: authored
// smithers-display-name: OrchBench — orchestration-pattern benchmark
// smithers-description: Runs ONE RoadmapBench task under ONE orchestration pattern (solo-sol, solo-luna, plan-impl-review, research-first, panel-review) with single-model agents and the official hidden-test scorer, so patterns can be compared on quality/speed/cost. See benchmarks/orchbench/DESIGN.md.
/** @jsxImportSource smithers-orchestrator */
import { readFileSync } from "node:fs";
import {
  ClaudeCodeAgent,
  CodexAgent,
  KimiAgent,
  UI,
  createSmithers,
} from "smithers-orchestrator";
import { z } from "zod/v4";
import { roadmapScorer } from "../lib/roadmapScorer";

const MIN = 60_000;

const inputSchema = z.object({
  taskId: z.string(),
  image: z.string(),
  container: z.string(),
  repoDir: z.string(),
  instructionPath: z.string(),
  testsDir: z.string(),
  workDir: z.string(),
  pattern: z
    .enum(["solo-sol", "solo-luna", "plan-impl-review", "research-first", "panel-review"])
    .default("solo-sol"),
  panelThird: z.enum(["opus", "kimi"]).default("opus"),
  smoke: z.boolean().default(false),
});

const soloSchema = z.object({
  summary: z.string(),
  targetsAttempted: z.array(z.string()).default([]),
  filesChanged: z.array(z.string()).default([]),
  selfAssessment: z.string().default(""),
});

const researchSchema = z.object({
  repoOverview: z.string(),
  keyModules: z.array(z.string()).default([]),
  buildCommand: z.string().default(""),
  testCommand: z.string().default(""),
  risks: z.string().default(""),
});

const planSchema = z.object({
  targets: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        files: z.array(z.string()).default([]),
        approach: z.string(),
        risk: z.string().default(""),
      }),
    )
    .default([]),
  buildCommand: z.string().default(""),
  notes: z.string().default(""),
});

const implementSchema = z.object({
  summary: z.string(),
  targetsAttempted: z.array(z.string()).default([]),
  filesChanged: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
  selfAssessment: z.string().default(""),
});

const reviewFixSchema = z.object({
  summary: z.string(),
  issuesFound: z
    .array(
      z.object({
        severity: z.enum(["blocker", "major", "minor"]).default("major"),
        target: z.string().default(""),
        detail: z.string(),
      }),
    )
    .default([]),
  fixesApplied: z.array(z.string()).default([]),
  remainingConcerns: z.string().default(""),
});

const panelFindingSchema = z.object({
  summary: z.string(),
  issues: z
    .array(
      z.object({
        severity: z.enum(["blocker", "major", "minor"]).default("major"),
        target: z.string().default(""),
        detail: z.string(),
        suggestedFix: z.string().default(""),
      }),
    )
    .default([]),
  verifiedCommands: z.array(z.string()).default([]),
});

const fixSchema = z.object({
  summary: z.string(),
  issuesAddressed: z.array(z.string()).default([]),
  issuesRejected: z.array(z.string()).default([]),
  filesChanged: z.array(z.string()).default([]),
});

const { Workflow, Task, Sequence, Parallel, smithers, outputs } = createSmithers({
  input: inputSchema,
  solo: soloSchema,
  research: researchSchema,
  plan: planSchema,
  implement: implementSchema,
  reviewFix: reviewFixSchema,
  panelSol: panelFindingSchema,
  panelFable: panelFindingSchema,
  panelThird: panelFindingSchema,
  fix: fixSchema,
});

export default smithers((ctx) => {
  const input = ctx.input;
  const instruction = readFileSync(input.instructionPath, "utf8");
  const pattern = input.pattern ?? "solo-sol";

  // Single-model agents, deliberately NO fallback chains: a run labeled "sol"
  // must park on quota rather than silently switch identity (DESIGN.md).
  // input.smoke swaps every role to cheap luna-low — a real end-to-end
  // mechanics shakeout (graph, deps, panel, scorer) for cents. An input (not
  // an env var) so it reaches the detached engine and survives resume.
  const smoke = input.smoke === true;
  const common = { cwd: input.repoDir, yolo: true, idleTimeoutMs: 12 * MIN };
  const lunaLow = (timeoutMs: number) =>
    new CodexAgent({ ...common, timeoutMs, model: "gpt-5.6-luna", config: { model_reasoning_effort: "low" } });
  const sol = (timeoutMs: number) =>
    smoke
      ? lunaLow(timeoutMs)
      : new CodexAgent({ ...common, timeoutMs, model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" } });
  const luna = (timeoutMs: number) =>
    smoke
      ? lunaLow(timeoutMs)
      : new CodexAgent({ ...common, timeoutMs, model: "gpt-5.6-luna", config: { model_reasoning_effort: "medium" } });
  const fable = (timeoutMs: number) =>
    smoke ? lunaLow(timeoutMs) : new ClaudeCodeAgent({ ...common, timeoutMs, model: "claude-fable-5" });
  const third = (timeoutMs: number) =>
    smoke
      ? lunaLow(timeoutMs)
      : input.panelThird === "kimi"
        ? new KimiAgent({ ...common, timeoutMs })
        : new ClaudeCodeAgent({ ...common, timeoutMs, model: "claude-opus-4-8" });

  const reward = {
    reward: {
      scorer: roadmapScorer({
        taskId: input.taskId,
        image: input.image,
        repoDir: input.repoDir,
        testsDir: input.testsDir,
        workDir: input.workDir,
      }),
      sampling: { type: "all" as const },
    },
  };

  const ENV = `## Working environment

You are working DIRECTLY in a checkout of the project at the V_old release
(your current working directory). Your file edits here are the deliverable.

To BUILD, IMPORT, or RUN any code (the project's own test suite, a REPL, type
checks, etc.) use the project's real toolchain, which is pre-installed in a
container that mounts THIS SAME directory at /app:

    docker exec ${input.container} bash -lc '<command>'      # cwd is /app

Example:  docker exec ${input.container} bash -lc 'cd /app && ls'

Edits you make to files here are LIVE at /app immediately (bind mount).

## Rules (read carefully — this is a benchmark)
- Implement the roadmap by REASONING about and WRITING the code yourself.
- Do NOT fetch, install, git-checkout, or copy the project's *next/target
  release* (e.g. the upstream tag or a newer published package) to obtain the
  answer — that defeats the purpose. Installing already-present dependencies is
  fine; replacing the project source with an upstream release is NOT.
- There is no answer key in this repo. Implement to the SPEC: exact class names,
  import paths, constructor signatures, parameter defaults, and exception/warning
  behavior described in the roadmap.
- Preserve backward compatibility and existing behavior unless the roadmap says
  to change it.
- BENCHMARK INTEGRITY: your work is graded by HIDDEN, per-target tests you do not
  have and must not try to obtain. Do NOT search the host filesystem for tests,
  graders, oracle patches, or "solution" files, and do not write code whose only
  purpose is to make an unknown test pass (no monkeypatching pytest, no fake
  stubs, no conftest tricks). Implement the real feature. Every command you run
  and your final diff are audited; cheating invalidates the result.`;

  const ROADMAP = `# The development roadmap (your only spec)
${instruction}`;

  const soloPrompt = `You are the sole engineer for a long-horizon version-upgrade task: "${input.taskId}".

${ENV}

${ROADMAP}

# Your job (everything, end to end)
First explore the repository and form a brief plan decomposing the roadmap into
its independent targets. Then IMPLEMENT every target end to end, editing files
in the working directory. After each significant change, sanity-check by
importing the changed modules and running the project's OWN relevant tests via
docker exec. Make all documented classes/functions importable from their
documented paths with the documented signatures, defaults, and error/warning
behavior. Maintain backward compatibility. Before finishing, do a final
verification pass over EVERY target and every documented symbol. Do not stop
until all targets are implemented and your own sanity checks pass.`;

  const researchPrompt = `You are a fast reconnaissance engineer for task "${input.taskId}".

${ENV}

${ROADMAP}

# Your job (RESEARCH ONLY — do not edit any files)
Explore the repository quickly but thoroughly: the modules the roadmap names,
the public API surface, the existing tests, the build/test toolchain. Report a
concise repo overview, the key modules (paths) the roadmap will touch, the
exact build and test commands that work via docker exec, and the main risks or
tricky interactions an implementer should know about. Do NOT write or modify
any files.`;

  const planPrompt = (deps?: { research?: z.infer<typeof researchSchema> }) => `You are the lead engineer for a long-horizon version-upgrade task: "${input.taskId}".

${ENV}

${ROADMAP}
${
  deps?.research
    ? `
# Reconnaissance report from a colleague (verify, don't blindly trust)
${JSON.stringify(deps.research, null, 2)}
`
    : ""
}
# Your job (PLAN ONLY — do not write product code yet)
Explore the repository thoroughly (read the modules named in the roadmap, the
existing tests, the public API surface). Then produce a concrete implementation
plan that decomposes the work into the roadmap's independent targets. For each
target list the files you'll touch and the precise approach. Identify the build/
test command for sanity-checking. Note interdependencies (some targets build on
others) and ordering. Be specific and technical.`;

  const implementPrompt = (deps: { plan?: z.infer<typeof planSchema> }) => `Continue task "${input.taskId}". Now IMPLEMENT the full roadmap.

${ENV}

${ROADMAP}

# Plan from the planning phase
${JSON.stringify(deps.plan ?? {}, null, 2)}

# Your job
Implement EVERY target in the roadmap, end to end, editing files in the working
directory. After each significant change, sanity-check by importing the changed
modules and running the project's OWN relevant tests via docker exec. Make all
documented classes/functions importable from their documented paths with the
documented signatures, defaults, and error/warning behavior. Maintain backward
compatibility. Do not stop until all targets are implemented and your own
sanity checks pass. Report exactly what you changed.`;

  const reviewFixPrompt = (deps: { implement?: z.infer<typeof implementSchema> }) => `You are an independent senior reviewer (a DIFFERENT engineer and model)
auditing the implementation for task "${input.taskId}". Be adversarial and precise.

${ENV}

${ROADMAP}

# What the implementer reported
${JSON.stringify(deps.implement ?? {}, null, 2)}

# Your job
Independently verify each target against the spec. Look hard for: missing
classes/methods, wrong signatures or defaults, wrong import paths, missing
exception/warning behavior, half-finished refactors, leftover old API that the
roadmap said to remove, and broken backward compatibility. Use docker exec to
import every documented symbol and run the project's own tests. When you find a
defect, FIX IT directly in the code. Re-verify after fixing. Do a final
completeness pass over every target before you finish. Report the issues you
found and the fixes you applied.`;

  const panelPrompt = (deps: { implement?: z.infer<typeof implementSchema> }) => `You are one member of an independent review panel (each member is a
DIFFERENT frontier model) auditing the implementation for task "${input.taskId}".
Be adversarial and precise.

${ENV}

${ROADMAP}

# What the implementer reported
${JSON.stringify(deps.implement ?? {}, null, 2)}

# Your job (FINDINGS ONLY — do NOT edit any files)
Independently verify each target against the spec. Inspect the code (and
\`git diff HEAD\` in the working directory) and use docker exec to import every
documented symbol and run the project's own tests. Look hard for: missing
classes/methods, wrong signatures or defaults, wrong import paths, missing
exception/warning behavior, half-finished refactors, leftover old API the
roadmap said to remove, and broken backward compatibility. You MUST NOT modify
any file — a separate engineer applies fixes. For every issue report severity,
the target it belongs to, precise detail (file, symbol, what's wrong), and a
concrete suggested fix. Also list the commands you ran to verify.`;

  const fixPrompt = (deps: {
    panelSol?: z.infer<typeof panelFindingSchema>;
    panelFable?: z.infer<typeof panelFindingSchema>;
    panelThird?: z.infer<typeof panelFindingSchema>;
  }) => `Final fix pass for task "${input.taskId}". Three independent reviewers
(different frontier models) audited the implementation and filed findings.

${ENV}

${ROADMAP}

# Reviewer findings
## Reviewer A (sol)
${JSON.stringify(deps.panelSol ?? {}, null, 2)}
## Reviewer B (fable)
${JSON.stringify(deps.panelFable ?? {}, null, 2)}
## Reviewer C (third)
${JSON.stringify(deps.panelThird ?? {}, null, 2)}

# Your job
Merge the findings (they overlap). For each real issue: fix it directly in the
code and verify the fix via docker exec (import the symbol, run the project's
own relevant tests). If a finding is a false positive, verify that and reject
it with a one-line reason instead of "fixing" it. Preserve backward
compatibility. Report what you addressed, what you rejected, and files changed.`;

  return (
    <Workflow name="orchbench">
      <UI entry="../ui/orchbench.tsx" title={"OrchBench"} />
      {pattern === "solo-sol" ? (
        <Task id="solo" output={outputs.solo} agent={sol(150 * MIN)} timeoutMs={155 * MIN} heartbeatTimeoutMs={15 * MIN} scorers={reward}>
          {soloPrompt}
        </Task>
      ) : null}

      {pattern === "solo-luna" ? (
        <Task id="solo" output={outputs.solo} agent={luna(150 * MIN)} timeoutMs={155 * MIN} heartbeatTimeoutMs={15 * MIN} scorers={reward}>
          {soloPrompt}
        </Task>
      ) : null}

      {pattern === "plan-impl-review" ? (
        <Sequence>
          <Task id="plan" output={outputs.plan} agent={sol(75 * MIN)} timeoutMs={80 * MIN} heartbeatTimeoutMs={15 * MIN}>
            {planPrompt()}
          </Task>
          <Task id="implement" output={outputs.implement} agent={luna(75 * MIN)} timeoutMs={80 * MIN} heartbeatTimeoutMs={15 * MIN} deps={{ plan: outputs.plan }}>
            {implementPrompt}
          </Task>
          <Task id="review" output={outputs.reviewFix} agent={sol(75 * MIN)} timeoutMs={80 * MIN} heartbeatTimeoutMs={15 * MIN} deps={{ implement: outputs.implement }} scorers={reward}>
            {reviewFixPrompt}
          </Task>
        </Sequence>
      ) : null}

      {pattern === "research-first" ? (
        <Sequence>
          <Task id="research" output={outputs.research} agent={luna(30 * MIN)} timeoutMs={35 * MIN} heartbeatTimeoutMs={15 * MIN}>
            {researchPrompt}
          </Task>
          <Task id="plan" output={outputs.plan} agent={sol(60 * MIN)} timeoutMs={65 * MIN} heartbeatTimeoutMs={15 * MIN} deps={{ research: outputs.research }}>
            {planPrompt}
          </Task>
          <Task id="implement" output={outputs.implement} agent={luna(75 * MIN)} timeoutMs={80 * MIN} heartbeatTimeoutMs={15 * MIN} deps={{ plan: outputs.plan }}>
            {implementPrompt}
          </Task>
          <Task id="review" output={outputs.reviewFix} agent={sol(75 * MIN)} timeoutMs={80 * MIN} heartbeatTimeoutMs={15 * MIN} deps={{ implement: outputs.implement }} scorers={reward}>
            {reviewFixPrompt}
          </Task>
        </Sequence>
      ) : null}

      {pattern === "panel-review" ? (
        <Sequence>
          <Task id="plan" output={outputs.plan} agent={sol(75 * MIN)} timeoutMs={80 * MIN} heartbeatTimeoutMs={15 * MIN}>
            {planPrompt()}
          </Task>
          <Task id="implement" output={outputs.implement} agent={luna(75 * MIN)} timeoutMs={80 * MIN} heartbeatTimeoutMs={15 * MIN} deps={{ plan: outputs.plan }}>
            {implementPrompt}
          </Task>
          <Parallel maxConcurrency={3}>
            <Task id="panel-sol" output={outputs.panelSol} agent={sol(45 * MIN)} timeoutMs={50 * MIN} heartbeatTimeoutMs={15 * MIN} deps={{ implement: outputs.implement }}>
              {panelPrompt}
            </Task>
            <Task id="panel-fable" output={outputs.panelFable} agent={fable(45 * MIN)} timeoutMs={50 * MIN} heartbeatTimeoutMs={15 * MIN} deps={{ implement: outputs.implement }}>
              {panelPrompt}
            </Task>
            <Task id="panel-third" output={outputs.panelThird} agent={third(45 * MIN)} timeoutMs={50 * MIN} heartbeatTimeoutMs={15 * MIN} deps={{ implement: outputs.implement }}>
              {panelPrompt}
            </Task>
          </Parallel>
          <Task
            id="fix"
            output={outputs.fix}
            agent={luna(60 * MIN)}
            timeoutMs={65 * MIN}
            heartbeatTimeoutMs={15 * MIN}
            deps={{ panelSol: outputs.panelSol, panelFable: outputs.panelFable, panelThird: outputs.panelThird }}
            needs={{ panelSol: "panel-sol", panelFable: "panel-fable", panelThird: "panel-third" }}
            scorers={reward}
          >
            {fixPrompt}
          </Task>
        </Sequence>
      ) : null}
    </Workflow>
  );
});
