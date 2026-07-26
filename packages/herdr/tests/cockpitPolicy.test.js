import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SOFT_PIN_SLOTS,
  gateTabLabel,
  isLikelyWorkerNodeId,
  isPinnedNodeId,
  resolveAutoOpenPolicy,
  shouldAutoOpenDetailTab,
  updateSoftPinSet,
} from "../src/cockpitPolicy.js";

describe("isLikelyWorkerNodeId", () => {
  test("matches swarm worker patterns", () => {
    expect(isLikelyWorkerNodeId("worker-07")).toBe(true);
    expect(isLikelyWorkerNodeId("worker-1")).toBe(true);
    expect(isLikelyWorkerNodeId("fix-3")).toBe(true);
    expect(isLikelyWorkerNodeId("shard-12")).toBe(true);
    expect(isLikelyWorkerNodeId("swarm/worker-03")).toBe(true);
  });

  test("does not match stage/orchestrator ids or non-numeric fix-* names", () => {
    expect(isLikelyWorkerNodeId("implement")).toBe(false);
    expect(isLikelyWorkerNodeId("impl:implement")).toBe(false);
    expect(isLikelyWorkerNodeId("mission:plan")).toBe(false);
    expect(isLikelyWorkerNodeId("orch:wave")).toBe(false);
    expect(isLikelyWorkerNodeId("merge-queue")).toBe(false);
    expect(isLikelyWorkerNodeId("fix-auth")).toBe(false);
    expect(isLikelyWorkerNodeId("leaf-merge")).toBe(false);
  });
});

describe("isPinnedNodeId", () => {
  test("exact and glob pins", () => {
    expect(isPinnedNodeId("merge-queue", ["merge-queue"])).toBe(true);
    expect(isPinnedNodeId("mission:final", ["*:final"])).toBe(true);
    expect(isPinnedNodeId("worker-01", ["merge-queue"])).toBe(false);
  });
});

describe("shouldAutoOpenDetailTab", () => {
  const defaults = {};

  test("gates and failures always open under defaults", () => {
    expect(shouldAutoOpenDetailTab({ nodeId: "approve-plan", reason: "gate" }, defaults)).toBe(true);
    expect(shouldAutoOpenDetailTab({ nodeId: "worker-01", reason: "failure" }, defaults)).toBe(true);
  });

  test("workers stay board-only unless autoOpen.workers", () => {
    expect(shouldAutoOpenDetailTab({ nodeId: "worker-07", reason: "stage" }, defaults)).toBe(false);
    expect(shouldAutoOpenDetailTab({ nodeId: "worker-07", reason: "stage" }, { autoOpen: { workers: true } })).toBe(
      true,
    );
  });

  test("soft-pin K=1 for non-worker stages", () => {
    expect(shouldAutoOpenDetailTab({ nodeId: "implement", reason: "stage", softPinnedNodeIds: [] }, defaults)).toBe(
      true,
    );
    expect(
      shouldAutoOpenDetailTab({ nodeId: "validate", reason: "stage", softPinnedNodeIds: ["implement"] }, defaults),
    ).toBe(false);
    expect(
      shouldAutoOpenDetailTab({ nodeId: "implement", reason: "stage", softPinnedNodeIds: ["implement"] }, defaults),
    ).toBe(true);
  });

  test("pin bypasses soft-pin and worker calm", () => {
    expect(shouldAutoOpenDetailTab({ nodeId: "worker-07", reason: "stage" }, { pin: ["worker-07"] })).toBe(true);
  });
});

describe("updateSoftPinSet", () => {
  test("tracks start/end within DEFAULT_SOFT_PIN_SLOTS", () => {
    const set = new Set();
    updateSoftPinSet(set, { nodeId: "implement", action: "start" });
    expect([...set]).toEqual(["implement"]);
    expect(DEFAULT_SOFT_PIN_SLOTS).toBe(1);
    updateSoftPinSet(set, { nodeId: "validate", action: "start" });
    // no room
    expect([...set]).toEqual(["implement"]);
    updateSoftPinSet(set, { nodeId: "implement", action: "end" });
    expect([...set]).toEqual([]);
    updateSoftPinSet(set, { nodeId: "validate", action: "start" });
    expect([...set]).toEqual(["validate"]);
  });

  test("workers do not consume soft-pin slots", () => {
    const set = new Set();
    updateSoftPinSet(set, { nodeId: "worker-01", action: "start" });
    expect(set.size).toBe(0);
  });
});

describe("gateTabLabel", () => {
  test("prefixes gate:", () => {
    expect(gateTabLabel("approve-plan")).toBe("gate:approve-plan");
  });
});

describe("resolveAutoOpenPolicy", () => {
  test("defaults stage/gates/failures on, workers off", () => {
    expect(resolveAutoOpenPolicy(undefined)).toEqual({
      stage: true,
      workers: false,
      gates: true,
      failures: true,
    });
  });
});
