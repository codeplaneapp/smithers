// smithers-source: e2e
// smithers-display-name: E2E Probe
/** @jsxImportSource smthrs */
import { UI } from "smthrs";
import { ClaudeCodeAgent, createSmithers } from "smthrs";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";

const probeOutputSchema = z.object({
  answer: z.string(),
});

const probeAgent = codexFirst({ model: "gpt-5.6-terra", cwd: process.cwd(), skipGitRepoCheck: true }, [
  new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd: process.cwd() }),
]);

const { Workflow, Task, smithers } = createSmithers({
  probe: probeOutputSchema,
});

export default smithers(() => (
  <Workflow name="e2e-probe">
    <UI entry="../ui/e2e-probe.tsx" title={"E2E Probe"} />
    <Task id="probe" output={probeOutputSchema} agent={probeAgent} timeoutMs={180_000}>
      {
        'Return only valid JSON matching this schema: {"answer":"one short plain sentence"}. Use a real one-line answer in the answer field.'
      }
    </Task>
  </Workflow>
));
