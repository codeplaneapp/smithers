// smithers-source: user
// smithers-display-name: Implement Codex Antigravity
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { implementer, panelists, synthesizer, validator } from "../components/roles";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema, reviewGate } from "../components/Review";

const inputSchema = z.object({
  prompt: z.string().trim().min(1, "prompt must not be blank").default("Implement the requested change."),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
});

export default smithers((ctx) => {
  const iterationOf = (row: unknown) => {
    const iteration = Number((row as { iteration?: unknown } | undefined)?.iteration);
    return Number.isFinite(iteration) ? iteration : 0;
  };
  const newest = <T,>(rows: T[] | undefined) => {
    if (!rows?.length) return undefined;
    return rows.reduce((selected, row) => (iterationOf(row) >= iterationOf(selected) ? row : selected));
  };
  const validateRows = (ctx.outputs.validate ?? []) as Array<{
    nodeId?: string;
    iteration?: number;
    allPassed?: boolean;
    failingSummary?: string | null;
  }>;
  const reviewRows = (ctx.outputs.reviewSynthesis ?? []) as Array<{
    nodeId?: string;
    iteration?: number;
    approved?: boolean;
    feedback?: string | null;
  }>;
  const currentValidation = newest(validateRows.filter((row) => row.nodeId === "impl:validate"));
  const currentIteration = currentValidation ? iterationOf(currentValidation) : undefined;
  const currentReview =
    currentIteration === undefined
      ? undefined
      : newest(
          reviewRows.filter((row) => row.nodeId === "impl:review-moderator" && iterationOf(row) === currentIteration),
        );
  const validate = currentValidation;
  const gate = {
    approved: currentReview?.approved === true,
    feedback: currentReview?.approved === false ? (currentReview.feedback ?? null) : null,
  };
  const validationPassed = currentValidation?.allPassed === true;
  const paired = currentValidation !== undefined && currentReview !== undefined;
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
    <Workflow name="implement-codex-antigravity">
      <ValidationLoop
        idPrefix="impl"
        prompt={ctx.input.prompt}
        implementAgents={implementer}
        validateAgents={validator}
        reviewAgents={panelists}
        synthesizeReview
        reviewModerator={synthesizer}
        reviewWhen={validationPassed}
        feedback={feedback}
        done={done}
        maxIterations={3}
      />
    </Workflow>
  );
});
