// smithers-source: seeded
// smithers-display-name: Grill All Three
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Loop, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { grillOutputSchema } from "../components/GrillMe";
import GrillAllThreePrompt from "../prompts/grill-all-three.mdx";
import AskUserInstructions from "../prompts/ask-user-instructions.mdx";

const WORKFLOW_ID = "grill-all-three";

// Grills the user across the three Studio 2 specs (product -> design ->
// engineering) until none have open questions, folding each decision back into
// the docs as it goes. One grill+fold-in agent turn per loop iteration: the agent
// asks one question via ask-user.ts (blocking) and edits the spec in the same
// turn, so the user's answer is in-context for the fold-in. Modeled on grill-me.
// `resolved` flips true only when every spec is clean.
const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({
    docsDir: z.string().default("apps/smithers-studio-2/docs"),
    maxIterations: z.number().int().default(24),
  }),
  grill: grillOutputSchema,
});

export default smithers((ctx) => {
  const docsDir = ctx.input.docsDir || "apps/smithers-studio-2/docs";
  const history = ctx.outputs.grill || [];
  const latest = history[history.length - 1];
  const resolved = latest?.resolved === true;

  return (
    <Workflow name={WORKFLOW_ID}>
      <Sequence>
        <Loop until={resolved} maxIterations={ctx.input.maxIterations}>
          <Task id={`${WORKFLOW_ID}:grill`} output={outputs.grill} agent={agents.smart}>
            <GrillAllThreePrompt docsDir={docsDir} />
            <AskUserInstructions />
            {latest && `

## Progress so far
Result of the previous iteration:

\`\`\`json
${JSON.stringify(latest, null, 2)}
\`\`\`

Pick up from here: resolve the next open question (product -> design ->
engineering order). When every open/deferred question across all three specs is
resolved and folded into the docs, set \`resolved: true\` and stop.`}
          </Task>
        </Loop>
      </Sequence>
    </Workflow>
  );
});
