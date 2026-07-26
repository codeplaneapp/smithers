// smithers-source: user
// smithers-display-name: Implement
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers, Sequence, Task } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { implementer, panelists, polishReviewer } from "../components/roles";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema, reviewGate } from "../components/Review";

const inputSchema = z.object({
  prompt: z.string().default("Implement the requested change."),
});

const polishSchema = z.object({
  polished: z.boolean().describe("true when the final pass found nothing left to fix"),
  changesMade: z.array(z.string()).default([]).describe("polish edits applied, if any"),
  summary: z.string(),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
  polish: polishSchema,
});

export default smithers((ctx) => {
  const validate = ctx.latest("validate", "impl:validate") as
    | { allPassed?: boolean; failingSummary?: string | null }
    | undefined;

  // done = false until validate has actually run AND passed, AND the synthesized
  // review verdict approved.
  const hasValidated = validate !== undefined;
  const validationPassed = hasValidated && validate.allPassed !== false;
  const gate = reviewGate(ctx, "impl:review-moderator");
  const validateRounds = ctx.iterationCount("validate", "impl:validate");
  const reviewRounds = ctx.iterationCount("reviewSynthesis", "impl:review-moderator");
  const latestRaw = (rows: unknown[] | undefined) =>
    rows?.filter((row): row is Record<string, unknown> => Boolean(row)).at(-1);
  const paired =
    validateRounds === reviewRounds &&
    validateRounds > 0 &&
    latestRaw(ctx.outputs.validate)?.iteration === latestRaw(ctx.outputs.reviewSynthesis)?.iteration;
  const done = paired && validationPassed && gate.approved;

  const feedbackParts: string[] = [];
  if (validate && !validationPassed && validate.failingSummary) {
    feedbackParts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
  }
  if (paired && gate.feedback) {
    feedbackParts.push(`REVIEW PANEL REJECTED:\n${gate.feedback}`);
  }
  const feedback = feedbackParts.length > 0 ? feedbackParts.join("\n\n") : null;

  return (
    <Workflow name="implement">
      <UI entry="../ui/implement.tsx" title={"Implement"} />
      <Sequence>
        <ValidationLoop
          idPrefix="impl"
          prompt={ctx.input.prompt}
          implementAgents={implementer}
          validateAgents={agents.midTier}
          reviewAgents={panelists}
          synthesizeReview
          feedback={feedback}
          done={done}
          maxIterations={3}
        />

        {/* Closing review slice: once the feature is fully implemented
            (validation green + review approved), Codex Sol makes one
            final whole-feature polish pass over everything that changed. */}
        {done ? (
          <Task id="impl:polish" output={outputs.polish} agent={polishReviewer}>
            {`The feature below is fully implemented: validation passed and the review panel approved it. You are the FINAL polish reviewer.

FEATURE: ${ctx.input.prompt}

Review every change made for this feature end to end (diff the working tree / recent commits). Look for: naming and clarity, dead code, missing edge-case tests, doc drift, and any small correctness hazard the panel missed. Apply small, safe polish edits directly; re-run the relevant tests after any edit. Do NOT restructure or expand scope.

Return polished=true when nothing is left, changesMade listing any edits you applied, and a short summary.`}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
