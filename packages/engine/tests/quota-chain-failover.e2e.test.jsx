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

const quotaError = (resetAtMs) =>
  new SmithersError("AGENT_QUOTA_EXCEEDED", "You've hit your usage limit.", {
    failureQuota: true,
    ...(resetAtMs != null ? { quotaResetAtMs: resetAtMs } : {}),
  });

describe("quota failover across an agent chain", () => {
  test(
    "a rate-limited agent hands the task to the next agent in the chain instead of parking the run",
    async () => {
      const { smithers, outputs, tables, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      try {
        let primaryCalls = 0;
        let fallbackCalls = 0;
        const primary = {
          id: "primary",
          tools: {},
          async generate() {
            primaryCalls += 1;
            throw quotaError(Date.now() + 3_600_000);
          },
        };
        const fallback = {
          id: "fallback",
          tools: {},
          async generate() {
            fallbackCalls += 1;
            return { output: { value: 42 } };
          },
        };
        const workflow = smithers(() => (
          <Workflow name="quota-failover">
            <Task id="q" output={outputs.outputA} agent={[primary, fallback]} retries={0}>
              do the work on whichever provider is not rate-limited
            </Task>
          </Workflow>
        ));
        const runId = "quota-failover-run";

        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));

        expect(result.status).toBe("finished");
        expect(primaryCalls).toBe(1);
        expect(fallbackCalls).toBe(1);

        const run = await Effect.runPromise(adapter.getRun(runId));
        expect(run?.status).toBe("finished");
        const statuses = (await adapter.listEvents(runId, -1, 500))
          .filter((event) => event.type === "RunStatusChanged")
          .map((event) => JSON.parse(event.payloadJson).status);
        expect(statuses).not.toContain("waiting-quota");

        const rows = await db.select().from(tables.outputA);
        expect(rows.at(-1)?.value).toBe(42);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "the run only parks once EVERY agent in the chain is rate-limited, on the earliest reset",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      const now = Date.now();
      const primaryResetAtMs = now + 3_600_000;
      const fallbackResetAtMs = now + 600_000;
      try {
        let primaryCalls = 0;
        let fallbackCalls = 0;
        const primary = {
          id: "primary",
          tools: {},
          async generate() {
            primaryCalls += 1;
            if (primaryCalls === 1) throw quotaError(primaryResetAtMs);
            return { output: { value: primaryCalls } };
          },
        };
        const fallback = {
          id: "fallback",
          tools: {},
          async generate() {
            fallbackCalls += 1;
            throw quotaError(fallbackResetAtMs);
          },
        };
        const workflow = smithers(() => (
          <Workflow name="quota-all-blocked">
            <Task id="q" output={outputs.outputA} agent={[primary, fallback]} retries={0}>
              every provider is rate-limited
            </Task>
          </Workflow>
        ));
        const runId = "quota-all-blocked-run";

        const parked = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
        expect(parked.status).toBe("waiting-quota");
        expect(primaryCalls).toBe(1);
        expect(fallbackCalls).toBe(1);

        const run = await Effect.runPromise(adapter.getRun(runId));
        expect(run?.status).toBe("waiting-quota");
        const quotaMeta = JSON.parse(run?.errorJson ?? "null");
        expect(quotaMeta?.quotaBlockedCount).toBe(1);
        // The soonest provider to free up, not the last one that failed.
        expect(quotaMeta?.resetAtMs).toBe(fallbackResetAtMs);

        // Resuming starts a fresh failover round at the head of the chain
        // instead of ping-ponging between the two blocked providers.
        const resumed = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, resume: true }));
        expect(resumed.status).toBe("finished");
        expect(primaryCalls).toBe(2);
        expect(fallbackCalls).toBe(1);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a preflight-broken lead plus a rate-limited fallback parks the run waiting-quota instead of hard-failing",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      const fallbackResetAtMs = Date.now() + 600_000;
      try {
        let primaryCalls = 0;
        let fallbackCalls = 0;
        // e.g. Codex missing from PATH: every preflight fails, so the rung can
        // never serve a quota failover (issue #1482).
        const primary = {
          id: "primary",
          tools: {},
          async preflight() {
            throw new SmithersError("AGENT_CONFIG_INVALID", "codex: command not found", { preflight: true });
          },
          async generate() {
            primaryCalls += 1;
            return { output: { value: 1 } };
          },
        };
        const fallback = {
          id: "fallback",
          tools: {},
          async generate() {
            fallbackCalls += 1;
            throw quotaError(fallbackResetAtMs);
          },
        };
        const workflow = smithers(() => (
          <Workflow name="quota-preflight-broken-lead">
            <Task id="q" output={outputs.outputA} agent={[primary, fallback]} retries={1}>
              the dead lead must not masquerade as an available fallback
            </Task>
          </Workflow>
        ));
        const runId = "quota-preflight-broken-lead-run";

        const parked = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
        expect(parked.status).toBe("waiting-quota");
        expect(primaryCalls).toBe(0);
        expect(fallbackCalls).toBe(1);

        const run = await Effect.runPromise(adapter.getRun(runId));
        expect(run?.status).toBe("waiting-quota");
        const quotaMeta = JSON.parse(run?.errorJson ?? "null");
        expect(quotaMeta?.resetAtMs).toBe(fallbackResetAtMs);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "failing over on a rate limit does not consume the task's retry budget",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      try {
        let fallbackCalls = 0;
        const primary = {
          id: "primary",
          tools: {},
          async generate() {
            throw quotaError(Date.now() + 3_600_000);
          },
        };
        const fallback = {
          id: "fallback",
          tools: {},
          async generate() {
            fallbackCalls += 1;
            // Burns the one retry the task is allowed, then succeeds.
            if (fallbackCalls === 1) throw new Error("ordinary provider timeout");
            return { output: { value: fallbackCalls } };
          },
        };
        const workflow = smithers(() => (
          <Workflow name="quota-failover-retries">
            <Task id="q" output={outputs.outputA} agent={[primary, fallback]} retries={1}>
              the quota attempt must not eat the retry
            </Task>
          </Workflow>
        ));
        const runId = "quota-failover-retries-run";

        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
        expect(result.status).toBe("finished");
        expect(fallbackCalls).toBe(2);
        const attempts = await adapter.listAttempts(runId, "q", 0);
        expect(attempts).toHaveLength(3);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "run-wide quota disable survives pause and resume",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      const runId = "quota-disable-resume-run";
      try {
        let deadCalls = 0;
        let healthyCalls = 0;
        const dead = {
          id: "quota-dead",
          tools: {},
          async generate() {
            deadCalls += 1;
            throw quotaError(Date.now() + 3_600_000);
          },
        };
        const healthy = {
          id: "healthy",
          tools: {},
          async generate() {
            healthyCalls += 1;
            if (healthyCalls === 1) {
              await Effect.runPromise(adapter.requestRunPause(runId, Date.now()));
              await new Promise((resolve) => setTimeout(resolve, 350));
            }
            return { output: { value: healthyCalls } };
          },
        };
        const workflow = smithers(() => (
          <Workflow name="quota-disable-resume">
            <Task id="first" output={outputs.outputA} agent={[dead, healthy]} retries={0}>
              disable the dead engine
            </Task>
            <Task id="after-resume" output={outputs.outputB} agent={[dead, healthy]} retries={0}>
              resume without probing it
            </Task>
          </Workflow>
        ));

        const paused = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, maxConcurrency: 1 }));
        expect(paused.status).toBe("paused");
        expect(deadCalls).toBe(1);
        expect(healthyCalls).toBe(1);

        const resumed = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, resume: true }));
        expect(resumed.status).toBe("finished");
        expect(deadCalls).toBe(1);
        expect(healthyCalls).toBe(2);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "bad API-key preflight remains run-wide while healthy engines are never skipped",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      const runId = "auth-disable-resume-run";
      try {
        let badPreflights = 0;
        let healthyCalls = 0;
        const badKey = {
          id: "bad-api-key",
          tools: {},
          async preflight() {
            badPreflights += 1;
            throw new SmithersError("AGENT_CONFIG_INVALID", "401 invalid API key", { preflight: true });
          },
          async generate() {
            throw new Error("bad API-key engine must never generate");
          },
        };
        const healthy = {
          id: "healthy-auth-fallback",
          tools: {},
          async generate() {
            healthyCalls += 1;
            if (healthyCalls === 1) {
              await Effect.runPromise(adapter.requestRunPause(runId, Date.now()));
              await new Promise((resolve) => setTimeout(resolve, 350));
            }
            return { output: { value: healthyCalls } };
          },
        };
        const workflow = smithers(() => (
          <Workflow name="auth-disable-resume">
            <Task id="first" output={outputs.outputA} agent={[badKey, healthy]} retries={0}>
              skip the bad key
            </Task>
            <Task id="after-resume" output={outputs.outputB} agent={[badKey, healthy]} retries={0}>
              keep the healthy engine available
            </Task>
          </Workflow>
        ));

        const paused = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, maxConcurrency: 1 }));
        expect(paused.status).toBe("paused");
        const resumed = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, resume: true }));
        expect(resumed.status).toBe("finished");
        expect(badPreflights).toBe(1);
        expect(healthyCalls).toBe(2);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
