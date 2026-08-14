// Example only: plan is preserved here instead of being installed by default.
// Turn a plain-English request into an ordered implementation plan. It remains an example because the curated init pack installs only authoring and documentation workflows. Run `smithers graph examples/init-pack/plan.tsx` after copying it into a project.
// Copy this implementation and its referenced .smithers prompts/components/UI/lib files into a project to use it.
// smithers-source: seeded
// smithers-display-name: Plan
/** @jsxImportSource smthrs */
import { UI } from "smthrs";
import { createSmithers } from "smthrs";
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
