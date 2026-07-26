import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { Effect } from "effect";
import { diagnoseRunEffect, diagnosisCtaCommands, renderWhyDiagnosisHuman } from "../src/why-diagnosis.js";

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
// Older than the engine's 30s RUN_HEARTBEAT_STALE_MS window.
const LAGGING_HEARTBEAT = NOW - 60_000;

function runRow(overrides = {}) {
  return {
    runId: "owner-run",
    workflowName: "diagnosis",
    workflowPath: "workflow.tsx",
    status: "running",
    createdAtMs: NOW - 120_000,
    startedAtMs: NOW - 110_000,
    finishedAtMs: null,
    heartbeatAtMs: NOW,
    runtimeOwnerId: null,
    ...overrides,
  };
}

function makeAdapter(run) {
  return {
    getRunEffect: () => Effect.succeed(run),
    listNodesEffect: () => Effect.succeed([]),
    listPendingApprovalsEffect: () => Effect.succeed([]),
    listAllDecidedApprovalsEffect: () => Effect.succeed([]),
    listAttemptsForRunEffect: () => Effect.succeed([]),
    getLastEventSeqEffect: () => Effect.succeed(undefined),
    getLastFrameEffect: () => Effect.succeed(undefined),
    listEventHistoryEffect: () => Effect.succeed([]),
  };
}

function diagnose(run) {
  return Effect.runPromise(diagnoseRunEffect(makeAdapter(run), run.runId, NOW));
}

/** A real dead PID: spawnSync children are exited and reaped on return. */
function deadPid() {
  const dead = spawnSync("true", { stdio: "ignore" });
  expect(typeof dead.pid).toBe("number");
  return dead.pid;
}

describe("why diagnosis — owner liveness before orphaned", () => {
  test("live owner + lagging heartbeat → engine busy, no force-resume recommendation", async () => {
    const diagnosis = await diagnose(
      runRow({
        heartbeatAtMs: LAGGING_HEARTBEAT,
        runtimeOwnerId: `pid:${process.pid}:cli-session`,
      }),
    );

    expect(diagnosis.blockers).toHaveLength(1);
    expect(diagnosis.blockers[0]).toMatchObject({
      kind: "engine-busy",
      nodeId: "(run-level)",
      iteration: null,
      reason: `Engine is busy (owner process ${process.pid} is alive, last heartbeat 1m 0s ago)`,
      unblocker: "smithers logs owner-run",
    });
    expect(diagnosis.blockers[0]?.context).toContain("Do not force-resume a live run");

    const rendered = renderWhyDiagnosisHuman(diagnosis);
    expect(rendered).toContain("Engine is busy");
    expect(rendered).not.toContain("orphaned");
    expect(rendered).not.toContain("--force");

    const commands = diagnosisCtaCommands(diagnosis);
    expect(commands.map((entry) => entry.command)).not.toContainEqual(expect.stringContaining("--force"));
    expect(commands[0]).toEqual({
      command: "logs owner-run",
      description: "Tail busy engine logs",
    });
  });

  test("demonstrably dead owner → orphaned with force-resume recovery guidance", async () => {
    const pid = deadPid();
    const diagnosis = await diagnose(
      runRow({
        heartbeatAtMs: LAGGING_HEARTBEAT,
        runtimeOwnerId: `pid:${pid}:cli-session`,
      }),
    );

    expect(diagnosis.blockers).toHaveLength(1);
    expect(diagnosis.blockers[0]).toMatchObject({
      kind: "stale-heartbeat",
      nodeId: "(run-level)",
      reason: "Run appears orphaned (last heartbeat 1m 0s ago)",
      unblocker: "smithers up workflow.tsx --run-id owner-run --resume true --force true",
      context: `Owner process ${pid} is not running.`,
    });
    expect(renderWhyDiagnosisHuman(diagnosis)).toContain("Run appears orphaned");
  });

  test("no recorded owner → orphaned recovery guidance is preserved", async () => {
    const diagnosis = await diagnose(
      runRow({
        heartbeatAtMs: LAGGING_HEARTBEAT,
        runtimeOwnerId: null,
      }),
    );

    expect(diagnosis.blockers).toHaveLength(1);
    expect(diagnosis.blockers[0]).toMatchObject({
      kind: "stale-heartbeat",
      reason: "Run appears orphaned (last heartbeat 1m 0s ago)",
      unblocker: "smithers up workflow.tsx --run-id owner-run --resume true --force true",
    });
    expect(diagnosis.blockers[0]?.context).toBeUndefined();
  });

  test("heartbeat within the fresh window → no run-level blocker at all", async () => {
    const diagnosis = await diagnose(
      runRow({
        heartbeatAtMs: NOW - 5_000,
        runtimeOwnerId: `pid:${deadPid()}:cli-session`,
      }),
    );

    expect(diagnosis.blockers).toHaveLength(0);
    expect(diagnosis.summary).toContain("Run is executing normally");
  });
});
