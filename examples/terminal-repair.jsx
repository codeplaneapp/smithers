/**
 * A compute task fails terminally on a missing filesystem precondition. Its
 * declared repair agent creates the file, then Smithers runs the compute task
 * once more. Run with: smithers up examples/terminal-repair.jsx
 */
import { CodexAgent } from "smthrs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createExampleSmithers } from "./_example-kit.js";

const resultSchema = z.object({ contents: z.string() });
const repairSchema = z.object({
  repaired: z.boolean(),
  summary: z.string(),
  filesChanged: z.array(z.string()),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  result: resultSchema,
  repair: repairSchema,
});

const repairAgent = new CodexAgent({
  model: "gpt-5.4",
  systemPrompt: "Repair only the declared precondition, then report the exact file changed.",
});

export default smithers((ctx) => {
  const marker = `/tmp/smithers-terminal-repair-${ctx.runId}.txt`;
  return (
    <Workflow name="terminal-repair">
      <Task
        id="read-required-file"
        output={outputs.result}
        noRetry
        repair={{
          agent: repairAgent,
          output: outputs.repair,
          instructions: `Create ${marker} containing exactly: repaired by Smithers`,
        }}
      >
        {async () => ({ contents: await readFile(marker, "utf8") })}
      </Task>
    </Workflow>
  );
});
