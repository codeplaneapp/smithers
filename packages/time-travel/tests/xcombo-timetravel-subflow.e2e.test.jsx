/** @jsxImportSource smithers-orchestrator */
// Cross-feature audit lane: time travel x <Subflow> (child runs).
//
// Every test here drives a REAL parent run that executes a real <Subflow>
// child run against a temp sqlite db (no agents, no network), then probes one
// time-travel entry point. Tests that assert the CORRECT behavior and fail
// today are pinning defects on purpose.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { Subflow, Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { timeTravel } from "../src/timetravel.js";
import { forkRun } from "../src/fork/index.js";
import { buildTimeline, buildTimelineTree } from "../src/timeline/index.js";
import { assessEffectBoundary } from "../src/assessEffectBoundary.js";
import { jumpToFrame } from "../src/jumpToFrame.js";

const END_TO_END_TIMEOUT_MS = 40_000;

/**
 * Build a parent workflow that runs one compute task and then a `<Subflow>`
 * child run. The child's returned value is read from `state` at execution time
 * so a test can change the world between the first run and a rewind+resume.
 *
 * @param {any} smithers
 * @param {any} outputs
 * @param {{ childCalls: number; childValue: number }} state
 */
function buildParentWithSubflow(smithers, outputs, state) {
  const childWorkflow = smithers(
    () => (
      <Workflow name="xcombo-subflow-child">
        <Task id="child-work" output={outputs.outputA}>
          {() => {
            state.childCalls += 1;
            return { value: state.childValue };
          }}
        </Task>
      </Workflow>
    ),
    { output: outputs.outputA },
  );
  const parentWorkflow = smithers(() => (
    <Workflow name="xcombo-subflow-parent">
      <Task id="prepare" output={outputs.outputC}>
        {{ value: 1 }}
      </Task>
      <Subflow id="child-step" output={outputs.outputB} workflow={childWorkflow} dependsOn={["prepare"]} />
    </Workflow>
  ));
  return { childWorkflow, parentWorkflow };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function latestFrameNo(adapter, runId) {
  const frames = await adapter.listFrames(runId, 1_000_000);
  return frames.reduce((max, frame) => Math.max(max, Number(frame.frameNo)), -1);
}

/**
 * @param {any} tree
 * @param {string[]} [acc]
 * @returns {string[]}
 */
function collectTreeRunIds(tree, acc = []) {
  acc.push(tree.timeline.runId);
  for (const child of tree.children) collectTreeRunIds(child, acc);
  return acc;
}

/**
 * A side effect the CHILD run performed (e.g. the child's agent deployed
 * something). Recorded under the child's run id, exactly like the real
 * tool journal does.
 *
 * @param {SmithersDb} adapter
 * @param {string} childRunId
 * @param {number} startedAtMs
 */
function recordChildSideEffect(adapter, childRunId, startedAtMs) {
  return Effect.runPromise(
    adapter.insertToolCall({
      runId: childRunId,
      nodeId: "child-work",
      iteration: 0,
      attempt: 1,
      seq: 1,
      toolName: "deploy-production",
      inputJson: "{}",
      outputJson: "{}",
      startedAtMs,
      finishedAtMs: startedAtMs + 1,
      status: "succeeded",
      errorJson: null,
      kind: "tool",
      sideEffect: true,
      idempotent: false,
      acceptsIdempotencyKey: false,
      hasRevert: false,
      idempotencyKey: null,
      revertStatus: null,
      revertedAtMs: null,
      revertErrorJson: null,
      forcedPastJson: null,
    }),
  );
}

describe("time travel x <Subflow> child runs", () => {
  test(
    "rewinding a parent past its <Subflow> and resuming re-executes the child workflow",
    async () => {
      const { smithers, outputs, tables, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      const state = { childCalls: 0, childValue: 1 };
      try {
        const { parentWorkflow } = buildParentWithSubflow(smithers, outputs, state);
        const first = await Effect.runPromise(
          runWorkflow(parentWorkflow, { input: {}, runId: "xcombo-tt-subflow-redo" }),
        );
        expect(first.status).toBe("finished");
        expect(state.childCalls).toBe(1);
        const childRun = await adapter.getLatestChildRun(first.runId);
        expect(childRun?.status).toBe("finished");
        expect(await db.select().from(tables.outputB)).toEqual([
          expect.objectContaining({ runId: first.runId, nodeId: "child-step", value: 1 }),
        ]);

        // The user says "that step produced the wrong answer, go back and do
        // it again" — the world has changed (childValue is now 2).
        state.childValue = 2;
        const travel = await timeTravel(adapter, {
          runId: first.runId,
          nodeId: "child-step",
          restoreVcs: false,
        });
        expect(travel.success).toBe(true);
        expect(travel.resetNodes).toContain("child-step");
        const resumed = await Effect.runPromise(
          runWorkflow(parentWorkflow, { input: {}, runId: first.runId, resume: true }),
        );
        expect(resumed.status).toBe("finished");

        // Correct behavior: the rewound <Subflow> re-executes its child run,
        // so the parent's output reflects the redo instead of the old answer.
        expect(await db.select().from(tables.outputB)).toEqual([
          expect.objectContaining({ runId: first.runId, nodeId: "child-step", value: 2 }),
        ]);
        expect(state.childCalls).toBe(2);
        const childRunAfter = await adapter.getRun(String(childRun?.runId));
        expect(childRunAfter?.startedAtMs).toBeGreaterThan(Number(childRun?.startedAtMs ?? 0));
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "the parent's time-travel effect boundary sees side effects its child run performed",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      const state = { childCalls: 0, childValue: 1 };
      try {
        const { parentWorkflow } = buildParentWithSubflow(smithers, outputs, state);
        const first = await Effect.runPromise(
          runWorkflow(parentWorkflow, { input: {}, runId: "xcombo-tt-subflow-effects" }),
        );
        expect(first.status).toBe("finished");
        const childRun = await adapter.getLatestChildRun(first.runId);
        expect(childRun?.runId).toBeTruthy();
        const subflowAttempt = (await adapter.listAttempts(first.runId, "child-step", 0))[0];
        expect(subflowAttempt).toBeDefined();
        await recordChildSideEffect(adapter, String(childRun?.runId), subflowAttempt.startedAtMs + 1);

        // Rewinding the parent to before the <Subflow> discards the child's
        // work, so the child's non-revertible external effect is crossed.
        const report = await assessEffectBoundary(adapter, {
          runId: first.runId,
          cutoffMs: subflowAttempt.startedAtMs,
        });
        const crossed = [...report.blocking, ...report.revertible, ...report.warnings].map((effect) => effect.toolName);
        expect(crossed).toContain("deploy-production");
        expect(report.blocking.map((effect) => effect.toolName)).toContain("deploy-production");
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "the parent's timeline includes its <Subflow> child run",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      const state = { childCalls: 0, childValue: 1 };
      try {
        const { parentWorkflow } = buildParentWithSubflow(smithers, outputs, state);
        const first = await Effect.runPromise(
          runWorkflow(parentWorkflow, { input: {}, runId: "xcombo-tt-subflow-timeline" }),
        );
        expect(first.status).toBe("finished");
        const childRun = await adapter.getLatestChildRun(first.runId);
        const childRunId = String(childRun?.runId);

        // The child run really does have its own recorded history...
        const childTimeline = await buildTimeline(adapter, childRunId);
        expect(childTimeline.frames.length).toBeGreaterThan(0);

        // ...so `get_timeline --tree` on the parent must be able to reach it.
        const tree = await buildTimelineTree(adapter, first.runId);
        expect(collectTreeRunIds(tree)).toContain(childRunId);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "forking a parent that ran a <Subflow> does not disguise the fork as a subflow child run",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      const state = { childCalls: 0, childValue: 1 };
      try {
        const { parentWorkflow } = buildParentWithSubflow(smithers, outputs, state);
        const first = await Effect.runPromise(
          runWorkflow(parentWorkflow, { input: {}, runId: "xcombo-tt-subflow-fork" }),
        );
        expect(first.status).toBe("finished");
        const childRun = await adapter.getLatestChildRun(first.runId);
        const childRunId = String(childRun?.runId);

        const fork = await forkRun(adapter, {
          parentRunId: first.runId,
          frameNo: await latestFrameNo(adapter, first.runId),
          branchLabel: "xcombo-fork",
        });

        // A fork is a BRANCH of the parent, not a workflow the parent spawned.
        // Reusing `_smithers_runs.parent_run_id` for both makes every
        // child-run consumer (getLatestChildRun, listRunDescendants, the run
        // tree UIs) mistake the fork for the subflow's child run.
        const latestChild = await adapter.getLatestChildRun(first.runId);
        expect(latestChild?.runId).toBe(childRunId);
        const descendants = await adapter.listRunDescendants(first.runId);
        expect(descendants.map((row) => row.runId)).not.toContain(fork.runId);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "time travel entry points work on a <Subflow> child run id",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      const state = { childCalls: 0, childValue: 1 };
      try {
        const { parentWorkflow } = buildParentWithSubflow(smithers, outputs, state);
        const first = await Effect.runPromise(
          runWorkflow(parentWorkflow, { input: {}, runId: "xcombo-tt-subflow-childid" }),
        );
        expect(first.status).toBe("finished");
        const childRun = await adapter.getLatestChildRun(first.runId);
        const childRunId = String(childRun?.runId);

        // timeTravel (the `time_travel` MCP tool) accepts the child run id.
        const travel = await timeTravel(adapter, {
          runId: childRunId,
          nodeId: "child-work",
          restoreVcs: false,
        });
        expect(travel.success).toBe(true);

        // rewind (the `rewind_run` MCP tool / `smithers rewind`) must too:
        // the engine mints child run ids containing ':' and the rewind run-id
        // validator rejects every one of them.
        const frameNo = await latestFrameNo(adapter, childRunId);
        expect(frameNo).toBeGreaterThanOrEqual(0);
        const rewind = await jumpToFrame({
          adapter,
          runId: childRunId,
          frameNo,
          confirm: true,
          caller: "user:xcombo",
        });
        expect(rewind.ok).toBe(true);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
