// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Delegation Chain
// smithers-description: Recursive multi-tier delegation — strong models refine the goal, decompose into tiered chunks, de-risk with research/POC probes, then execute with per-node backpressure (reviews over jj commit ranges, checks, developer previews), live-editable outputs, cost forecasts, and full scoring.
// smithers-tags: delegation, planning, concierge, migration
/** @jsxImportSource smithers-orchestrator */
import { DelegationChain, createSmithers, delegationSchemas } from "smithers-orchestrator";
import {
  estimateAccuracyScorer,
  humanPollScorer,
  planSolidityScorer,
  pocJudgmentScorer,
  tierFitScorer,
} from "smithers-orchestrator/scorers";
import { z } from "zod/v4";
import { agents } from "../agents";

// What you pass in. Only `prompt` is required — everything else defaults to
// fully-automatic operation (no approval gates, previews on, poll at the end).
const inputSchema = z.object({
  prompt: z.string().describe("The (possibly ambiguous) goal. Goal refinement will ask only genuine user-preference questions, each with a prefilled recommended answer."),
  approvalPolicy: z
    .string()
    .optional()
    .describe("When set, delegating agents may add approval gates where this policy applies (and pass a clarified policy down). Absent = no approval gates anywhere."),
  maxDepth: z.number().int().min(1).max(5).default(3).describe("Max decomposition depth."),
  maxConcurrency: z.number().int().min(1).max(8).default(4).describe("Max parallel tasks per fan-out phase."),
  maxDeriskRounds: z.number().int().min(1).max(6).default(3).describe("Max research/POC replan rounds per node."),
  maxQuestions: z.number().int().min(0).max(20).default(10).describe("Max goal-refinement questions."),
  maxAttempts: z.number().int().min(1).max(6).default(3).describe("Max exec+review attempts per leaf."),
  poll: z.boolean().default(true).describe("End the run with a short user poll that feeds the humanPoll score."),
  budgetUsd: z.number().positive().optional().describe("Hard cost budget; the run errors past it and warns at 80%."),
  budgetMinutes: z.number().positive().optional().describe("Hard wall-clock budget."),
});

// Register the input plus every delegation table (dcPlan, dcGates, dcProbe,
// dcReplan, dcExec, dcReview, dcDevPreview, …) so the graph, the UI fold
// (`useDelegationChain`), and time travel all share one durable schema.
const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  ...delegationSchemas,
});

// ── Tiers ────────────────────────────────────────────────────────────────────
// Labels, not model ids, mapped onto the generated ../agents pools (the only
// names guaranteed on every init, whatever accounts are registered): the
// FABLE SANDWICH supplies the strong ends (planning-led tiers plan/review),
// the implement pool executes leaves, and cheapFast renders previews +
// research probes at near-zero cost. Swap any tier here without touching the
// workflow body.
const tierAgents = {
  fable: agents.planning,
  opus: agents.smart,
  sonnet: agents.implement,
  haiku: agents.cheapFast,
};

// Judge for tier-fit runs on the cheap tier — judging "was this the right
// intelligence level" does not itself need a frontier model.
const delegationScorers = {
  run: {
    pocJudgment: pocJudgmentScorer(),
    planSolidity: planSolidityScorer(),
    estimateAccuracy: estimateAccuracyScorer(),
    humanPoll: humanPollScorer(),
    tierFit: tierFitScorer(agents.cheapFast[0] ?? agents.smart[0]),
  },
};

export default smithers((ctx) => {
  const input = ctx.input;
  const budget =
    input?.budgetUsd || input?.budgetMinutes
      ? { maxUsd: input?.budgetUsd, maxMinutes: input?.budgetMinutes }
      : undefined;
  return (
    <Workflow name="delegation-chain">
      <DelegationChain
        prompt={input?.prompt ?? ""}
        agents={tierAgents}
        outputs={outputs}
        approvalPolicy={input?.approvalPolicy}
        maxDepth={input?.maxDepth ?? 3}
        maxConcurrency={input?.maxConcurrency ?? 4}
        maxDeriskRounds={input?.maxDeriskRounds ?? 3}
        maxQuestions={input?.maxQuestions ?? 10}
        maxAttempts={input?.maxAttempts ?? 3}
        poll={input?.poll ?? true}
        budget={budget}
        scorers={delegationScorers}
      />
    </Workflow>
  );
});
