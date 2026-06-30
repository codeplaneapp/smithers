// smithers-source: user
// smithers-display-name: Review Codex Antigravity
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { ReviewPanel, reviewOutputSchema, reviewSynthesisSchema } from "../components/Review";

const inputSchema = z.object({
  prompt: z.string().default("Review the current repository changes."),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
});

const codexAntigravityReviewers = [providers.codex, providers.codex1, providers.antigravity1];

export default smithers((ctx) => (
  <Workflow name="review-codex-antigravity">
    <ReviewPanel
      idPrefix="review"
      prompt={ctx.input.prompt}
      agents={codexAntigravityReviewers}
      moderator={providers.codex}
    />
  </Workflow>
));
