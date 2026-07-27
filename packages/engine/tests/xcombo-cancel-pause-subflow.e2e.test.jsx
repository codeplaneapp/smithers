/** @jsxImportSource smithers-orchestrator */
// Lifecycle controls (cancel / pause / resume) CROSSED with child workflows
// (<Subflow> child runs). Single-feature behaviour is covered elsewhere
// (pause-lifecycle.test.jsx, child-workflow-prefer-resume.test.jsx,
// dynamic-workflow-file-subflow.e2e.test.jsx); this file pins what happens
// when a lifecycle control lands on a parent or a child while a nested run is
// in flight.
//
// The child workflow shares the parent's db (the common case for a workflow
// object passed to <Subflow workflow={...}>), so the child's own run row,
// nodes and attempts are readable through the same adapter.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Effect } from "effect";
import { Parallel, Sequence, Subflow, Task, Workflow } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
// Relative import so these runs exercise THIS checkout's engine.
import { runWorkflow } from "../src/engine.js";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";

const TIMEOUT_MS = 60_000;
const TERMINAL_RUN_STATUSES = new Set(["finished", "failed", "cancelled", "canceled", "continued"]);

function buildSmithers() {
  return createTestSmithers({
    subflowOut: z.object({ topic: z.string() }),
    childOut: z.object({ topic: z.string() }),
    childAux: z.object({ topic: z.string() }),
  });
}

/**
 * @param {() => Promise<boolean> | boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate, timeoutMs = 20_000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

/**
 * A two-step child workflow: `c1` is slow enough that a lifecycle control
 * lands while it is in flight, `c2` is the successor that must NOT start once
 * a pause has been requested.
 * @param {{ smithers: any; outputs: any; journal: string[]; name: string; c1Ms?: number }} spec
 */
function twoStepChild({ smithers, outputs, journal, name, c1Ms = 1_200 }) {
  return smithers(
    () => (
      <Workflow name={name}>
        <Sequence>
          <Task id="c1" output={outputs.childAux} noRetry>
            {async () => {
              journal.push("c1");
              await sleep(c1Ms);
              return { topic: "c1" };
            }}
          </Task>
          <Task id="c2" output={outputs.childOut} noRetry>
            {async () => {
              journal.push("c2");
              return { topic: "c2" };
            }}
          </Task>
        </Sequence>
      </Workflow>
    ),
    { output: outputs.childOut },
  );
}

describe("lifecycle controls x child workflows", () => {
  test(
    "pausing a child run parks the parent resumably instead of failing it, and resuming the parent continues the child",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        const adapter = new SmithersDb(db);
        const journal = [];
        const childWorkflow = twoStepChild({ smithers, outputs, journal, name: "xc-pausechild-child" });
        const parent = smithers(() => (
          <Workflow name="xc-pausechild-parent">
            <Subflow id="sub" output={outputs.subflowOut} workflow={childWorkflow} retries={0} />
          </Workflow>
        ));
        const runId = "xc-pausechild-parent-run";
        const childRunId = `${runId}:child:sub:0`;
        const runPromise = Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        expect(await waitFor(() => journal.includes("c1"))).toBe(true);
        expect(await waitFor(async () => Boolean((await adapter.getRun(childRunId))?.heartbeatAtMs))).toBe(true);
        // Exactly what `smithers pause <childRunId>` writes: the child run row
        // is `running` with a fresh heartbeat, so the CLI accepts it.
        await adapter.requestRunPause(childRunId, Date.now());
        const first = await runPromise;

        // The child parks itself correctly...
        expect((await adapter.getRun(childRunId))?.status).toBe("paused");
        // ...but a paused child is NOT a failure: pausing part of a run must
        // leave the WHOLE run resumable, so the parent must park too rather
        // than fail with "Subflow sub failed with status paused".
        expect(first.status).toBe("paused");
        expect((await adapter.getRun(runId))?.status).toBe("paused");

        // Resuming the parent must pick the paused child back up where it
        // stopped: c1 is already finished, so only c2 may run.
        const resumed = await Effect.runPromise(runWorkflow(parent, { input: {}, runId, resume: true }));
        expect(resumed.status).toBe("finished");
        expect((await adapter.getRun(childRunId))?.status).toBe("finished");
        expect(journal.filter((entry) => entry === "c1")).toHaveLength(1);
        expect(journal.filter((entry) => entry === "c2")).toHaveLength(1);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "pausing a child drains an in-flight sibling before parking and does not replay it on resume",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        const adapter = new SmithersDb(db);
        const journal = [];
        const childWorkflow = twoStepChild({
          smithers,
          outputs,
          journal,
          name: "xc-pausechild-parallel-child",
          c1Ms: 600,
        });
        let siblingExecutions = 0;
        const parent = smithers(() => (
          <Workflow name="xc-pausechild-parallel-parent">
            <Parallel>
              <Subflow id="sub" output={outputs.subflowOut} workflow={childWorkflow} retries={0} />
              <Task id="sibling" output={outputs.childAux} noRetry>
                {async () => {
                  siblingExecutions += 1;
                  journal.push("sibling-start");
                  await sleep(1_400);
                  journal.push("sibling-end");
                  return { topic: "sibling" };
                }}
              </Task>
            </Parallel>
          </Workflow>
        ));
        const runId = "xc-pausechild-parallel-parent-run";
        const childRunId = `${runId}:child:sub:0`;
        const runPromise = Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        expect(await waitFor(() => journal.includes("c1") && journal.includes("sibling-start"))).toBe(true);
        expect(await waitFor(async () => Boolean((await adapter.getRun(childRunId))?.heartbeatAtMs))).toBe(true);

        await adapter.requestRunPause(childRunId, Date.now());
        const first = await runPromise;

        expect(first.status).toBe("paused");
        expect(journal).toContain("sibling-end");
        expect(await adapter.listInProgressAttempts(runId)).toEqual([]);
        expect((await adapter.getRun(runId))?.status).toBe("paused");

        const resumed = await Effect.runPromise(runWorkflow(parent, { input: {}, runId, resume: true }));
        expect(resumed.status).toBe("finished");
        expect(siblingExecutions).toBe(1);
        expect(journal.filter((entry) => entry === "sibling-start")).toHaveLength(1);
        expect(journal.filter((entry) => entry === "sibling-end")).toHaveLength(1);
        expect(journal.filter((entry) => entry === "c1")).toHaveLength(1);
        expect(journal.filter((entry) => entry === "c2")).toHaveLength(1);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "cancelling only the child drives the parent to a terminal state instead of retrying the cancellation forever",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      const adapter = new SmithersDb(db);
      const runId = "xc-cancelchild-parent-run";
      const childRunId = `${runId}:child:sub:0`;
      /** @type {Promise<any> | null} */
      let runPromise = null;
      try {
        let childExecutions = 0;
        const childWorkflow = smithers(
          () => (
            <Workflow name="xc-cancelchild-child">
              <Task id="slow" output={outputs.childOut} noRetry>
                {async () => {
                  childExecutions += 1;
                  await sleep(3_000);
                  return { topic: "done" };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        // No `retries` prop: the shipped default retry policy (infinite).
        const parent = smithers(() => (
          <Workflow name="xc-cancelchild-parent">
            <Subflow id="sub" output={outputs.subflowOut} workflow={childWorkflow} />
          </Workflow>
        ));
        /** @type {any} */
        let settled = null;
        runPromise = Effect.runPromise(runWorkflow(parent, { input: {}, runId })).then((result) => {
          settled = result;
          return result;
        });
        expect(await waitFor(() => childExecutions > 0)).toBe(true);
        expect(await waitFor(async () => Boolean((await adapter.getRun(childRunId))?.heartbeatAtMs))).toBe(true);
        // Exactly what `smithers cancel <childRunId>` writes.
        expect(await adapter.requestRunCancel(childRunId, Date.now())).toBe(true);
        // A cancelled child is a deliberate human stop, not a transient
        // fault: the parent must settle instead of retrying it forever.
        await waitFor(() => settled !== null, 15_000);
        expect((await adapter.getRun(childRunId))?.status).toBe("cancelled");
        const parentRow = await adapter.getRun(runId);
        const attempts = await adapter.listAttempts(runId, "sub", 0);
        expect(
          settled?.status ??
            `never-settled (run row status: ${parentRow?.status}, subflow attempts so far: ${attempts.length})`,
        ).toMatch(/^(finished|failed|cancelled)$/);
        expect(TERMINAL_RUN_STATUSES.has(String(parentRow?.status))).toBe(true);
        // ...and it must not burn an unbounded retry budget re-observing the
        // same durable cancellation.
        expect(attempts.length).toBeLessThanOrEqual(2);
        expect(childExecutions).toBe(1);
      } finally {
        // Never leave a spinning run behind, whatever the assertions did.
        try {
          await adapter.requestRunCancel(runId, Date.now());
        } catch {}
        if (runPromise) await runPromise.catch(() => {});
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "pausing the parent mid-child stops the child from scheduling new tasks and parks it resumably",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        const adapter = new SmithersDb(db);
        const journal = [];
        const childWorkflow = twoStepChild({ smithers, outputs, journal, name: "xc-pauseparent-child" });
        const parent = smithers(() => (
          <Workflow name="xc-pauseparent-parent">
            <Subflow id="sub" output={outputs.subflowOut} workflow={childWorkflow} retries={0} />
          </Workflow>
        ));
        const runId = "xc-pauseparent-parent-run";
        const childRunId = `${runId}:child:sub:0`;
        const runPromise = Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        expect(await waitFor(() => journal.includes("c1"))).toBe(true);
        // Exactly what `smithers pause <parentRunId>` writes.
        await adapter.requestRunPause(runId, Date.now());
        const first = await runPromise;
        expect(first.status).toBe("paused");
        // Graceful pause = "stop scheduling NEW tasks, let in-flight work
        // finish". The child's own driver must honour the parent's pause: c1
        // (in flight) finishes, c2 (not started) must not be scheduled, and
        // the child parks resumably. Otherwise a pause on a parent whose work
        // all lives in a subflow silently degrades to "wait for the entire
        // nested workflow", which for an agent subflow can be hours.
        expect(journal).not.toContain("c2");
        expect((await adapter.getRun(childRunId))?.status).toBe("paused");

        // Resuming the parent continues the parked child at c2, without
        // re-running the child work that already finished.
        const resumed = await Effect.runPromise(runWorkflow(parent, { input: {}, runId, resume: true }));
        expect(resumed.status).toBe("finished");
        expect((await adapter.getRun(childRunId))?.status).toBe("finished");
        expect(journal.filter((entry) => entry === "c1")).toHaveLength(1);
        expect(journal.filter((entry) => entry === "c2")).toHaveLength(1);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "cancelling the parent mid-child cancels the child run and leaks no running rows or in-progress attempts",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        const adapter = new SmithersDb(db);
        let childStarted = false;
        const childWorkflow = smithers(
          () => (
            <Workflow name="xc-cancelparent-child">
              <Task id="slow" output={outputs.childOut} noRetry>
                {async () => {
                  childStarted = true;
                  await sleep(15_000);
                  return { topic: "never" };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parent = smithers(() => (
          <Workflow name="xc-cancelparent-parent">
            <Subflow id="sub" output={outputs.subflowOut} workflow={childWorkflow} retries={0} />
          </Workflow>
        ));
        const runId = "xc-cancelparent-parent-run";
        const childRunId = `${runId}:child:sub:0`;
        const runPromise = Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        expect(await waitFor(() => childStarted)).toBe(true);
        expect(await waitFor(async () => Boolean((await adapter.getRun(childRunId))?.heartbeatAtMs))).toBe(true);
        // Exactly what `smithers cancel <parentRunId>` writes for a live run.
        await adapter.requestRunCancel(runId, Date.now());
        const result = await runPromise;
        expect(result.status).toBe("cancelled");
        // The in-flight child is cancelled with the parent: no zombie run row
        // left advertising itself as `running` to `smithers ps`.
        const childRow = await adapter.getRun(childRunId);
        expect(childRow?.status).toBe("cancelled");
        expect(childRow?.parentRunId).toBe(runId);
        expect(childRow?.heartbeatAtMs ?? null).toBeNull();
        expect(childRow?.runtimeOwnerId ?? null).toBeNull();
        expect((await adapter.listRuns(50, "running")).map((row) => row.runId)).toEqual([]);
        // Node + attempt bookkeeping settles on both sides.
        const parentNode = (await adapter.listNodes(runId)).find((node) => node.nodeId === "sub");
        expect(parentNode?.state).toBe("cancelled");
        const childNode = (await adapter.listNodes(childRunId)).find((node) => node.nodeId === "slow");
        expect(childNode?.state).toBe("cancelled");
        expect(await adapter.listInProgressAttempts(runId)).toEqual([]);
        expect(await adapter.listInProgressAttempts(childRunId)).toEqual([]);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a Subflow timeout cancels the running child instead of orphaning it",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        const adapter = new SmithersDb(db);
        const childWorkflow = smithers(
          () => (
            <Workflow name="xc-timeout-child">
              <Task id="slow" output={outputs.childOut} noRetry>
                {async () => {
                  await sleep(10_000);
                  return { topic: "never" };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parent = smithers(() => (
          <Workflow name="xc-timeout-parent">
            <Subflow id="sub" output={outputs.subflowOut} workflow={childWorkflow} timeoutMs={800} retries={0} />
          </Workflow>
        ));
        const runId = "xc-timeout-parent-run";
        const childRunId = `${runId}:child:sub:0`;
        const result = await Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        expect(result.status).toBe("failed");
        // Settles quickly and leaves no phantom running child behind.
        await waitFor(async () => (await adapter.getRun(childRunId))?.status !== "running", 5_000);
        expect((await adapter.getRun(childRunId))?.status).toBe("cancelled");
        expect((await adapter.listRuns(50, "running")).map((row) => row.runId)).toEqual([]);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
