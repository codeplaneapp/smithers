// smithers-source: e2e
// smithers-display-name: E2E Probe
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const probeOutputSchema = z.object({
  answer: z.string(),
});

const claude = new ClaudeCodeAgent({
  model: "claude-sonnet-5",
  cwd: process.cwd(),
});

const { Workflow, Task, smithers } = createSmithers({
  probe: probeOutputSchema,
});

export default smithers(() => (
  <Workflow name="e2e-probe">
    <Task id="probe" output={probeOutputSchema} agent={claude} timeoutMs={180_000}>
      {'Return only valid JSON matching this schema: {"answer":"one short plain sentence"}. Use a real one-line answer in the answer field.'}
    </Task>
  </Workflow>
));
