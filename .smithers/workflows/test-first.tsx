// smithers-source: seeded
// smithers-display-name: Test First
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema } from "../components/Review";

const inputSchema = z.object({
  prompt: z.string().default("Write or update tests before implementation."),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="test-first">
    <ValidationLoop
      idPrefix="test-first"
      prompt={ctx.input.prompt}
      implementAgents={agents.smart}
      validateAgents={agents.cheapFast}
      reviewAgents={agents.smart}
    />
  </Workflow>
));
