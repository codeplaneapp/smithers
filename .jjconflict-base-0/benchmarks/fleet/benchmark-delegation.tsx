// smithers-source: benchmark-fleet
// smithers-display-name: Benchmark Delegation (Claude-only)
// smithers-description: Headless, zero-approval recursive delegation for long-horizon benchmark tasks. Opus plans and reviews, Opus delegates to Opus, and down to Sonnet to implement. No goal questions, no end poll — meant to run detached in a rollout container against one subscription.
// smithers-tags: benchmark, delegation, fleet
/** @jsxImportSource smithers-orchestrator */
import { DelegationChain, createSmithers, delegationSchemas } from "smithers-orchestrator";
import {
  estimateAccuracyScorer,
  planSolidityScorer,
  pocJudgmentScorer,
  tierFitScorer,
} from "smithers-orchestrator/scorers";
import { z } from "zod/v4";
import { buildFleetTiers } from "./buildFleetTiers";

// Only `prompt` is required. Everything else defaults to fully-automatic,
// headless operation: zero approval gates (approvalPolicy is never set), zero
// goal-refinement questions, and no end-of-run poll.
const inputSchema = z.object({
  prompt: z.string().describe("The benchmark task (problem statement + requirements)."),
  cwd: z.string().optional().describe("Working directory (the benchmark checkout). Agent edits here are the deliverable."),
  maxDepth: z.number().int().min(1).max(5).default(3),
  maxConcurrency: z.number().int().min(1).max(8).default(4),
  maxDeriskRounds: z.number().int().min(1).max(6).default(3),
  maxAttempts: z.number().int().min(1).max(6).default(3),
  budgetUsd: z.number().positive().optional(),
  budgetMinutes: z.number().positive().optional(),
  strongModel: z.string().optional().describe("Override the plan/review model (default Opus)."),
  implementModel: z.string().optional().describe("Override the implement model (default Sonnet)."),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  ...delegationSchemas,
});

// Tier-fit judging runs on the cheap tier; the humanPoll scorer is dropped
// because a headless benchmark run never polls a human.
const delegationScorers = {
  run: {
    pocJudgment: pocJudgmentScorer(),
    planSolidity: planSolidityScorer(),
    estimateAccuracy: estimateAccuracyScorer(),
  },
};

export default smithers((ctx) => {
  const input = ctx.input;
  const tiers = buildFleetTiers({
    cwd: input?.cwd,
    models: {
      ...(input?.strongModel ? { strong: input.strongModel, smart: input.strongModel } : {}),
      ...(input?.implementModel ? { implement: input.implementModel } : {}),
    },
  });
  const scorers = {
    ...delegationScorers,
    run: { ...delegationScorers.run, tierFit: tierFitScorer(tiers.haiku[0]) },
  };
  const budget =
    input?.budgetUsd || input?.budgetMinutes
      ? { maxUsd: input?.budgetUsd, maxMinutes: input?.budgetMinutes }
      : undefined;
  return (
    <Workflow name="benchmark-delegation">
      <DelegationChain
        prompt={input?.prompt ?? ""}
        agents={tiers}
        outputs={outputs}
        maxDepth={input?.maxDepth ?? 3}
        maxConcurrency={input?.maxConcurrency ?? 4}
        maxDeriskRounds={input?.maxDeriskRounds ?? 3}
        maxAttempts={input?.maxAttempts ?? 3}
        maxQuestions={0}
        poll={false}
        budget={budget}
        scorers={scorers}
      />
    </Workflow>
  );
});
