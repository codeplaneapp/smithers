// Example only: plan is preserved here instead of being installed by default.
// It remains an example because the default init pack is deliberately curated; run `smithers graph examples/init-pack/plan.tsx` after copying its imports.
// Copy this implementation and its referenced .smithers prompts/components/UI/lib files into a project to use it.
// smithers-source: seeded
// smithers-display-name: Plan
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { PlanPanel, planOutputSchema, planSynthesisSchema } from "../components/PlanPanel";

const inputSchema = z.object({
  prompt: z.string().default("Create an implementation plan."),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  plan: planOutputSchema,
  planSynthesis: planSynthesisSchema,
});

export default smithers((ctx) => (
  <Workflow name="plan">
    <UI entry="../ui/plan.tsx" title={"Plan"} />
    <PlanPanel idPrefix="plan" prompt={ctx.input.prompt} />
  </Workflow>
));
