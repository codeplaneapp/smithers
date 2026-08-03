/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { SmithersDb } from "@smthrs/db/adapter";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { Task } from "../../components/src/components/Task.js";
import { Workflow } from "../../components/src/components/Workflow.js";
import { runWorkflow } from "../src/engine.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

const TIMEOUT_MS = 30_000;

// Issue #1480: preflight-skipped chain leads left no record, and a broken
// mid-chain agent (kimi AGENT_SESSION_LOST) was re-selected on every retry
// because the retry rung re-scanned from BEFORE the agent that failed, so
// the chain tail never engaged.
describe("fallback chain: session-loss failover and skip records", () => {
  test(
    "a mid-chain agent failure advances the retry past it, and preflight skips are recorded on attempt meta",
    async () => {
      const { smithers, outputs, tables, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      try {
        const preflightFailingLead = (id) => ({
          id,
          tools: {},
          async preflight() {
            throw new Error(`${id}: CLI not installed`);
          },
          async generate() {
            throw new Error(`${id} should never run: preflight fails`);
          },
        });
        let brokenCalls = 0;
        const broken = {
          id: "kimi-broken",
          tools: {},
          async generate() {
            brokenCalls += 1;
            throw new SmithersError(
              "AGENT_SESSION_LOST",
              "Kimi session 0a1b2c3d-4e5f-6789-abcd-ef0123456789 is broken.",
              { failureRetryable: true, discardResumeSession: true, command: "kimi" },
            );
          },
        };
        let healthyCalls = 0;
        const healthy = {
          id: "healthy-tail",
          tools: {},
          async generate() {
            healthyCalls += 1;
            return { output: { value: 7 } };
          },
        };
        const workflow = smithers(() => (
          <Workflow name="session-loss-failover">
            <Task
              id="t"
              output={outputs.outputA}
              agent={[preflightFailingLead("lead-1"), preflightFailingLead("lead-2"), broken, healthy]}
              retries={1}
            >
              do the work
            </Task>
          </Workflow>
        ));
        const runId = "session-loss-failover-run";

        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));

        // Retry 1 must advance past the broken agent to the chain tail
        // instead of re-selecting it (the pre-#1480 behavior burned every
        // retry on the same broken agent and failed the node).
        expect(result.status).toBe("finished");
        expect(brokenCalls).toBe(1);
        expect(healthyCalls).toBe(1);

        const attempts = await Effect.runPromise(adapter.listAttempts(runId, "t", 0));
        const byNo = new Map(attempts.map((a) => [a.attempt, a]));
        const firstMeta = JSON.parse(byNo.get(1)?.metaJson ?? "{}");
        // The preflight-skipped leads leave a debuggable record instead of
        // vanishing silently.
        expect(firstMeta.agentChainSkips).toEqual([
          expect.objectContaining({ agentId: "lead-1", chainIndex: 0, reason: "preflight-failed" }),
          expect.objectContaining({ agentId: "lead-2", chainIndex: 1, reason: "preflight-failed" }),
        ]);
        expect(firstMeta.agentChainSkips[0].error).toContain("CLI not installed");
        expect(firstMeta.agentId).toBe("kimi-broken");
        const secondMeta = JSON.parse(byNo.get(2)?.metaJson ?? "{}");
        expect(secondMeta.agentId).toBe("healthy-tail");

        const rows = await db.select().from(tables.outputA);
        expect(rows.at(-1)?.value).toBe(7);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
