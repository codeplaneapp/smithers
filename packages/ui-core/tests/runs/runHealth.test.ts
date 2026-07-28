import { describe, expect, test } from "bun:test";
import { runHealth, snapshotHealthState } from "../../src/runs/runHealth.ts";

describe("snapshotHealthState — reads runState.state from the real gateway payload", () => {
  test.each(["stale", "orphaned", "recovering"] as const)("surfaces the engine health state %s", (state) => {
    expect(snapshotHealthState({ runState: { state } })).toBe(state);
  });

  test("a normal lifecycle state is not a health divergence", () => {
    expect(snapshotHealthState({ runState: { state: "running" } })).toBeUndefined();
  });

  test("missing runState is unknown, not green", () => {
    expect(snapshotHealthState({})).toBeUndefined();
    expect(snapshotHealthState(null)).toBeUndefined();
    expect(snapshotHealthState(undefined)).toBeUndefined();
  });
});

describe("runHealth — divergence, tone, and resume affordance", () => {
  test("no gateway health payload → no health UI (unknown, not green)", () => {
    expect(runHealth(undefined, "running")).toBeNull();
  });

  test("a non-health lifecycle value never raises a banner", () => {
    expect(runHealth("running", "running")).toBeNull();
    expect(runHealth("ok", "running")).toBeNull();
  });

  test("a matching (non-diverging) health state raises no banner", () => {
    expect(runHealth("stale", "stale")).toBeNull();
  });

  test("stale diverging → failed-tone banner WITH a one-click resume", () => {
    const health = runHealth("stale", "running");
    expect(health).not.toBeNull();
    expect(health?.state).toBe("stale");
    expect(health?.tone).toBe("tone-failed");
    expect(health?.canResume).toBe(true);
    expect(health?.headline).toBeTruthy();
  });

  test("orphaned diverging → failed-tone banner WITH a one-click resume", () => {
    const health = runHealth("orphaned", "running");
    expect(health?.state).toBe("orphaned");
    expect(health?.tone).toBe("tone-failed");
    expect(health?.canResume).toBe(true);
  });

  test("recovering diverging → banner but NO resume claim (engine is re-attaching)", () => {
    const health = runHealth("recovering", "running");
    expect(health?.state).toBe("recovering");
    expect(health?.tone).toBe("tone-waiting");
    expect(health?.canResume).toBe(false);
  });
});
