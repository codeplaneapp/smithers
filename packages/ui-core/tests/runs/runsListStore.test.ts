import { beforeEach, describe, expect, test } from "bun:test";
import {
  captureRunsIdentityEpoch,
  resetRunsForIdentityChange,
  setRunsListRows,
  setRunsListUnavailable,
  updateDelegatedRunStatus,
  updateRunCompletion,
  upsertDelegatedRun,
  useRunsListStore,
} from "../../src/runs/runsListStore.ts";
import type { RunSummary } from "../../src/runs/runsList.ts";

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: overrides.runId ?? "r1",
    runId: overrides.runId ?? "run-1",
    workflowName: "deploy-flow",
    model: "opus",
    status: "running",
    totalNodes: 4,
    doneNodes: 1,
    failedNodes: 0,
    progress: 0.25,
    elapsedLabel: "1m00s",
    ageBucket: "today",
    ...overrides,
  };
}

// The store is a module-level zustand singleton; reset it (and bump the
// identity epoch) before every test so tests can't see each other's rows.
beforeEach(() => {
  resetRunsForIdentityChange();
});

describe("setRunsListRows", () => {
  test("hydrates the roster and flips rosterHydrated", () => {
    expect(useRunsListStore.getState().rosterHydrated).toBe(false);
    setRunsListRows([run({ runId: "a" }), run({ runId: "b" })]);
    const state = useRunsListStore.getState();
    expect(state.rosterHydrated).toBe(true);
    expect(state.runs.map((r) => r.runId)).toEqual(["a", "b"]);
  });

  test("an empty push still hydrates (an honest zero, not 'unknown')", () => {
    setRunsListRows([]);
    expect(useRunsListStore.getState().rosterHydrated).toBe(true);
    expect(useRunsListStore.getState().runs).toEqual([]);
  });

  test("a stale epoch's push is ignored", () => {
    const staleEpoch = captureRunsIdentityEpoch();
    resetRunsForIdentityChange(); // advances the epoch past staleEpoch
    setRunsListRows([run({ runId: "late" })], staleEpoch);
    expect(useRunsListStore.getState().rosterHydrated).toBe(false);
    expect(useRunsListStore.getState().runs).toEqual([]);
  });
});

describe("delegated ∪ backend merge", () => {
  test("a delegated row not yet in the backend roster stays visible, newest first", () => {
    upsertDelegatedRun(run({ runId: "launched-now" }));
    setRunsListRows([run({ runId: "older-backend-row" })]);
    const runs = useRunsListStore.getState().runs.map((r) => r.runId);
    expect(runs).toEqual(["launched-now", "older-backend-row"]);
  });

  test("once the backend reports the same runId, the backend row wins (no double)", () => {
    upsertDelegatedRun(run({ runId: "shared", status: "running" }));
    setRunsListRows([run({ runId: "shared", status: "finished" })]);
    const rows = useRunsListStore.getState().runs;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("finished");
  });

  test("the backend row inherits delegated-only metadata it doesn't itself carry", () => {
    upsertDelegatedRun(run({ runId: "shared", sourceBookmark: "feature/x" }));
    setRunsListRows([run({ runId: "shared" })]);
    expect(useRunsListStore.getState().runs[0]?.sourceBookmark).toBe("feature/x");
  });

  test("upsertDelegatedRun replaces an existing delegated row with the same runId in place", () => {
    upsertDelegatedRun(run({ runId: "a", status: "running" }));
    upsertDelegatedRun(run({ runId: "a", status: "finished" }));
    expect(useRunsListStore.getState().delegatedRuns).toHaveLength(1);
    expect(useRunsListStore.getState().delegatedRuns[0]?.status).toBe("finished");
  });
});

describe("updateDelegatedRunStatus", () => {
  test("updates a known delegated run's status", () => {
    upsertDelegatedRun(run({ runId: "a", status: "running" }));
    updateDelegatedRunStatus("a", "finished");
    expect(useRunsListStore.getState().runs.find((r) => r.runId === "a")?.status).toBe("finished");
  });

  test("an unknown runId is a no-op, not an invented row", () => {
    updateDelegatedRunStatus("never-launched", "finished");
    expect(useRunsListStore.getState().delegatedRuns).toEqual([]);
  });
});

describe("updateRunCompletion", () => {
  test("attaches the verdict to a matching backend row", () => {
    setRunsListRows([run({ runId: "a" })]);
    updateRunCompletion("a", { state: "passed", paragraph: "all green" });
    expect(useRunsListStore.getState().runs[0]?.completion).toEqual({ state: "passed", paragraph: "all green" });
  });
});

describe("setRunsListUnavailable", () => {
  test("clears the backend roster and un-hydrates without touching delegated rows", () => {
    upsertDelegatedRun(run({ runId: "mine" }));
    setRunsListRows([run({ runId: "backend-a" })]);
    setRunsListUnavailable();
    const state = useRunsListStore.getState();
    expect(state.rosterHydrated).toBe(false);
    expect(state.runs.map((r) => r.runId)).toEqual(["mine"]);
  });
});

describe("filters", () => {
  test("setStatusFilter/setSearch mutate independently of the roster", () => {
    useRunsListStore.getState().setStatusFilter("failed");
    useRunsListStore.getState().setSearch("deploy");
    const state = useRunsListStore.getState();
    expect(state.statusFilter).toBe("failed");
    expect(state.search).toBe("deploy");
  });

  test("clearFilters resets every filter field to its default", () => {
    useRunsListStore.getState().setStatusFilter("failed");
    useRunsListStore.getState().setWorkflowFilter("deploy-flow");
    useRunsListStore.getState().setAgeFilter("week");
    useRunsListStore.getState().setSearch("x");
    useRunsListStore.getState().clearFilters();
    const state = useRunsListStore.getState();
    expect(state.statusFilter).toBe("all");
    expect(state.workflowFilter).toBe("all");
    expect(state.ageFilter).toBe("all");
    expect(state.search).toBe("");
  });
});
