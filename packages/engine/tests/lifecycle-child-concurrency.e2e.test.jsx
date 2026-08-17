/** @jsxImportSource smthrs */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { Parallel, Sequence, SmithersDb, Subflow, Task, Workflow, runWorkflow } from "smthrs";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";

const TIMEOUT_MS = 45_000;
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeFixture() {
  const fixture = createTestSmithers({
    work: z.object({ value: z.number() }),
    subflow: z.object({ value: z.number() }),
    done: z.object({ value: z.number() }),
  });
  const rootDir = mkdtempSync(join(tmpdir(), "smithers-lifecycle-concurrency-"));
  roots.push(rootDir);
  return { ...fixture, rootDir };
}

function leafWorkflow(fixture, name, width = 4) {
  return fixture.smithers(
    () => (
      <Workflow name={name}>
        <Sequence>
          <Parallel>
            {Array.from({ length: width }, (_, index) => (
              <Task key={index} id={`leaf-${name}-${index}`} output={fixture.outputs.work}>
                {async () => {
                  await sleep(120);
                  return { value: index };
                }}
              </Task>
            ))}
          </Parallel>
          <Task id={`finish-${name}`} output={fixture.outputs.subflow}>
            {{ value: width }}
          </Task>
        </Sequence>
      </Workflow>
    ),
    { output: fixture.outputs.subflow },
  );
}

async function observeInProgressLeaves(adapter, rootRunId, runPromise) {
  let peak = 0;
  let settled = false;
  const observed = [];
  void runPromise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    const lineage = await adapter.listRunDescendants(rootRunId);
    const attempts = (await Promise.all(lineage.map((row) => adapter.listInProgressAttempts(row.runId)))).flat();
    const activeLeaves = attempts.filter((attempt) => attempt.nodeId.startsWith("leaf-"));
    peak = Math.max(peak, activeLeaves.length);
    observed.push(activeLeaves.map((attempt) => `${attempt.runId}/${attempt.nodeId}`));
    await sleep(10);
  }
  return { peak, observed };
}

describe("lifecycle child concurrency admission", () => {
  test(
    "subtreeConcurrency bounds observed in-progress descendant tasks across sibling child runs",
    async () => {
      const fixture = makeFixture();
      try {
        const child = leafWorkflow(fixture, "bounded-child");
        const runId = "lifecycle-subtree-bound";
        const parent = fixture.smithers(() => (
          <Workflow name="lifecycle-subtree-bound">
            <Parallel id="lanes" subtreeConcurrency={2}>
              {Array.from({ length: 4 }, (_, index) => (
                <Subflow key={index} id={`child-${index}`} workflow={child} output={fixture.outputs.done} retries={0} />
              ))}
            </Parallel>
          </Workflow>
        ));
        const adapter = new SmithersDb(fixture.db);
        const runPromise = Effect.runPromise(runWorkflow(parent, { input: {}, runId, rootDir: fixture.rootDir }));
        const observationPromise = observeInProgressLeaves(adapter, runId, runPromise);
        const [result, observation] = await Promise.all([runPromise, observationPromise]);

        expect(result.status).toBe("finished");
        expect(observation.peak).toBe(2);
        expect(observation.observed.some((sample) => sample.length === 2)).toBe(true);
        const saturation = await adapter.listEventsByType(runId, "RunConcurrencySaturated");
        expect(saturation.map((row) => JSON.parse(row.payloadJson))).toContainEqual(
          expect.objectContaining({
            budget: "subtree",
            subtreeGroupId: "lanes",
            effectiveCap: 2,
            descendantRunId: expect.stringContaining(":child:"),
          }),
        );
        const childRow = await adapter.getLatestChildRun(runId);
        expect(JSON.parse(childRow?.configJson ?? "{}").subflowWorkspaceParentRunId).toBe(runId);
      } finally {
        fixture.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "the inherited cap holds through parent, child, and grandchild depth",
    async () => {
      const fixture = makeFixture();
      try {
        const grandchild = leafWorkflow(fixture, "grandchild", 3);
        const child = fixture.smithers(
          () => (
            <Workflow name="nested-child">
              <Sequence>
                <Parallel>
                  {Array.from({ length: 3 }, (_, index) => (
                    <Subflow
                      key={index}
                      id={`grand-${index}`}
                      workflow={grandchild}
                      output={fixture.outputs.subflow}
                      retries={0}
                    />
                  ))}
                </Parallel>
                <Task id="finish-child" output={fixture.outputs.done}>
                  {{ value: 1 }}
                </Task>
              </Sequence>
            </Workflow>
          ),
          { output: fixture.outputs.done },
        );
        const runId = "lifecycle-nested-bound";
        const parent = fixture.smithers(() => (
          <Workflow name="lifecycle-nested-bound">
            <Parallel id="roots" subtreeConcurrency={2}>
              <Subflow id="child-a" workflow={child} output={fixture.outputs.done} retries={0} />
              <Subflow id="child-b" workflow={child} output={fixture.outputs.done} retries={0} />
            </Parallel>
          </Workflow>
        ));
        const adapter = new SmithersDb(fixture.db);
        const runPromise = Effect.runPromise(runWorkflow(parent, { input: {}, runId, rootDir: fixture.rootDir }));
        const observationPromise = observeInProgressLeaves(adapter, runId, runPromise);
        const [result, observation] = await Promise.all([runPromise, observationPromise]);

        expect(result.status).toBe("finished");
        expect(observation.peak).toBe(2);
        const lineage = await adapter.listRunDescendants(runId);
        expect(Math.max(...lineage.map((row) => row.depth))).toBe(2);
      } finally {
        fixture.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a parent task awaiting its child yields the only run slot and completes",
    async () => {
      const fixture = makeFixture();
      try {
        const child = leafWorkflow(fixture, "single-slot-child", 2);
        const parent = fixture.smithers(() => (
          <Workflow name="single-slot-parent">
            <Subflow id="await-child" workflow={child} output={fixture.outputs.done} retries={0} />
          </Workflow>
        ));
        const runId = "lifecycle-single-slot";
        const adapter = new SmithersDb(fixture.db);
        const runPromise = Effect.runPromise(
          runWorkflow(parent, {
            input: {},
            runId,
            maxConcurrency: 1,
            rootDir: fixture.rootDir,
          }),
        );
        const observationPromise = observeInProgressLeaves(adapter, runId, runPromise);
        const [result, observation] = await Promise.all([runPromise, observationPromise]);
        expect(result.status).toBe("finished");
        expect(observation.peak).toBe(1);
        const events = await adapter.listEventsByType(runId, "RunConcurrencySaturated");
        expect(events.map((row) => JSON.parse(row.payloadJson))).toContainEqual(
          expect.objectContaining({
            budget: "run",
            effectiveCap: 1,
            descendantRunId: "lifecycle-single-slot:child:await-child:0",
          }),
        );
      } finally {
        fixture.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a detached run with parentRunId lineage does not inherit the parent budget",
    async () => {
      const fixture = makeFixture();
      try {
        const detached = leafWorkflow(fixture, "detached", 3);
        const runId = "detached-lineage-parent";
        const parent = fixture.smithers(() => (
          <Workflow name="detached-lineage-parent">
            <Task id="launch-detached" output={fixture.outputs.done}>
              {async () => {
                const result = await Effect.runPromise(
                  runWorkflow(detached, {
                    input: {},
                    runId: "detached-lineage-child",
                    parentRunId: runId,
                    maxConcurrency: 3,
                    rootDir: fixture.rootDir,
                  }),
                );
                return { value: result.status === "finished" ? 1 : 0 };
              }}
            </Task>
          </Workflow>
        ));
        const adapter = new SmithersDb(fixture.db);
        const runPromise = Effect.runPromise(
          runWorkflow(parent, { input: {}, runId, maxConcurrency: 1, rootDir: fixture.rootDir }),
        );
        const observationPromise = observeInProgressLeaves(adapter, runId, runPromise);
        const [result, observation] = await Promise.all([runPromise, observationPromise]);

        expect(result.status).toBe("finished");
        expect(observation.peak).toBe(3);
        const detachedRow = await adapter.getRun("detached-lineage-child");
        expect(detachedRow?.parentRunId).toBe(runId);
        expect(JSON.parse(detachedRow?.configJson ?? "{}").subflowWorkspaceParentRunId).toBeUndefined();
      } finally {
        fixture.cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
