// smithers-source: seeded
// smithers-display-name: Smoke Test
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import SmoketestPrompt from "../prompts/smoketest.mdx";

const smoketestOutputSchema = z.looseObject({
  passed: z.boolean(),
  summary: z.string(),
  findings: z
    .array(
      z.object({
        area: z.string(),
        status: z.enum(["pass", "fail", "skipped"]),
        evidence: z.string(),
      }),
    )
    .default([]),
  reproSteps: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  prompt: z
    .string()
    .default(
      "Smoke test the latest published smithers-orchestrator release against the latest changelog entry.",
    ),
});

const { Workflow, Task, smithers } = createSmithers({
  input: inputSchema,
  smoketest: smoketestOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="smoketest">
    <Task id="smoketest" output={smoketestOutputSchema} agent={agents.smartTool}>
      <SmoketestPrompt prompt={ctx.input.prompt} />
    </Task>
  </Workflow>
));
