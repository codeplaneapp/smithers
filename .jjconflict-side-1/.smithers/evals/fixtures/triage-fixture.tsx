// Deterministic fixture workflow for the triage-run eval suite. Compute nodes
// only: seeding runs costs zero agent calls. The `mode` input picks which
// terminal state the run lands in (failed with a specific error, or suspended
// on an approval gate). Failure texts carry the evidence triage-run must read;
// mode names are neutral so the run input does not leak the expected action.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const inputSchema = z.object({
  mode: z
    .string()
    .nullable()
    .default(null)
    .describe("Fixture scenario: orders-csv | orders-parse | upstream-fetch | signoff."),
});

const prepareSchema = z.object({
  ready: z.boolean(),
  note: z.string(),
});

const exportSchema = z.object({
  result: z.string(),
});

// Matches the Approval component's output shape.
const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

const { Workflow, Task, Sequence, Approval, smithers, outputs } = createSmithers({
  input: inputSchema,
  prepare: prepareSchema,
  exportOrders: exportSchema,
  approval: approvalSchema,
});

const FAILURES: Record<string, string> = {
  "orders-csv":
    "Output failed schema validation: expected required field `summary` (string) in the export-orders output, got undefined. The reply did not match the declared zod output schema after 3 repair attempts; every attempt produced the same shape.",
  "orders-parse":
    "TypeError: Cannot read properties of null (reading 'items') at parseOrders (orders/parse.ts:42:18). The upstream fetch returned an empty body that parseOrders never guards against; this crashes on every attempt with the same input.",
  "upstream-fetch":
    "fetch failed: connect ECONNRESET api.upstream.example:443 after 30000ms. The request never reached the service and no state was modified; the upstream was reachable again moments later.",
};

export default smithers((ctx) => {
  const mode = ctx.input.mode ?? "orders-csv";
  const prepared = ctx.outputMaybe("prepare", { nodeId: "prepare" }) !== undefined;

  return (
    <Workflow name="orders-sync">
      <Sequence>
        <Task id="prepare" output={outputs.prepare}>
          {() => ({ ready: true, note: "Loaded 1240 orders for the nightly sync batch." })}
        </Task>

        {prepared ? (
          mode === "signoff" ? (
            <Approval
              id="release-signoff"
              output={outputs.approval}
              request={{
                title: "Release the nightly orders sync to production",
                summary: "The batch is staged. A human must sign off before rows are written to the warehouse.",
              }}
            />
          ) : (
            <Task id="export-orders" output={outputs.exportOrders} retries={0}>
              {() => {
                throw new Error(FAILURES[mode] ?? FAILURES["orders-csv"]);
              }}
            </Task>
          )
        ) : null}
      </Sequence>
    </Workflow>
  );
});
