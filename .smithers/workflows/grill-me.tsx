// smithers-source: user
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
    maxIterations: z.number().int().min(1).max(100).default(30),
  }),
  grill: grillOutputSchema,
});

export default smithers((ctx) => {
  const latest = ctx.latest("grill", `${WORKFLOW_ID}:grill`) as { resolved?: boolean } | undefined;
  return (
    <Workflow name={WORKFLOW_ID}>
      <UI entry="../ui/grill-me.tsx" title={"Grill Me"} />
      <GrillMe idPrefix={WORKFLOW_ID} context={ctx.input.prompt} currentDraft={latest ?? null} agent={agents.smart} output={outputs.grill} maxIterations={ctx.input.maxIterations} until={latest?.resolved === true} />
    </Workflow>
  );
});
