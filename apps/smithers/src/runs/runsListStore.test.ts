import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { registerHappyDomForTests } from "../test/registerHappyDom";
import { useRunsListStore } from "./runsListStore";
import { SEEDED_RUNS } from "./runsList";

// approve/deny/resume echo through notificationsStore.notify, which schedules a
// window.setTimeout for transient toasts. Use the shared helper so happy-dom is
// installed for that timer host WITHOUT clobbering Bun's native fetch/Request —
// other unit tests in the same process rely on real loopback fetch, and a raw
// GlobalRegistrator.register() here would make the suite order-dependent.
beforeAll(() => {
  registerHappyDomForTests();
});

/**
 * Store-level guarantees for the runs LIST store. Domain-level filter/group
 * reducers live in runsListDomain.test.ts; this file pins the *mutation* paths
 * (approve / deny / resume / rerun) and the stale-update prevention they bake
 * in: a no-op when the run id is unknown, a no-op when the state guard doesn't
 * match (e.g. approving a non-waiting run), and idempotent filter setters.
 */
function reset() {
  useRunsListStore.setState({
    runs: SEEDED_RUNS,
    statusFilter: "all",
    workflowFilter: "all",
    ageFilter: "all",
    search: "",
    streamMode: "live",
    selectedRunId: null,
  });
}

beforeEach(reset);

// approve/deny/resume each guard on a specific run status; pull a seeded run of
// that status and fail loudly (not with an opaque `undefined`) if the fixture
// ever stops shipping one.
function seededWithStatus(status: (typeof SEEDED_RUNS)[number]["status"]) {
  const run = SEEDED_RUNS.find((r) => r.status === status);
  if (!run) {
    throw new Error(`runsListStore.test expected a seeded run with status "${status}"`);
  }
  return run;
}

describe("runsListStore — stale-update prevention", () => {
  test("approve(unknown) is a no-op (no thrown error, no state change)", () => {
    const before = useRunsListStore.getState().runs;
    useRunsListStore.getState().approve("not-a-real-run");
    expect(useRunsListStore.getState().runs).toBe(before);
  });

  test("approve only fires on a waiting run; other statuses are ignored", () => {
    const running = seededWithStatus("running");
    useRunsListStore.getState().approve(running.runId);
    const after = useRunsListStore.getState().runs.find((r) => r.runId === running.runId)!;
    expect(after.status).toBe("running");
  });

  test("approve flips a waiting run to running in place", () => {
    const waiting = seededWithStatus("waiting");
    useRunsListStore.getState().approve(waiting.runId);
    const after = useRunsListStore.getState().runs.find((r) => r.runId === waiting.runId)!;
    expect(after.status).toBe("running");
    expect(after.blockedNodeLabel).toBeUndefined();
  });

  test("deny only fires on a waiting run; running stays running", () => {
    const running = seededWithStatus("running");
    useRunsListStore.getState().deny(running.runId);
    const after = useRunsListStore.getState().runs.find((r) => r.runId === running.runId)!;
    expect(after.status).toBe("running");
  });

  test("resume only fires on a failed/cancelled run", () => {
    const ok = seededWithStatus("finished");
    useRunsListStore.getState().resume(ok.runId);
    const after = useRunsListStore.getState().runs.find((r) => r.runId === ok.runId)!;
    expect(after.status).toBe("finished");
  });

  test("resume restarts a cancelled run", () => {
    const cancelled = seededWithStatus("cancelled");
    useRunsListStore.getState().resume(cancelled.runId);
    const after = useRunsListStore.getState().runs.find((r) => r.runId === cancelled.runId)!;
    expect(after.status).toBe("running");
    expect(after.errorText).toBeUndefined();
  });
});

describe("runsListStore — filters", () => {
  test("clearFilters resets every header filter back to its default", () => {
    const store = useRunsListStore.getState();
    store.setStatusFilter("failed");
    store.setWorkflowFilter("Implement · auth refactor");
    store.setAgeFilter("week");
    store.setSearch("auth");
    useRunsListStore.getState().clearFilters();
    const s = useRunsListStore.getState();
    expect(s.statusFilter).toBe("all");
    expect(s.workflowFilter).toBe("all");
    expect(s.ageFilter).toBe("all");
    expect(s.search).toBe("");
  });

  test("setSearch with the same value is idempotent (no extra renders)", () => {
    const ref = useRunsListStore.getState().runs;
    useRunsListStore.getState().setSearch("");
    expect(useRunsListStore.getState().runs).toBe(ref);
  });
});
