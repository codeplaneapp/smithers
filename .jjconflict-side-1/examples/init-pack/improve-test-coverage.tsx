// Example only: improve-test-coverage is preserved here instead of being installed by default.
// Find and add high-value tests for an existing code path. It remains an example because the curated init pack installs only authoring and documentation workflows. Run `smithers graph examples/init-pack/improve-test-coverage.tsx` after copying it into a project.
// Copy this implementation and its referenced .smithers prompts/components/UI/lib files into a project to use it.
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
