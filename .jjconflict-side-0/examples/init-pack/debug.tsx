// Example only: debug is preserved here instead of being installed by default.
// Diagnose a failure, propose a fix, and verify the result. It remains an example because the curated init pack installs only authoring and documentation workflows. Run `smithers graph examples/init-pack/debug.tsx` after copying it into a project.
// Copy this implementation and its referenced .smithers prompts/components/UI/lib files into a project to use it.
// smithers-source: seeded
// smithers-display-name: Debug
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema } from "../components/Review";

const inputSchema = z.object({
  prompt: z.string().default("Reproduce and fix the reported bug."),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="debug">
    <UI entry="../ui/debug.tsx" title={"Debug"} />
    <ValidationLoop
      idPrefix="debug"
      prompt={ctx.input.prompt}
      implementAgents={agents.implement}
      validateAgents={agents.midTier}
      reviewAgents={[agents.review]}
    />
  </Workflow>
));
