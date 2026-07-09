// smithers-display-name: Issue 306 — case08 real product-path coverage
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";

// Self-workflow for GitHub issue #306 (audit: test-coverage gaps), tackling the
// still-open cov-11 finding: e2e/faults/case08-inspector-never-idle.test.ts is a
// HYBRID — it calls the real deriveRunState predicate against fabricated storage
// (hand-rolled INSERTs into an in-memory bun:sqlite plus fabricated
// pendingApproval/pendingTimer literals), so it never boots the real inspector
// read path. This grinds one focused test-coverage item: add a real
// product-path test that drives genuine smithers runs into a real SmithersDb and
// computes state exactly as the gateway inspector does (computeRunStateFromRow).

const inputSchema = z.object({
  prompt: z.string().default(DEFAULT_PROMPT()),
});

function DEFAULT_PROMPT(): string {
  return [
    "Add a real product-path e2e test for GitHub issue #306 (cov-11) that de-hybridizes case08.",
    "",
    "Context: e2e/faults/case08-inspector-never-idle.test.ts is a hybrid — it calls the real",
    "deriveRunState predicate but against FABRICATED storage (it hand-rolls `INSERT OR REPLACE",
    "INTO _smithers_runs` SQL into an in-memory bun:sqlite and passes fabricated",
    "pendingApproval/pendingTimer/pendingEvent literals). It never boots the real inspector read path.",
    "",
    "Create a NEW sibling test file: e2e/faults/case08-inspector-real-product-path.test.ts.",
    "It MUST use real backends only (No-mocks policy). Follow the style of",
    "e2e/faults/case03-restart-waiting-approval.test.ts.",
    "",
    "The test must:",
    "1. Use `createSmithers({ input, decision, deploy }, { dbPath })` with a temp dbPath under tmpdir(),",
    "   build a workflow `<Approval id=\"approve-deploy\"> then <Task id=\"deploy\">{ value }` via",
    "   React.createElement, `ensureSmithersTables(db)`, and `const adapter = new SmithersDb(db)`.",
    "2. `await Effect.runPromise(runWorkflow(workflow, { runId, input: { value: 7 } }))` and assert the",
    "   result status is 'waiting-approval'.",
    "3. `const run = await adapter.getRun(runId)`, then `const view = await computeRunStateFromRow(adapter, run)`",
    "   — the SAME call the gateway inspector uses (import from '@smithers-orchestrator/db/runState').",
    "   Assert `view.state === 'waiting-approval'`, that it is not idle-like, and that `view.blocked`",
    "   partially matches `{ kind: 'approval', nodeId: 'approve-deploy' }` via expect(...).toMatchObject(...)",
    "   (the real ReasonBlocked also carries a `requestedAt` string) — this proves the pending approval was",
    "   read back out of the REAL DB, not fabricated.",
    "4. A second test: a workflow with a single literal `<Task id=\"deploy\">{ value }` runs to completion",
    "   (status 'finished'); assert `computeRunStateFromRow` returns state 'succeeded' and never idle.",
    "5. Give each async test a 30_000 ms timeout and clean up temp db files in afterEach.",
    "",
    "Do NOT edit the existing case08-inspector-never-idle.test.ts. Do NOT add any test.skip.",
    "Keep root `pnpm typecheck` green. Verify with: `cd e2e && bun test faults/case08-inspector-real-product-path.test.ts`.",
  ].join("\n");
}

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="issue-306-audit-test-coverage-gaps-apps-gateway-ui">
    <ValidationLoop
      idPrefix="issue-306-cov"
      prompt={ctx.input.prompt ?? DEFAULT_PROMPT()}
      implementAgents={agents.implement}
      validateAgents={agents.midTier}
      reviewAgents={[agents.review]}
      reviewWhen={false}
      maxIterations={2}
    />
  </Workflow>
));
