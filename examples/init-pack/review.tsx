// Example only: review is preserved here instead of being installed by default.
// It remains an example because the default init pack is deliberately curated; run `smithers graph examples/init-pack/review.tsx` after copying its imports.
// Copy this implementation and its referenced .smithers prompts/components/UI/lib files into a project to use it.
// smithers-source: seeded
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
