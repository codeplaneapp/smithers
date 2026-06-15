// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Hodge Counterexample Search
// smithers-description: Coordinate a cautious, evidence-first search for Hodge-conjecture counterexample candidates with independent verification and synthesis.
// smithers-tags: research, math, verification, search
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import ScopePrompt from "../prompts/hodge-counterexample-scope.mdx";
import SearchPrompt from "../prompts/hodge-counterexample-search.mdx";
import VerifyPrompt from "../prompts/hodge-counterexample-verify.mdx";
import ReviewPrompt from "../prompts/hodge-counterexample-review.mdx";
import SynthesizePrompt from "../prompts/hodge-counterexample-synthesize.mdx";

const DEFAULT_QUESTION =
  "Search for explicit, reproducible counterexample candidates related to the Hodge conjecture. Favor conservative claims, computable invariants, and clear reasons a candidate fails or needs more work.";

const STRATEGIES = [
  {
    id: "hypersurface-periods",
    title: "Hypersurfaces and periods",
    focus:
      "Search explicit smooth projective hypersurfaces or complete intersections where period calculations, Picard-Fuchs systems, or Abel-Jacobi invariants could expose a rational Hodge class not accounted for by known algebraic cycles.",
  },
  {
    id: "abelian-hodge-classes",
    title: "Abelian varieties and Hodge classes",
    focus:
      "Search abelian varieties, products, and CM examples where exceptional Hodge classes appear, then check whether known theorems already account for them algebraically.",
  },
  {
    id: "kahler-extensions",
    title: "Kahler and variant counterexamples",
    focus:
      "Separate genuine projective-rational Hodge conjecture candidates from known false variants, including integral, generalized, and compact Kahler extensions.",
  },
] as const;

const conjectureVariantSchema = z.enum([
  "rational-projective",
  "integral",
  "kahler-extension",
  "complexified",
  "unspecified",
]);

const inputSchema = z.object({
  question: z.string().default(DEFAULT_QUESTION).describe("The search request or hypothesis to investigate."),
  conjectureVariant: conjectureVariantSchema
    .default("rational-projective")
    .describe("Which Hodge-conjecture variant the workflow should target."),
  searchBudget: z
    .number()
    .int()
    .default(3)
    .describe("Soft budget for candidate families per search strategy."),
  requireReproducibleComputation: z
    .boolean()
    .default(true)
    .describe("Require runnable computational evidence before the final report may mark a candidate reproducible."),
  additionalContext: z
    .string()
    .nullable()
    .default(null)
    .describe("Optional papers, formulas, repo paths, or constraints supplied by the user."),
});

const scopeSchema = z.looseObject({
  targetStatement: z.string(),
  variant: conjectureVariantSchema,
  admissibleClaims: z.array(z.string()).default([]),
  knownSafeRegions: z.array(z.string()).default([]),
  knownFalseVariants: z.array(z.string()).default([]),
  searchConstraints: z.array(z.string()).default([]),
  evidenceStandard: z.string(),
  summary: z.string(),
});

const candidateSchema = z.object({
  id: z.string(),
  varietyFamily: z.string(),
  dimension: z.string(),
  codimension: z.string(),
  hodgeClass: z.string(),
  nonAlgebraicityClaim: z.string(),
  computationPlan: z.string(),
  evidence: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  confidence: z.enum(["low", "medium", "high"]).default("low"),
});

const searchSchema = z.looseObject({
  strategyId: z.string(),
  strategyTitle: z.string(),
  candidateFound: z.boolean().default(false),
  candidates: z.array(candidateSchema).default([]),
  negativeResults: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
  artifacts: z.array(z.string()).default([]),
  summary: z.string(),
});

const verificationSchema = z.looseObject({
  reproduced: z.boolean().default(false),
  acceptedCandidates: z.array(z.string()).default([]),
  rejectedCandidates: z.array(z.string()).default([]),
  inconclusiveCandidates: z.array(z.string()).default([]),
  checksRun: z.array(z.string()).default([]),
  missingEvidence: z.array(z.string()).default([]),
  strongestCandidateId: z.string().nullable().default(null),
  summary: z.string(),
});

const reviewSchema = z.looseObject({
  approved: z.boolean().default(false),
  strongestCandidateId: z.string().nullable().default(null),
  fatalIssues: z.array(z.string()).default([]),
  overclaims: z.array(z.string()).default([]),
  requiredFollowups: z.array(z.string()).default([]),
  summary: z.string(),
});

const finalSchema = z.looseObject({
  status: z.enum(["no-candidate", "candidate-rejected", "candidate-needs-verification", "reproducible-candidate"]),
  strongestCandidateId: z.string().nullable().default(null),
  summary: z.string(),
  evidencePackage: z.array(z.string()).default([]),
  caveats: z.array(z.string()).default([]),
  nextExperiments: z.array(z.string()).default([]),
});

const { Workflow, Task, Sequence, Parallel, smithers, outputs } = createSmithers({
  input: inputSchema,
  scope: scopeSchema,
  search: searchSchema,
  verification: verificationSchema,
  review: reviewSchema,
  final: finalSchema,
});

export default smithers((ctx) => {
  const scope = ctx.outputMaybe("scope", { nodeId: "scope" });
  const searches = ctx.outputs.search ?? [];
  const verification = ctx.outputMaybe("verification", { nodeId: "verify" });
  const review = ctx.outputMaybe("review", { nodeId: "review" });

  const base = {
    question: ctx.input.question ?? DEFAULT_QUESTION,
    conjectureVariant: ctx.input.conjectureVariant ?? "rational-projective",
    searchBudget: ctx.input.searchBudget ?? 3,
    requireReproducibleComputation: ctx.input.requireReproducibleComputation ?? true,
    additionalContext: ctx.input.additionalContext,
  };

  return (
    <Workflow name="hodge-counterexample-search">
      <Sequence>
        <Task id="scope" output={outputs.scope} agent={agents.smartTool}>
          <ScopePrompt input={base} />
        </Task>

        {scope ? (
          <Parallel id="search-lenses" maxConcurrency={3}>
            {STRATEGIES.map((strategy) => (
              <Task
                key={strategy.id}
                id={`search:${strategy.id}`}
                output={outputs.search}
                agent={agents.smartTool}
                heartbeatTimeoutMs={900_000}
              >
                <SearchPrompt input={base} scope={scope} strategy={strategy} />
              </Task>
            ))}
          </Parallel>
        ) : null}

        {searches.length === STRATEGIES.length ? (
          <Task id="verify" output={outputs.verification} agent={agents.smartTool} heartbeatTimeoutMs={900_000}>
            <VerifyPrompt input={base} scope={scope} searches={searches} />
          </Task>
        ) : null}

        {verification ? (
          <Task id="review" output={outputs.review} agent={agents.smart}>
            <ReviewPrompt input={base} scope={scope} searches={searches} verification={verification} />
          </Task>
        ) : null}

        {review ? (
          <Task id="synthesize" output={outputs.final} agent={agents.smart}>
            <SynthesizePrompt
              input={base}
              scope={scope}
              searches={searches}
              verification={verification}
              review={review}
            />
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
