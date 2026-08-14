/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { SmithersDb } from "@smthrs/db/adapter";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { Sequence } from "../../components/src/components/Sequence.js";
import { Task } from "../../components/src/components/Task.js";
import { Workflow } from "../../components/src/components/Workflow.js";
import { runWorkflow } from "../src/engine.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

const TIMEOUT_MS = 30_000;

/**
 * `agent={[a, b]}` is documented as a run-wide breaker. Before this fix the
 * breaker only held inside one node: the quota round and the retry rung both
 * read the CURRENT node's attempts and key on chain index, so a second node
 * re-probed the engine the first node had already proved dead. Observed on
 * oneshot-mssgmr3t-6939b7f0 and oneshot-mssi6m38-5e983988: kimi exhausted its
 * provider quota on `implement`, and `review` walked into it again.
 */
describe("fallback chain: run-wide dead-engine breaker", () => {
  test(
    "an engine that exhausted its quota is skipped by later nodes of the same run",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      try {
        let quotaProbes = 0;
        const quotaDead = {
          id: "quota-dead",
          tools: {},
          async generate() {
            quotaProbes += 1;
            throw new SmithersError("AGENT_QUOTA_EXCEEDED", 'Agent "quota-dead" hit a provider usage/quota limit.', {
              failureQuota: true,
            });
          },
        };
        let healthyCalls = 0;
        const healthy = {
          id: "healthy",
          tools: {},
          async generate() {
            healthyCalls += 1;
            return { output: { value: healthyCalls } };
          },
        };
        const chain = [quotaDead, healthy];
        const workflow = smithers(() => (
          <Workflow name="run-wide-dead-agent">
            <Sequence>
              <Task id="first" output={outputs.outputA} agent={chain} retries={2}>
                first
              </Task>
              <Task id="second" output={outputs.outputB} agent={chain} retries={2}>
                second
              </Task>
            </Sequence>
          </Workflow>
        ));
        const runId = "run-wide-dead-agent-run";

        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));

        expect(result.status).toBe("finished");
        // One probe total: `first` attempt 1. `first` attempt 2 and every
        // attempt of `second` must go straight to the healthy tail.
        expect(quotaProbes).toBe(1);
        expect(healthyCalls).toBe(2);

        const secondAttempts = await Effect.runPromise(adapter.listAttempts(runId, "second", 0));
        expect(secondAttempts.length).toBe(1);
        expect(JSON.parse(secondAttempts[0]?.metaJson ?? "{}").agentId).toBe("healthy");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "the breaker is rebuilt from durable attempts, so a resumed run does not re-probe",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      try {
        let quotaProbes = 0;
        const quotaDead = {
          id: "quota-dead",
          tools: {},
          async generate() {
            quotaProbes += 1;
            throw new SmithersError("AGENT_QUOTA_EXCEEDED", 'Agent "quota-dead" hit a provider usage/quota limit.', {
              failureQuota: true,
            });
          },
        };
        let healthyCalls = 0;
        const healthy = {
          id: "healthy",
          tools: {},
          async generate() {
            healthyCalls += 1;
            return { output: { value: 42 } };
          },
        };
        const runId = "run-wide-dead-agent-resume";
        const build = (nodeId) =>
          smithers(() => (
            <Workflow name="run-wide-dead-agent-resume">
              <Task id={nodeId} output={outputs.outputA} agent={[quotaDead, healthy]} retries={2}>
                work
              </Task>
            </Workflow>
          ));

        // Segment 1: burn the quota on the lead, land on the tail.
        await Effect.runPromise(runWorkflow(build("first"), { input: {}, runId }));
        expect(quotaProbes).toBe(1);

        // Segment 2 resumes the same run with a new node. The in-memory
        // breaker is gone; only the durable attempt rows remain.
        await Effect.runPromise(runWorkflow(build("second"), { input: {}, runId, resume: true }));

        expect(quotaProbes).toBe(1);
        const secondAttempts = await Effect.runPromise(adapter.listAttempts(runId, "second", 0));
        expect(JSON.parse(secondAttempts[0]?.metaJson ?? "{}").agentId).toBe("healthy");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a healthy lead is never skipped",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      try {
        let leadCalls = 0;
        const lead = {
          id: "lead",
          tools: {},
          async generate() {
            leadCalls += 1;
            return { output: { value: 1 } };
          },
        };
        const tail = {
          id: "tail",
          tools: {},
          async generate() {
            throw new Error("tail must not run: the lead is healthy");
          },
        };
        const workflow = smithers(() => (
          <Workflow name="healthy-lead-kept">
            <Sequence>
              <Task id="first" output={outputs.outputA} agent={[lead, tail]}>
                first
              </Task>
              <Task id="second" output={outputs.outputB} agent={[lead, tail]}>
                second
              </Task>
            </Sequence>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "healthy-lead-kept-run" }));
        expect(result.status).toBe("finished");
        expect(leadCalls).toBe(2);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
