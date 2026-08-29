// smithers-display-name: Plue Pipeline CI Fast
/** @jsxImportSource smithers-orchestrator */
import { UI, createSmithers, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";
import { failIfRed, pipelineCheckSchema, receiptSchema, recordPipelineReceipt, runPipelineSteps } from "./lib";

const inputSchema = z.object({ sha: z.string().default("") });

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  check: pipelineCheckSchema,
  receipt: receiptSchema,
});

export default smithers((ctx) => (
  <Workflow name="pipelines-ci-fast">
    <UI entry="../../ui/pipelines-ci-fast.tsx" title="Plue Pipeline CI Fast" />
    <Sequence>
      <Task id="fast-tier" output={outputs.check} timeoutMs={1_800_000}>
        {async () =>
          runPipelineSteps([
            { name: "go-vet", command: ["go", "vet", "./..."], timeoutMs: 900_000 },
            { name: "go-test-short", command: ["go", "test", "-short", "-timeout=120s", "./cmd/...", "./internal/...", "./pkg/..."], timeoutMs: 1_200_000 },
            { name: "migration-contract", command: ["bun", "scripts/check-migration-contract.ts"], timeoutMs: 300_000 },
          ])}
      </Task>
      <Task id="receipt" output={outputs.receipt}>
        {async () => {
          const check = ctx.outputMaybe(outputs.check, { nodeId: "fast-tier" });
          if (!check) throw new Error("fast-tier produced no output");
          return recordPipelineReceipt("fast", check.verdict, check.durationMs, ctx.input.sha);
        }}
      </Task>
      <Task id="fail-if-red" output={outputs.check}>
        {() => {
          const check = ctx.outputMaybe(outputs.check, { nodeId: "fast-tier" });
          if (!check) throw new Error("fast-tier produced no output");
          failIfRed(check, "plue-ci-fast");
          return check;
        }}
      </Task>
    </Sequence>
  </Workflow>
));
