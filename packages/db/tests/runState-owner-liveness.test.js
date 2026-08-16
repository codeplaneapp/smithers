import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { deriveRunState } from "../src/runState/deriveRunState.js";
import { RUN_STATE_HEARTBEAT_STALE_MS } from "../src/runState/RUN_STATE_HEARTBEAT_STALE_MS.js";
import {
  formatRuntimeOwnerId,
  isPidAlive,
  parseRuntimeOwnerIdentity,
  parseRuntimeOwnerPid,
} from "../src/runtime-owner.js";

const NOW = 1_700_000_000_000;
const STALE = NOW - (RUN_STATE_HEARTBEAT_STALE_MS + 5_000);

/**
 * @param {Partial<import("../src/adapter/RunRow.ts").RunRow>} overrides
 * @returns {import("../src/adapter/RunRow.ts").RunRow}
 */
function makeRun(overrides = {}) {
  return {
    runId: "run-owner",
    parentRunId: null,
    workflowName: "wf",
    workflowPath: null,
    workflowHash: null,
    status: "running",
    createdAtMs: NOW - 60_000,
    startedAtMs: NOW - 60_000,
    finishedAtMs: null,
    heartbeatAtMs: STALE,
    runtimeOwnerId: null,
    cancelRequestedAtMs: null,
    hijackRequestedAtMs: null,
    hijackTarget: null,
    vcsType: null,
    vcsRoot: null,
    vcsRevision: null,
    errorJson: null,
    configJson: null,
    ...overrides,
  };
}

/** A real dead PID: spawnSync children are exited and reaped on return. */
function deadPid() {
  const dead = spawnSync("true", { stdio: "ignore" });
  expect(typeof dead.pid).toBe("number");
  return dead.pid;
}

describe("deriveRunState — owner PID verification before orphaned", () => {
  test("stale heartbeat + live owner PID → stale (busy engine), never orphaned", () => {
    const view = deriveRunState({
      run: makeRun({ runtimeOwnerId: formatRuntimeOwnerId(process.pid, hostname(), "session") }),
      now: NOW,
    });
    expect(view.state).toBe("stale");
    expect(view.unhealthy).toEqual({
      kind: "engine-heartbeat-stale",
      lastHeartbeatAt: new Date(STALE).toISOString(),
    });
  });

  test("stale heartbeat + demonstrably dead owner PID → orphaned", () => {
    const view = deriveRunState({
      run: makeRun({ runtimeOwnerId: formatRuntimeOwnerId(deadPid(), hostname(), "session") }),
      now: NOW,
    });
    expect(view.state).toBe("orphaned");
    expect(view.unhealthy?.kind).toBe("engine-heartbeat-stale");
  });

  test("stale heartbeat + owner without a verifiable PID → stale (unproven, not orphaned)", () => {
    const view = deriveRunState({
      run: makeRun({ runtimeOwnerId: "host:1234" }),
      now: NOW,
    });
    expect(view.state).toBe("stale");
  });

  test("stale remote owner falls back to heartbeat instead of probing the same local PID", () => {
    const view = deriveRunState({
      run: makeRun({ runtimeOwnerId: formatRuntimeOwnerId(process.pid, `${hostname()}.remote`, "session") }),
      now: NOW,
      isOwnerPidAlive: () => {
        throw new Error("a remote PID must not be probed locally");
      },
    });
    expect(view.state).toBe("orphaned");
    expect(view.unhealthy?.kind).toBe("engine-heartbeat-stale");
  });

  test("stale heartbeat + no recorded owner → orphaned (recovery guidance preserved)", () => {
    const view = deriveRunState({
      run: makeRun({ runtimeOwnerId: null }),
      now: NOW,
    });
    expect(view.state).toBe("orphaned");
  });

  test("cancel requested + demonstrably dead owner → cancel-pending, not orphaned (#1496)", () => {
    const view = deriveRunState({
      run: makeRun({
        runtimeOwnerId: `pid:${deadPid()}:session`,
        cancelRequestedAtMs: NOW - 10_000,
      }),
      now: NOW,
    });
    expect(view.state).toBe("cancel-pending");
    expect(view.unhealthy?.kind).toBe("engine-heartbeat-stale");
  });

  test("cancel requested + live owner remains stale while it can still finalize", () => {
    const view = deriveRunState({
      run: makeRun({
        runtimeOwnerId: `pid:${process.pid}:session`,
        cancelRequestedAtMs: NOW - 10_000,
      }),
      now: NOW,
    });
    expect(view.state).toBe("stale");
  });

  test("heartbeat lagging but within threshold → running regardless of owner liveness", () => {
    const view = deriveRunState({
      run: makeRun({
        heartbeatAtMs: NOW - (RUN_STATE_HEARTBEAT_STALE_MS - 1_000),
        runtimeOwnerId: `pid:${deadPid()}:session`,
      }),
      now: NOW,
    });
    expect(view.state).toBe("running");
    expect(view.unhealthy).toBeUndefined();
  });

  test("injected isOwnerPidAlive probe decides stale vs orphaned for remote callers", () => {
    const asAlive = deriveRunState({
      run: makeRun({ runtimeOwnerId: "pid:99999:remote" }),
      now: NOW,
      isOwnerPidAlive: () => true,
    });
    expect(asAlive.state).toBe("stale");

    const asDead = deriveRunState({
      run: makeRun({ runtimeOwnerId: "pid:99999:remote" }),
      now: NOW,
      isOwnerPidAlive: () => false,
    });
    expect(asDead.state).toBe("orphaned");
  });
});

describe("runtimeOwnerLiveness helpers", () => {
  test("host-scoped ids parse only on their owning host while legacy ids remain local", () => {
    expect(parseRuntimeOwnerPid(null)).toBeNull();
    expect(parseRuntimeOwnerPid("   ")).toBeNull();
    expect(parseRuntimeOwnerPid("pid:1234")).toBe(1234);
    expect(parseRuntimeOwnerPid("PID:77:host-a")).toBe(77);
    expect(parseRuntimeOwnerPid("4321")).toBe(4321);
    expect(formatRuntimeOwnerId(77, "HOST-A.", "session")).toBe("pid:77@host-a:session");
    expect(parseRuntimeOwnerPid("pid:77@host-a:session", "HOST-A")).toBe(77);
    expect(parseRuntimeOwnerPid("pid:77@host-a:session", "host-b")).toBeNull();
    expect(parseRuntimeOwnerIdentity("pid:77@host-a:session", "host-b")).toEqual({
      pid: 77,
      hostname: "host-a",
      isLocal: false,
    });
    expect(parseRuntimeOwnerPid("host:1234")).toBeNull();
    expect(parseRuntimeOwnerPid("pid:0")).toBeNull();
    expect(parseRuntimeOwnerPid("pid:77@%zz:session", "host-a")).toBeNull();
  });

  test("isPidAlive is true for this process and false for a reaped child", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(deadPid())).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
});
