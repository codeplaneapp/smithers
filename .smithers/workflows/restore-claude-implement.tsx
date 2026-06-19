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
        const fs = await import("node:fs/promises");
        const path = await import("node:path");

        const workflowPath = path.resolve(process.cwd(), ".smithers/workflows/implement-codex-antigravity.tsx");
        const source = await fs.readFile(workflowPath, "utf8");
        const codexAntigravity = "const codexAntigravityOnly = [providers.codex, providers.codex1, providers.antigravity1];";
        const withClaude =
          "const codexAntigravityOnly = [providers.codex, providers.codex1, providers.antigravity1, providers.claude, providers.claudeSonnet];";

        if (source.includes(withClaude)) {
          return {
            filePath: workflowPath,
            restored: false,
            message: "Claude providers were already present.",
          };
        }

        if (!source.includes(codexAntigravity)) {
          throw new Error("Expected Codex/Antigravity provider list was not found.");
        }

        await fs.writeFile(workflowPath, source.replace(codexAntigravity, withClaude));
        return {
          filePath: workflowPath,
          restored: true,
          message: "Added Claude providers back to implement-codex-antigravity.",
        };
      }}
    </Task>
  </Workflow>
));
