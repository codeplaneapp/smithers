/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Parallel, SmithersDb, Task, Timer, WaitForEvent, Workflow, runWorkflow, signalRun } from "smthrs";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { Effect } from "effect";
const END_TO_END_TIMEOUT_MS = 30_000;
function buildWaitSmithers() {
  return createTestSmithers({
    eventOut: z.object({ ok: z.boolean() }),
    sideOut: z.object({ value: z.number() }),
  });
}
describe("WaitForEvent timeout through the real engine", () => {
  test(
    "onTimeout=fail fails the run once the deadline passes with no signal",
    async () => {
      const { smithers, outputs, tables, db, cleanup } = buildWaitSmithers();
      try {
        const workflow = smithers(() => (
          <Workflow name="wait-timeout-fail">
            <WaitForEvent id="wait" event="deploy.ready" output={outputs.eventOut} timeoutMs={50} onTimeout="fail" />
          </Workflow>
        ));
        const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(first.status).toBe("waiting-event");
        await sleep(80);
        const resumed = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId: first.runId,
            resume: true,
          }),
        );
        expect(resumed.status).toBe("failed");
        expect(resumed.error?.message).toContain("Task failed: wait");
        const rows = await db.select().from(tables.eventOut);
        expect(rows.length).toBe(0);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
  test(
    "onTimeout=skip skips the wait and lets the run finish without an output row",
    async () => {
      const { smithers, outputs, tables, db, cleanup } = buildWaitSmithers();
      try {
        const workflow = smithers(() => (
          <Workflow name="wait-timeout-skip">
            <WaitForEvent id="wait" event="deploy.ready" output={outputs.eventOut} timeoutMs={50} onTimeout="skip" />
          </Workflow>
        ));
        const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(first.status).toBe("waiting-event");
        await sleep(80);
        const resumed = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId: first.runId,
            resume: true,
          }),
        );
        expect(resumed.status).toBe("finished");
        const rows = await db.select().from(tables.eventOut);
        expect(rows.length).toBe(0);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
  test(
    "a schema-violating payload does not finish the run as if it were valid",
    async () => {
      const { smithers, outputs, tables, db, cleanup } = buildWaitSmithers();
      try {
        const workflow = smithers(() => (
          <Workflow name="wait-schema-violation">
            <WaitForEvent
              id="wait"
              event="deploy.ready"
              output={outputs.eventOut}
              outputSchema={z.object({ ok: z.boolean() })}
            />
          </Workflow>
        ));
        const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(first.status).toBe("waiting-event");
        await Effect.runPromise(
          signalRun(
            new SmithersDb(db),
            first.runId,
            "deploy.ready",
            { ok: "definitely-not-a-boolean" },
            { receivedBy: "tester" },
          ),
        );
        const resumed = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId: first.runId,
            resume: true,
          }),
        );
        expect(resumed.status).not.toBe("finished");
        const rows = await db.select().from(tables.eventOut);
        expect(rows.filter((row) => row.ok === true).length).toBe(0);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
  test(
    "async wait lets independent siblings run before the event arrives",
    async () => {
      const { smithers, outputs, tables, db, cleanup } = buildWaitSmithers();
      try {
        const workflow = smithers(() => (
          <Workflow name="wait-async-siblings">
            <Parallel>
              <WaitForEvent id="wait" event="deploy.ready" output={outputs.eventOut} async />
              <Task id="side" output={outputs.sideOut}>
                {{ value: 7 }}
              </Task>
            </Parallel>
          </Workflow>
        ));
        const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(first.status).toBe("waiting-event");
        const sideRows = await db.select().from(tables.sideOut);
        expect(sideRows.length).toBe(1);
        expect(sideRows[0].value).toBe(7);
        await Effect.runPromise(
          signalRun(new SmithersDb(db), first.runId, "deploy.ready", { ok: true }, { receivedBy: "tester" }),
        );
        const resumed = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId: first.runId,
            resume: true,
          }),
        );
        expect(resumed.status).toBe("finished");
        const eventRows = await db.select().from(tables.eventOut);
        expect(eventRows.length).toBe(1);
        expect(eventRows[0].ok).toBe(true);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
describe("Timer duration parsing through the real engine", () => {
  test(
    "an unparseable duration string fails the run instead of hanging",
    async () => {
      const { smithers, outputs, cleanup } = buildWaitSmithers();
      try {
        const workflow = smithers(() => (
          <Workflow name="timer-invalid-duration">
            <Timer id="bad-timer" duration="soon" />
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("failed");
        expect(JSON.stringify(result.error)).toContain("soon");
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
