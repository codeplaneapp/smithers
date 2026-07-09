// smithers-source: user
// smithers-display-name: Restore Claude Implement Agents
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const restoreSchema = z.object({
  filePath: z.string(),
  restored: z.boolean(),
  message: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  restore: restoreSchema,
});

export default smithers(() => (
  <Workflow name="restore-claude-implement">
    <Task id="restore" output={outputs.restore}>
      {async () => {
        const path = await import("node:path");

        const workflowPath = path.resolve(process.cwd(), ".smithers/workflows/implement-codex-antigravity.tsx");
        return {
          filePath: workflowPath,
          restored: false,
          message: "No change needed: the implementation workflow is Codex-first and already retains Claude/Gemini as automatic fallback providers.",
        };
      }}
    </Task>
  </Workflow>
));
