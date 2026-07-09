// smithers-source: seeded
// smithers-display-name: Improve Test Coverage
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema } from "../components/Review";

const inputSchema = z.object({
  prompt: z.string().default("Improve the test coverage for the current repository."),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="improve-test-coverage">
    <UI entry="../ui/improve-test-coverage.tsx" title={"Improve Test Coverage"} />
    <ValidationLoop
      idPrefix="improve-test-coverage"
      prompt={ctx.input.prompt}
      implementAgents={agents.implement}
      validateAgents={agents.midTier}
      reviewAgents={[agents.review]}
    />
  </Workflow>
));
