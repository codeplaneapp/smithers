// smithers-source: user
// smithers-display-name: Review No Kimi
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

const workingReviewers = [
  providers.claude,
  providers.codex,
  providers.codex1,
  providers.antigravity1,
];

export default smithers((ctx) => (
  <Workflow name="review-nokimi">
    <ReviewPanel
      idPrefix="review"
      prompt={ctx.input.prompt}
      agents={workingReviewers}
      moderator={providers.codex}
    />
  </Workflow>
));
