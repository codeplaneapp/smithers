import { describe, expect, test } from "bun:test";
import {
  asArray,
  autoExpandKeys,
  diagnoseRun,
  filterRuns,
  formatElapsed,
  formatEventLine,
  formatOutputValue,
  groupForStatus,
  groupRuns,
  hasFailedDescendant,
  isCancellable,
  isResumable,
  labelForStatus,
  pick,
  rowOf,
  runProgress,
  shortRunId,
  statusOptions,
  timeAgo,
  toneForStatus,
  waitTone,
  workflowOptions,
} from "../src/monitor-ui/monitorModel.ts";

describe("status tones", () => {
  test("maps every run lifecycle status to a tone", () => {
    expect(toneForStatus("running")).toBe("running");
    expect(toneForStatus("in-progress")).toBe("running");
    expect(toneForStatus("continued")).toBe("running");
    expect(toneForStatus("recovering")).toBe("running");
    expect(toneForStatus("waiting-approval")).toBe("waiting");
    expect(toneForStatus("waiting_event")).toBe("waiting");
    expect(toneForStatus("pending")).toBe("waiting");
    expect(toneForStatus("finished")).toBe("ok");
    expect(toneForStatus("succeeded")).toBe("ok");
    expect(toneForStatus("failed")).toBe("failed");
    expect(toneForStatus("stale")).toBe("failed");
    expect(toneForStatus("orphaned")).toBe("failed");
    expect(toneForStatus("cancelled")).toBe("idle");
    expect(toneForStatus("skipped")).toBe("idle");
  });

  test("unknown statuses surface as live instead of vanishing", () => {
    expect(toneForStatus("some-new-status")).toBe("running");
    expect(toneForStatus(undefined)).toBe("running");
  });

  test("labelForStatus normalizes underscores and blanks", () => {
    expect(labelForStatus("waiting_approval")).toBe("waiting-approval");
    expect(labelForStatus(undefined)).toBe("unknown");
  });
});

describe("run grouping", () => {
  test("groups waiting runs under needs-attention, first in order", () => {
    const groups = groupRuns([
      { runId: "a", status: "finished", createdAtMs: 1 },
      { runId: "b", status: "waiting-approval", createdAtMs: 2 },
      { runId: "c", status: "running", createdAtMs: 3 },
      { runId: "d", status: "failed", createdAtMs: 4 },
      { runId: "e", status: "cancelled", createdAtMs: 5 },
    ]);
    expect(groups.map((group) => group.group)).toEqual([
      "attention",
      "active",
      "completed",
      "failed",
      "cancelled",
    ]);
    expect(groups[0]?.runs.map((run) => run.runId)).toEqual(["b"]);
  });

  test("orders newest first within a group and drops empty groups", () => {
    const groups = groupRuns([
      { runId: "old", status: "running", createdAtMs: 1 },
      { runId: "new", status: "running", createdAtMs: 9 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.runs.map((run) => run.runId)).toEqual(["new", "old"]);
  });

  test("stale and orphaned runs group as failed; unknown as active", () => {
    expect(groupForStatus("stale")).toBe("failed");
    expect(groupForStatus("orphaned")).toBe("failed");
    expect(groupForStatus("brand-new-state")).toBe("active");
  });
});

describe("filtering", () => {
  const runs = [
    { runId: "run-alpha", workflowKey: "deploy", status: "running" },
    { runId: "run-beta", workflowKey: "review", status: "failed" },
    { runId: "run-gamma", status: "finished" },
  ];

  test("filters by text across run id and workflow", () => {
    expect(filterRuns(runs, { text: "alp", status: "all", workflow: "all" })).toHaveLength(1);
    expect(filterRuns(runs, { text: "review", status: "all", workflow: "all" })[0]?.runId).toBe("run-beta");
  });

  test("filters by normalized status and workflow, missing workflow reads as unknown", () => {
    expect(filterRuns(runs, { text: "", status: "failed", workflow: "all" })).toHaveLength(1);
    expect(filterRuns(runs, { text: "", status: "all", workflow: "unknown" })[0]?.runId).toBe("run-gamma");
  });

  test("option lists are sorted and deduped", () => {
    expect(workflowOptions(runs)).toEqual(["deploy", "review", "unknown"]);
    expect(statusOptions(runs)).toEqual(["failed", "finished", "running"]);
  });
});

describe("lifecycle predicates", () => {
  test("cancellable only while non-terminal", () => {
    expect(isCancellable("running")).toBe(true);
    expect(isCancellable("waiting-approval")).toBe(true);
    expect(isCancellable("finished")).toBe(false);
    expect(isCancellable("failed")).toBe(false);
  });

  test("resumable for failed, cancelled, stale, orphaned", () => {
    expect(isResumable("failed")).toBe(true);
    expect(isResumable("cancelled")).toBe(true);
    expect(isResumable("stale")).toBe(true);
    expect(isResumable("running")).toBe(false);
    expect(isResumable("finished")).toBe(false);
  });
});

describe("progress", () => {
  test("derives done/failed/total from the node-state summary", () => {
    const progress = runProgress({ "finished": 3, "in-progress": 1, "failed": 1, "pending": 1 });
    expect(progress).toEqual({ done: 3, failed: 1, total: 6, fraction: 4 / 6 });
  });

  test("null when empty or not a record", () => {
    expect(runProgress({})).toBeNull();
    expect(runProgress(undefined)).toBeNull();
    expect(runProgress("nope")).toBeNull();
  });
});

describe("time formatting", () => {
  test("formatElapsed picks the right granularity", () => {
    const t0 = 1_000_000;
    expect(formatElapsed(t0, t0 + 5_000)).toBe("5s");
    expect(formatElapsed(t0, t0 + 65_000)).toBe("1m 5s");
    expect(formatElapsed(t0, t0 + 3_660_000)).toBe("1h 1m");
    expect(formatElapsed(t0, t0 + 90_000_000)).toBe("1d 1h");
    expect(formatElapsed(undefined, t0)).toBe("0s");
  });

  test("timeAgo buckets", () => {
    const now = 10_000_000;
    expect(timeAgo(now - 30_000, now)).toBe("just now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(timeAgo(undefined, now)).toBe("—");
  });

  test("approval wait escalates at 5 and 30 minutes", () => {
    expect(waitTone(60_000)).toBe("idle");
    expect(waitTone(6 * 60_000)).toBe("waiting");
    expect(waitTone(31 * 60_000)).toBe("failed");
  });

  test("shortRunId", () => {
    expect(shortRunId("run-123456789")).toBe("run-1234");
    expect(shortRunId(undefined)).toBe("—");
  });
});

describe("event lines", () => {
  test("node lifecycle events show node id and state", () => {
    const line = formatEventLine({ event: "node.started", seq: 7, payload: { nodeId: "plan", state: "in-progress" } });
    expect(line).toEqual({ seq: 7, name: "node.started", detail: "plan · in-progress" });
  });

  test("snake_case payloads are tolerated", () => {
    const line = formatEventLine({ event: "node.finished", seq: 9, payload: { node_id: "build" } });
    expect(line.detail).toBe("build");
  });

  test("task output text is truncated", () => {
    const line = formatEventLine({ event: "task.output", seq: 1, payload: { nodeId: "n", text: "x".repeat(500) } });
    expect(line.detail.length).toBeLessThan(200);
    expect(line.detail.endsWith("…")).toBe(true);
  });
});

describe("tree expansion", () => {
  const tree = {
    key: "root",
    status: "running",
    children: [
      {
        key: "seq",
        status: "running",
        children: [
          { key: "done-task", status: "ok", children: [] },
          { key: "live-task", status: "running", children: [] },
        ],
      },
      {
        key: "quiet",
        status: "ok",
        children: [{ key: "deep-fail", status: "failed", children: [] }],
      },
    ],
  };

  test("expands ancestors of running, waiting, and failed nodes", () => {
    const expanded = autoExpandKeys(tree);
    expect(expanded.has("root")).toBe(true);
    expect(expanded.has("seq")).toBe(true);
    expect(expanded.has("quiet")).toBe(true);
    expect(expanded.has("done-task")).toBe(false);
  });

  test("a fully finished run still expands shallow containers so tasks stay visible", () => {
    const finished = {
      key: "root",
      status: "ok",
      children: [
        {
          key: "seq",
          status: "ok",
          children: [
            { key: "task-a", status: "ok", children: [] },
            {
              key: "deep",
              status: "ok",
              children: [{ key: "deepest", status: "ok", children: [{ key: "leaf", status: "ok" }] }],
            },
          ],
        },
      ],
    };
    const expanded = autoExpandKeys(finished);
    expect(expanded.has("root")).toBe(true);
    expect(expanded.has("seq")).toBe(true);
    // Depth 2+ containers stay collapsed until something in them needs attention.
    expect(expanded.has("deep")).toBe(false);
    expect(expanded.has("deepest")).toBe(false);
  });

  test("null root expands nothing", () => {
    expect(autoExpandKeys(null).size).toBe(0);
  });

  test("hasFailedDescendant rolls up through collapsed branches", () => {
    expect(hasFailedDescendant(tree)).toBe(true);
    expect(hasFailedDescendant({ key: "leaf", status: "failed" })).toBe(false);
  });
});

describe("tolerant readers", () => {
  test("rowOf unwraps { row } envelopes", () => {
    expect(rowOf({ row: { a: 1 }, schema: {} })).toEqual({ a: 1 });
    expect(rowOf({ a: 1 })).toEqual({ a: 1 });
    expect(rowOf("nope")).toBeNull();
  });

  test("pick reads camelCase then snake_case", () => {
    expect(pick({ nodeId: "x" }, "nodeId", "node_id")).toBe("x");
    expect(pick({ node_id: "y" }, "nodeId", "node_id")).toBe("y");
  });

  test("asArray decodes JSON-encoded arrays", () => {
    expect(asArray('["a","b"]')).toEqual(["a", "b"]);
    expect(asArray("not json [")).toEqual([]);
    expect(asArray([1])).toEqual([1]);
  });

  test("formatOutputValue pretty-prints JSON strings and objects", () => {
    expect(formatOutputValue('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(formatOutputValue({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatOutputValue("plain text")).toBe("plain text");
    expect(formatOutputValue(undefined)).toBe("");
  });
});

describe("diagnoseRun", () => {
  const base = {
    runId: "run-x",
    quota: null,
    approvalsCount: 0,
    treeNodes: [] as Array<{ id?: unknown; status?: unknown }>,
  };
  const nodes = (...pairs: Array<[string, string]>) => pairs.map(([id, status]) => ({ id, status }));

  test("healthy running run is green with progress", () => {
    const d = diagnoseRun({
      ...base,
      status: "running",
      treeNodes: nodes(["a", "ok"], ["b", "running"], ["c", "queued"], ["12345", "running"]),
    });
    expect(d.tone).toBe("ok");
    expect(d.headline).toContain("Healthy");
    expect(d.detail).toContain("1/3 tasks done");
    expect(d.detail).toContain("b");
  });

  test("quota park is yellow with who and how to fix", () => {
    const d = diagnoseRun({
      ...base,
      status: "waiting-quota",
      quota: {
        blockedCount: 2,
        resetAtMs: 999,
        blocked: [{ nodeId: "i9:verdict", message: "claude-sonnet-5 hit a provider usage/quota limit" }],
      },
      treeNodes: nodes(["a", "ok"]),
    });
    expect(d.tone).toBe("warn");
    expect(d.headline).toContain("quota");
    expect(d.detail).toContain("i9:verdict");
    expect(d.detail).toContain("usage/quota limit");
    expect(d.fix).toContain("--resume run-x");
  });

  test("guard trip is red and forbids resuming blindly", () => {
    const d = diagnoseRun({
      ...base,
      status: "running",
      treeNodes: nodes(["guard:start", "failed"], ["a", "ok"]),
    });
    expect(d.tone).toBe("crit");
    expect(d.headline).toContain("guard");
    expect(d.fix).toContain("Do NOT resume");
  });

  test("failed tasks on a live run are yellow with the failure sample", () => {
    const d = diagnoseRun({
      ...base,
      status: "running",
      treeNodes: nodes(["a", "failed"], ["b", "running"]),
      failureSample: { nodeId: "a", message: "AGENT_QUOTA_EXCEEDED: limit hit" },
    });
    expect(d.tone).toBe("warn");
    expect(d.headline).toContain("1 failed");
    expect(d.detail).toContain("AGENT_QUOTA_EXCEEDED");
  });

  test("pending approvals are yellow pointing at the panel", () => {
    const d = diagnoseRun({ ...base, status: "running", approvalsCount: 2, treeNodes: nodes(["a", "ok"]) });
    expect(d.tone).toBe("warn");
    expect(d.headline).toContain("2 approval(s)");
  });

  test("clean finish is green, finish with failures is yellow", () => {
    expect(diagnoseRun({ ...base, status: "finished", treeNodes: nodes(["a", "ok"]) }).tone).toBe("ok");
    expect(diagnoseRun({ ...base, status: "finished", treeNodes: nodes(["a", "failed"]) }).tone).toBe("warn");
  });

  test("loop iterations dedupe to the busiest status per logical id", () => {
    const d = diagnoseRun({
      ...base,
      status: "running",
      treeNodes: [
        { id: "loop-task", status: "ok" },
        { id: "loop-task", status: "running" },
      ],
    });
    expect(d.detail).toContain("0/1 tasks done");
    expect(d.detail).toContain("loop-task");
  });
});
