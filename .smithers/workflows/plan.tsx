// smithers-source: seeded
// smithers-display-name: Plan
/** @jsxImportSource smithers-orchestrator */
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
    <PlanPanel idPrefix="plan" prompt={ctx.input.prompt} />
  </Workflow>
));
