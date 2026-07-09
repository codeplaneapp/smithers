// smithers-source: user
// smithers-display-name: Review No Kimi
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { panelists, synthesizer } from "../components/roles";
import { ReviewPanel, reviewOutputSchema, reviewSynthesisSchema } from "../components/Review";

const inputSchema = z.object({
  prompt: z.string().default("Review the current repository changes."),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
});

export default smithers((ctx) => (
  <Workflow name="review-nokimi">
    <ReviewPanel
      idPrefix="review"
      prompt={ctx.input.prompt}
      agents={panelists}
      moderator={synthesizer}
    />
  </Workflow>
));
