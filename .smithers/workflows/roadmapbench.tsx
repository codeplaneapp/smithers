// smithers-display-name: RoadmapBench
/** @jsxImportSource smithers-orchestrator */
//
// RoadmapBench-on-smithers: a multi-agent, long-horizon software-development
// workflow that mixes Claude Opus 4.8 and Codex 5.5 to implement a real
// version-upgrade "roadmap" (multiple independent targets) against a pinned
// V_old repository.
//
// FAIRNESS CONTRACT (see benchmarks/roadmapbench/README.md):
//   * The agents only ever see the V_old repo (cwd) and instruction.md.
//   * The hidden per-target tests and the oracle patch live OUTSIDE the repo
//     and are introduced only by the scorer, in a separate fresh container.
//   * The reward is produced by the task's own tests/test.sh weighted scoring,
//     proven sound by harness/validate_task.sh (oracle=1.0, no-op=0.0).
//
import { readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClaudeCodeAgent,
  CodexAgent,
  Sequence,
  Task,
  createScorer,
  createSmithers,
} from "smithers-orchestrator";
import { z } from "zod/v4";

const HARNESS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../benchmarks/roadmapbench/harness",
);

const inputSchema = z.object({
  taskId: z.string(),
  image: z.string(),
  container: z.string(),
  repoDir: z.string(),
  instructionPath: z.string(),
  testsDir: z.string(),
  workDir: z.string(),
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

const reviewSchema = z.object({
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

const finalizeSchema = z.object({
  ready: z.boolean().default(false),
  targetsComplete: z.array(z.string()).default([]),
  backwardCompatChecked: z.boolean().default(false),
  notes: z.string().default(""),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  plan: planSchema,
  implement: implementSchema,
  review: reviewSchema,
  finalize: finalizeSchema,
});

// --- scorer: runs the hidden test suite via the validated harness ---------
function roadmapScorer(input: z.infer<typeof inputSchema>) {
  return createScorer({
    id: "roadmapbench-reward",
    name: "RoadmapBench Reward",
    description:
      "Weighted fraction of per-target hidden tests that pass (the official RoadmapBench reward).",
    score: async () => {
      const outDir = join(input.workDir, "score");
      const reward = await new Promise<{ reward: number; raw: string }>(
        (resolve) => {
          execFile(
            "bash",
            [
              join(HARNESS, "score.sh"),
              input.image,
              input.repoDir,
              input.testsDir,
              outDir,
            ],
            { timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 },
            (_err, stdout) => {
              const last = String(stdout).trim().split("\n").pop() ?? "0";
              const n = Number.parseFloat(last);
              resolve({ reward: Number.isFinite(n) ? n : 0, raw: String(stdout) });
            },
          );
        },
      );
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(readFileSync(join(outDir, "reward.json"), "utf8"));
      } catch {
        /* reward.json absent → reward stays 0 */
      }
      // persist for the orchestrator (authoritative, single source of truth)
      try {
        writeFileSync(
          join(input.workDir, "score.json"),
          JSON.stringify({ taskId: input.taskId, ...meta, reward: reward.reward }, null, 2),
        );
      } catch {
        /* best effort */
      }
      return {
        score: reward.reward,
        reason: `RoadmapBench reward ${reward.reward} (${JSON.stringify(meta)})`,
        meta,
      };
    },
  });
}

export default smithers((ctx) => {
  const input = ctx.input;
  const instruction = readFileSync(input.instructionPath, "utf8");

  // Mixed model fleet: Opus 4.8 plans/implements/finalizes the interdependent
  // GP work; Codex 5.5 runs an independent adversarial review-and-fix pass.
  const common = {
    cwd: input.repoDir,
    yolo: true,
    timeoutMs: 75 * 60_000,
    idleTimeoutMs: 12 * 60_000,
  };
  const opus = new ClaudeCodeAgent({ ...common, model: "claude-opus-4-8" });
  const codex = new CodexAgent({ ...common, model: "gpt-5.5" });

  const ENV = `## Working environment

You are working DIRECTLY in a checkout of the project at the V_old release
(your current working directory). Your file edits here are the deliverable.

To BUILD, IMPORT, or RUN any code (the project's own test suite, a REPL, type
checks, etc.) use the project's real toolchain, which is pre-installed in a
container that mounts THIS SAME directory at /app:

    docker exec ${input.container} bash -lc '<command>'      # cwd is /app

Example:  docker exec ${input.container} bash -lc 'python -c "import optuna"'
Example:  docker exec ${input.container} bash -lc 'cd /app && python -m pytest tests/<some_existing_test>.py -x -q'

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

  return (
    <Workflow name="roadmapbench">
      <Sequence>
        <Task id="plan" output={planSchema} agent={opus}>
          {`You are the lead engineer for a long-horizon version-upgrade task: "${input.taskId}".

${ENV}

# The development roadmap (your only spec)
${instruction}

# Your job (PLAN ONLY — do not write product code yet)
Explore the repository thoroughly (read the modules named in the roadmap, the
existing tests, the public API surface). Then produce a concrete implementation
plan that decomposes the work into the roadmap's independent targets. For each
target list the files you'll touch and the precise approach. Identify the build/
test command for sanity-checking. Note interdependencies (some targets build on
others) and ordering. Be specific and technical.`}
        </Task>

        <Task id="implement" output={implementSchema} agent={opus}>
          {`Continue task "${input.taskId}". Now IMPLEMENT the full roadmap.

${ENV}

# The development roadmap (your only spec)
${instruction}

# Plan from the planning phase
${JSON.stringify(ctx.outputMaybe("plan", { nodeId: "plan" }) ?? {}, null, 2)}

# Your job
Implement EVERY target in the roadmap, end to end, editing files in the working
directory. After each significant change, sanity-check by importing the changed
modules and running the project's OWN relevant tests via docker exec. Make all
documented classes/functions importable from their documented paths with the
documented signatures, defaults, and error/warning behavior. Maintain backward
compatibility. Do not stop until all targets are implemented and your own
sanity checks pass. Report exactly what you changed.`}
        </Task>

        <Task id="review" output={reviewSchema} agent={codex}>
          {`You are an independent senior reviewer (a DIFFERENT engineer and model)
auditing the implementation for task "${input.taskId}". Be adversarial and precise.

${ENV}

# The development roadmap (the spec the implementation must satisfy)
${instruction}

# What the implementer reported
${JSON.stringify(ctx.outputMaybe("implement", { nodeId: "implement" }) ?? {}, null, 2)}

# Your job
Independently verify each target against the spec. Look hard for: missing
classes/methods, wrong signatures or defaults, wrong import paths, missing
exception/warning behavior, half-finished refactors, leftover old API that the
roadmap said to remove, and broken backward compatibility. Use docker exec to
import every documented symbol and run the project's own tests. When you find a
defect, FIX IT directly in the code. Re-verify after fixing. Report the issues
you found and the fixes you applied.`}
        </Task>

        <Task
          id="finalize"
          output={finalizeSchema}
          agent={opus}
          scorers={{
            reward: { scorer: roadmapScorer(input), sampling: { type: "all" } },
          }}
        >
          {`Final completeness pass for task "${input.taskId}".

${ENV}

# The development roadmap (the spec)
${instruction}

# Reviewer report
${JSON.stringify(ctx.outputMaybe("review", { nodeId: "review" }) ?? {}, null, 2)}

# Your job
Do a final end-to-end verification. For EVERY target and every documented
symbol: confirm it is importable from the documented path with the documented
signature/defaults and behaves per the spec (including exceptions/warnings).
Run the project's own relevant tests via docker exec. Fix anything still wrong.
Confirm backward compatibility (existing public APIs still import and behave).
Only set ready=true when you are confident every target is fully implemented.`}
        </Task>
      </Sequence>
    </Workflow>
  );
});
