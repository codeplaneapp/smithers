// Example only: grill-me is preserved here instead of being installed by default.
// It remains an example because the default init pack is deliberately curated; run `smithers graph examples/init-pack/grill-me.tsx` after copying its imports.
// Copy this implementation and its referenced .smithers prompts/components/UI/lib files into a project to use it.
// smithers-source: seeded
// smithers-display-name: Grill Me
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { GrillMe, grillOutputSchema } from "../components/GrillMe";

const WORKFLOW_ID = "grill-me";

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({
    prompt: z.string().default("Describe what you want to get grilled on."),
    maxIterations: z.number().int().default(30),
  }),
  grill: grillOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name={WORKFLOW_ID}>
    <UI entry="../ui/grill-me.tsx" title={"Grill Me"} />
    <GrillMe
      idPrefix={WORKFLOW_ID}
      context={ctx.input.prompt}
      agent={agents.smart}
      output={outputs.grill}
      maxIterations={ctx.input.maxIterations}
    />
  </Workflow>
));
