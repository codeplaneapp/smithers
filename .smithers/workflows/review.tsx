// smithers-source: user
// smithers-display-name: Review
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { panelists } from "../components/roles";
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
  <Workflow name="review">
    <UI entry="../ui/review.tsx" title={"Review"} />
    <ReviewPanel idPrefix="review" prompt={ctx.input.prompt} agents={panelists} />
  </Workflow>
));
