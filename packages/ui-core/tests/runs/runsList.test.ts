import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FILTERS,
  distinctWorkflows,
  filterRuns,
  groupRuns,
  hasActiveFilters,
  isQueuedRawStatus,
  isTerminal,
  matchesAge,
  matchesRepo,
  matchesSearch,
  runDisplayName,
  runListStatusFromRaw,
  runsEmbedTop,
  runStatusLabel,
  runStatusTone,
  runStatusToNode,
  shortHash,
  shortRunId,
  shouldShowProgress,
  summarizeRuns,
  type RunFilters,
  type RunSummary,
} from "../../src/runs/runsList.ts";
import { statusLabel, statusTone } from "../../src/runs/statusMeta.ts";

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: overrides.id ?? overrides.runId ?? "r1",
    runId: overrides.runId ?? "run-00000001",
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

describe("shortHash / shortRunId", () => {
  test("shortHash is deterministic and an 8-char hex string", () => {
    const a = shortHash("deploy-flow");
    const b = shortHash("deploy-flow");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  test("shortRunId takes the first 8 characters", () => {
    expect(shortRunId("run-0123456789")).toBe("run-0123");
  });
});

describe("runListStatusFromRaw", () => {
  test("collapses queued/pending onto running so queue depth stays visible", () => {
    expect(runListStatusFromRaw("queued")).toBe("running");
    expect(runListStatusFromRaw("pending")).toBe("running");
    expect(runListStatusFromRaw("running")).toBe("running");
    expect(runListStatusFromRaw("resumed")).toBe("running");
  });

  test("maps terminal/waiting vocabularies onto list statuses", () => {
    expect(runListStatusFromRaw("succeeded")).toBe("finished");
    expect(runListStatusFromRaw("completed")).toBe("finished");
    expect(runListStatusFromRaw("continued")).toBe("finished");
    expect(runListStatusFromRaw("failed")).toBe("failed");
    expect(runListStatusFromRaw("errored")).toBe("failed");
    expect(runListStatusFromRaw("cancelled")).toBe("cancelled");
    expect(runListStatusFromRaw("canceled")).toBe("cancelled");
    expect(runListStatusFromRaw("waiting-approval")).toBe("waiting");
    expect(runListStatusFromRaw("waiting-quota")).toBe("waiting");
    expect(runListStatusFromRaw("waiting-new-compatible-state")).toBe("waiting");
    expect(runListStatusFromRaw("paused")).toBe("waiting");
    expect(runListStatusFromRaw("blocked")).toBe("waiting");
  });

  test("an unknown status remains neutral instead of being counted as active", () => {
    expect(runListStatusFromRaw("some-new-backend-status")).toBe("unknown");
    expect(runListStatusFromRaw(undefined)).toBe("unknown");
  });
});

describe("isQueuedRawStatus", () => {
  test("only queued/pending are queued", () => {
    expect(isQueuedRawStatus("queued")).toBe(true);
    expect(isQueuedRawStatus("pending")).toBe(true);
    expect(isQueuedRawStatus("running")).toBe(false);
    expect(isQueuedRawStatus(undefined)).toBe(false);
  });
});

describe("runStatusToNode / runStatusTone / runStatusLabel", () => {
  test("each list status maps to a distinct NodeStatus", () => {
    expect(runStatusToNode("running")).toBe("running");
    expect(runStatusToNode("waiting")).toBe("waiting");
    expect(runStatusToNode("finished")).toBe("ok");
    expect(runStatusToNode("failed")).toBe("failed");
    expect(runStatusToNode("cancelled")).toBe("cancelled");
    expect(runStatusToNode("unknown")).toBe("unknown");
  });

  test("cancelled tones as idle, not failed", () => {
    expect(runStatusTone("cancelled")).toBe("idle");
    expect(runStatusTone("failed")).toBe("failed");
  });

  test("a cancelled run is terminal, not queued (not started)", () => {
    const node = runStatusToNode("cancelled");
    expect(node).not.toBe("queued");
    expect(statusTone(node)).toBe("idle");
    expect(statusLabel(node)).toBe("cancelled");
  });

  test("an unknown run status reads neutral, not queued", () => {
    const node = runStatusToNode("unknown");
    expect(node).not.toBe("queued");
    expect(statusTone(node)).toBe("idle");
    expect(statusLabel(node)).toBe("unknown");
  });

  test("labels are the lowercase status word", () => {
    expect(runStatusLabel("running")).toBe("running");
    expect(runStatusLabel("cancelled")).toBe("cancelled");
  });
});

describe("shouldShowProgress", () => {
  test("only active runs with known nodes show a bar", () => {
    expect(shouldShowProgress(run({ status: "running", totalNodes: 4 }))).toBe(true);
    expect(shouldShowProgress(run({ status: "waiting", totalNodes: 4 }))).toBe(true);
    expect(shouldShowProgress(run({ status: "running", totalNodes: 0 }))).toBe(false);
    expect(shouldShowProgress(run({ status: "finished", totalNodes: 4 }))).toBe(false);
  });
});

describe("runDisplayName", () => {
  test("falls back to a friendly label for a blank workflow name", () => {
    expect(runDisplayName(run({ workflowName: "  " }))).toBe("Unnamed flow");
    expect(runDisplayName(run({ workflowName: "deploy-flow" }))).toBe("deploy-flow");
  });
});

describe("matchesAge", () => {
  test("today is inside every window; older is inside none but all", () => {
    const today = run({ ageBucket: "today" });
    const older = run({ ageBucket: "older" });
    expect(matchesAge(today, "today")).toBe(true);
    expect(matchesAge(today, "week")).toBe(true);
    expect(matchesAge(today, "month")).toBe(true);
    expect(matchesAge(today, "all")).toBe(true);
    expect(matchesAge(older, "today")).toBe(false);
    expect(matchesAge(older, "week")).toBe(false);
    expect(matchesAge(older, "month")).toBe(false);
    expect(matchesAge(older, "all")).toBe(true);
  });
});

describe("matchesSearch", () => {
  test("matches workflow name or runId, case-insensitively", () => {
    const r = run({ workflowName: "Deploy-Flow", runId: "run-abc123" });
    expect(matchesSearch(r, "")).toBe(true);
    expect(matchesSearch(r, "deploy")).toBe(true);
    expect(matchesSearch(r, "ABC123")).toBe(true);
    expect(matchesSearch(r, "nomatch")).toBe(false);
  });
});

describe("hasActiveFilters", () => {
  test("the default filter bag has no active filters", () => {
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
  });

  test("any non-default field counts as active", () => {
    const f: RunFilters = { ...DEFAULT_FILTERS, status: "failed" };
    expect(hasActiveFilters(f)).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, search: "x" })).toBe(true);
  });
});

describe("filterRuns", () => {
  const runs = [
    run({ id: "a", workflowName: "deploy", status: "running", ageBucket: "today" }),
    run({ id: "b", workflowName: "build", status: "failed", ageBucket: "older" }),
    run({ id: "c", workflowName: "deploy", status: "finished", ageBucket: "week" }),
  ];

  test("with the default filter bag, every run passes", () => {
    expect(filterRuns(runs, DEFAULT_FILTERS)).toHaveLength(3);
  });

  test("status filter narrows to the matching rows, preserving order", () => {
    const filtered = filterRuns(runs, { ...DEFAULT_FILTERS, status: "failed" });
    expect(filtered.map((r) => r.id)).toEqual(["b"]);
  });

  test("filters compose (workflow AND age) — 'a' is deploy but today, so age:week keeps it too", () => {
    const filtered = filterRuns(runs, { ...DEFAULT_FILTERS, workflow: "deploy", age: "week" });
    expect(filtered.map((r) => r.id)).toEqual(["a", "c"]);
  });

  test("a filter with no matches in either dimension excludes the row", () => {
    const filtered = filterRuns(runs, { ...DEFAULT_FILTERS, workflow: "build", age: "today" });
    expect(filtered).toHaveLength(0);
  });
});

describe("distinctWorkflows", () => {
  test("de-dupes case-insensitively, keeping first-seen casing and order", () => {
    const runs = [run({ workflowName: "Deploy" }), run({ workflowName: "build" }), run({ workflowName: "deploy" })];
    expect(distinctWorkflows(runs)).toEqual(["Deploy", "build"]);
  });
});

describe("groupRuns", () => {
  test("partitions into fixed ACTIVE/COMPLETED/FAILED/CANCELLED sections, dropping empty ones", () => {
    const runs = [
      run({ id: "a", status: "running" }),
      run({ id: "b", status: "waiting" }),
      run({ id: "c", status: "finished" }),
    ];
    const groups = groupRuns(runs);
    expect(groups.map((g) => g.key)).toEqual(["active", "completed"]);
    expect(groups[0]?.runs.map((r) => r.id)).toEqual(["a", "b"]);
    expect(groups[1]?.runs.map((r) => r.id)).toEqual(["c"]);
  });

  test("an empty roster yields no groups", () => {
    expect(groupRuns([])).toEqual([]);
  });
});

describe("summarizeRuns", () => {
  test("tallies each status bucket plus the total", () => {
    const runs = [
      run({ status: "running" }),
      run({ status: "waiting" }),
      run({ status: "finished" }),
      run({ status: "failed" }),
      run({ status: "cancelled" }),
      run({ status: "unknown" }),
    ];
    expect(summarizeRuns(runs)).toEqual({ total: 6, active: 2, done: 1, failed: 1, cancelled: 1, unknown: 1 });
  });
});

describe("isTerminal", () => {
  test("finished/failed/cancelled are terminal; running/waiting are not", () => {
    expect(isTerminal("finished")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("waiting")).toBe(false);
  });
});

describe("matchesRepo", () => {
  test("a row with no repoContext is scope-unknown, so it stays visible", () => {
    expect(matchesRepo(run(), { owner: "acme", repo: "widgets" })).toBe(true);
  });

  test("matches case-insensitively on owner/repo", () => {
    const r = run({ repoContext: { owner: "Acme", repo: "Widgets" } });
    expect(matchesRepo(r, { owner: "acme", repo: "widgets" })).toBe(true);
    expect(matchesRepo(r, { owner: "acme", repo: "other" })).toBe(false);
  });
});

describe("runsEmbedTop", () => {
  test("active rows fill the limit first, in roster order", () => {
    const runs = [
      run({ id: "a", status: "finished" }),
      run({ id: "b", status: "running" }),
      run({ id: "c", status: "waiting" }),
    ];
    expect(runsEmbedTop(runs, 2).map((r) => r.id)).toEqual(["b", "c"]);
  });

  test("settled rows fill remaining slots when active rows don't reach the limit", () => {
    const runs = [run({ id: "a", status: "running" }), run({ id: "b", status: "finished" })];
    expect(runsEmbedTop(runs, 2).map((r) => r.id)).toEqual(["a", "b"]);
  });
});
