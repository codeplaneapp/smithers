import { describe, expect, test } from "bun:test";
import {
  asArray,
  autoExpandKeys,
  clampFrameNo,
  diagnoseRun,
  eventViewFor,
  filterRuns,
  formatElapsed,
  formatEventLine,
  formatOutputValue,
  frameScrubBounds,
  groupForStatus,
  groupRuns,
  hasFailedDescendant,
  hijackActionFor,
  hijackCandidateForNode,
  hijackCandidatesOf,
  isCancellable,
  isNotableEvent,
  isResumable,
  labelForStatus,
  nodeSummaryEligible,
  paginateRuns,
  pick,
  ptyHijackUrl,
  rowOf,
  runProgress,
  RUNS_PAGE_SIZE,
  shortRunId,
  statusOptions,
  timeAgo,
  toneForStatus,
  treeToXml,
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

describe("runs table pagination", () => {
  const rows = (count: number) => Array.from({ length: count }, (_, index) => `run-${index}`);

  test("empty list is a single empty page", () => {
    expect(paginateRuns([], 1, RUNS_PAGE_SIZE)).toEqual({ pageRows: [], page: 1, pageCount: 1, total: 0 });
    // Even an out-of-range request clamps back to the one empty page.
    expect(paginateRuns([], 9, RUNS_PAGE_SIZE).page).toBe(1);
  });

  test("an exact multiple of the page size has no trailing empty page", () => {
    const paged = paginateRuns(rows(200), 2, 100);
    expect(paged.pageCount).toBe(2);
    expect(paged.total).toBe(200);
    expect(paged.pageRows).toHaveLength(100);
    expect(paged.pageRows[0]).toBe("run-100");
    expect(paged.pageRows[99]).toBe("run-199");
  });

  test("overflowing page numbers clamp into range (both directions)", () => {
    const list = rows(150);
    const past = paginateRuns(list, 99, 100);
    expect(past.page).toBe(2);
    expect(past.pageRows).toHaveLength(50);
    expect(past.pageRows[0]).toBe("run-100");
    expect(paginateRuns(list, 0, 100).page).toBe(1);
    expect(paginateRuns(list, Number.NaN, 100).page).toBe(1);
  });

  test("a middle page slices the right window", () => {
    const paged = paginateRuns(rows(250), 2, RUNS_PAGE_SIZE);
    expect(paged).toMatchObject({ page: 2, pageCount: 3, total: 250 });
    expect(paged.pageRows[0]).toBe("run-100");
    expect(paged.pageRows.at(-1)).toBe("run-199");
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

  test("NodeOutput (persisted shape) collapses multiline agent output to one line", () => {
    const line = formatEventLine({
      event: "NodeOutput",
      seq: 11,
      payload: {
        type: "NodeOutput",
        runId: "r1",
        nodeId: "implement",
        iteration: 0,
        attempt: 1,
        text: "Running tests...\nAll 42 tests green",
        stream: "stdout",
        timestampMs: 1,
      },
    });
    expect(line.detail).toBe("implement · Running tests... All 42 tests green");
    expect(line.detail).not.toContain("\n");
  });

  test("stderr NodeOutput is labeled", () => {
    const line = formatEventLine({
      event: "NodeOutput",
      seq: 12,
      payload: { nodeId: "implement", text: "boom", stream: "stderr" },
    });
    expect(line.detail).toBe("implement · stderr · boom");
  });

  test("AgentTraceEvent shows the tool name plus a compact args hint", () => {
    const line = formatEventLine({
      event: "AgentTraceEvent",
      seq: 13,
      payload: {
        type: "AgentTraceEvent",
        runId: "r1",
        nodeId: "implement",
        iteration: 0,
        attempt: 1,
        trace: {
          traceVersion: "1",
          event: { sequence: 3, kind: "tool.execution.start", phase: "tool" },
          payload: {
            toolCallId: "call-1",
            toolName: "Bash",
            argsPreview: { command: "bun test tests/monitor-ui-model.test.ts" },
            isError: false,
          },
        },
        timestampMs: 2,
      },
    });
    expect(line.detail).toContain("implement");
    expect(line.detail).toContain("tool.execution.start");
    expect(line.detail).toContain("Bash");
    expect(line.detail).toContain("bun test");
  });

  test("AgentTraceEvent text kinds show a chat snippet", () => {
    const line = formatEventLine({
      event: "agent.trace",
      seq: 14,
      payload: {
        nodeId: "implement",
        trace: {
          event: { sequence: 9, kind: "assistant.message.final", phase: "message" },
          payload: { text: "The fix is in monitorModel.ts; all tests pass." },
        },
      },
    });
    expect(line.detail).toContain("assistant.message.final");
    expect(line.detail).toContain("The fix is in monitorModel.ts");
  });

  test("AgentEvent completed shows the engine and answer snippet", () => {
    const line = formatEventLine({
      event: "AgentEvent",
      seq: 15,
      payload: {
        type: "AgentEvent",
        runId: "r1",
        nodeId: "implement",
        iteration: 0,
        attempt: 1,
        engine: "claude",
        event: { type: "completed", engine: "claude", ok: true, answer: "All tests pass; committed the fix.", resume: "sess-1" },
        timestampMs: 3,
      },
    });
    expect(line.detail).toContain("claude");
    expect(line.detail).toContain("completed");
    expect(line.detail).toContain("All tests pass");
  });

  test("AgentEvent action shows phase, kind, and title", () => {
    const line = formatEventLine({
      event: "AgentEvent",
      seq: 16,
      payload: {
        nodeId: "implement",
        engine: "codex",
        event: {
          type: "action",
          engine: "codex",
          phase: "started",
          action: { id: "a1", kind: "command", title: "bun test" },
        },
      },
    });
    expect(line.detail).toContain("codex");
    expect(line.detail).toContain("started command");
    expect(line.detail).toContain("bun test");
  });

  test("FrameCommitted shows the frame number and trigger", () => {
    const line = formatEventLine({
      event: "FrameCommitted",
      seq: 17,
      payload: { type: "FrameCommitted", runId: "r1", frameNo: 12, xmlHash: "abc123", trigger: "node-finished", timestampMs: 4 },
    });
    expect(line.detail).toBe("frame 12 · node-finished");
  });

  test("TokenUsageReported shows the model and token totals", () => {
    const line = formatEventLine({
      event: "TokenUsageReported",
      seq: 18,
      payload: {
        type: "TokenUsageReported",
        runId: "r1",
        nodeId: "implement",
        iteration: 0,
        attempt: 1,
        model: "claude-fable-5",
        agent: "claude",
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 800,
        timestampMs: 5,
      },
    });
    expect(line.detail).toContain("claude-fable-5");
    expect(line.detail).toContain("in 1200");
    expect(line.detail).toContain("out 300");
    expect(line.detail).toContain("cache 800");
  });

  test("AgentTraceSummary shows model, capture mode, and completeness", () => {
    const line = formatEventLine({
      event: "AgentTraceSummary",
      seq: 19,
      payload: {
        nodeId: "implement",
        summary: {
          traceVersion: "1",
          agentFamily: "claude-code",
          model: "claude-fable-5",
          captureMode: "cli-json-stream",
          traceCompleteness: "full-observed",
        },
      },
    });
    expect(line.detail).toBe("implement · claude-fable-5 · cli-json-stream · full-observed");
  });

  test("failure events surface the error message", () => {
    const line = formatEventLine({
      event: "node.failed",
      seq: 20,
      payload: { nodeId: "verify", state: "failed", error: { message: "expected 2 to be 3" } },
    });
    expect(line.detail).toBe("verify · failed · expected 2 to be 3");
  });
});

describe("event views", () => {
  test("notable keeps the human-decision set", () => {
    expect(eventViewFor("NodeStarted")).toBe("notable");
    expect(eventViewFor("NodeFailed")).toBe("notable");
    expect(eventViewFor("RunFinished")).toBe("notable");
    expect(eventViewFor("ApprovalRequested")).toBe("notable");
    expect(eventViewFor("HumanRequestCreated")).toBe("notable");
    expect(eventViewFor("SignalDelivered")).toBe("notable");
  });

  test("activity adds the agent's visible work", () => {
    expect(eventViewFor("AgentEvent")).toBe("activity");
    expect(eventViewFor("AgentTraceEvent")).toBe("activity");
    expect(eventViewFor("AgentTraceSummary")).toBe("activity");
    expect(eventViewFor("TokenUsageReported")).toBe("activity");
    expect(eventViewFor("FrameCommitted")).toBe("activity");
    expect(eventViewFor("NodeOutput")).toBe("activity");
    expect(eventViewFor("ToolCallStarted")).toBe("activity");
    expect(eventViewFor("ToolCallFinished")).toBe("activity");
    // Gateway wire names classify the same as their persisted twins.
    expect(eventViewFor("task.output")).toBe("activity");
    expect(eventViewFor("agent.event")).toBe("activity");
    expect(eventViewFor("agent.trace")).toBe("activity");
    expect(eventViewFor("agent.trace_summary")).toBe("activity");
    expect(eventViewFor("node.started")).toBe("activity");
    expect(eventViewFor("run.completed")).toBe("activity");
  });

  test("heartbeats and session bookkeeping are chatter", () => {
    expect(eventViewFor("TaskHeartbeat")).toBe("chatter");
    expect(eventViewFor("run.heartbeat")).toBe("chatter");
    expect(eventViewFor("task.heartbeat")).toBe("chatter");
    expect(eventViewFor("AgentSessionEvent")).toBe("chatter");
    expect(eventViewFor("agent.session")).toBe("chatter");
    expect(eventViewFor("SnapshotCaptured")).toBe("chatter");
    expect(eventViewFor("NodePending")).toBe("chatter");
  });

  test("isNotableEvent delegates to eventViewFor", () => {
    expect(isNotableEvent("NodeStarted")).toBe(true);
    expect(isNotableEvent("QuotaExceeded")).toBe(true);
    expect(isNotableEvent("AgentEvent")).toBe(false);
    expect(isNotableEvent("FrameCommitted")).toBe(false);
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

describe("frame scrubber", () => {
  test("frames are numbered from 1, so a run with frames scrubs 1..latest", () => {
    expect(frameScrubBounds(7)).toEqual({ min: 1, max: 7 });
    expect(frameScrubBounds(1)).toEqual({ min: 1, max: 1 });
  });

  test("a zero-frame run only has the sentinel frame 0", () => {
    expect(frameScrubBounds(0)).toEqual({ min: 0, max: 0 });
  });

  test("garbage latest collapses to the empty range", () => {
    expect(frameScrubBounds(Number.NaN)).toEqual({ min: 0, max: 0 });
    expect(frameScrubBounds(-3)).toEqual({ min: 0, max: 0 });
  });

  test("clampFrameNo pins prev/next stepping inside the valid range", () => {
    expect(clampFrameNo(4, 7)).toBe(4);
    expect(clampFrameNo(0, 7)).toBe(1);
    expect(clampFrameNo(-1, 7)).toBe(1);
    expect(clampFrameNo(8, 7)).toBe(7);
    expect(clampFrameNo(3.7, 7)).toBe(3);
  });

  test("clampFrameNo falls back to the latest frame on non-finite input", () => {
    expect(clampFrameNo(Number.NaN, 7)).toBe(7);
    expect(clampFrameNo(Number.POSITIVE_INFINITY, 7)).toBe(7);
    expect(clampFrameNo(Number.NaN, 0)).toBe(0);
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

describe("nodeSummaryEligible", () => {
  test("settled nodes earn a what-happened recap", () => {
    expect(nodeSummaryEligible("finished")).toBe(true);
    expect(nodeSummaryEligible("succeeded")).toBe(true);
    expect(nodeSummaryEligible("failed")).toBe(true);
    expect(nodeSummaryEligible("error")).toBe(true);
    expect(nodeSummaryEligible("cancelled")).toBe(true);
    expect(nodeSummaryEligible("canceled")).toBe(true);
  });

  test("live, pending, and skipped nodes do not", () => {
    expect(nodeSummaryEligible("running")).toBe(false);
    expect(nodeSummaryEligible("in-progress")).toBe(false);
    expect(nodeSummaryEligible("pending")).toBe(false);
    expect(nodeSummaryEligible("waiting-approval")).toBe(false);
    expect(nodeSummaryEligible("skipped")).toBe(false);
    expect(nodeSummaryEligible(undefined)).toBe(false);
    expect(nodeSummaryEligible("")).toBe(false);
  });
});

describe("PTY hijack affordance", () => {
  test("hijackCandidatesOf tolerates the HTTP envelope and junk rows", () => {
    const body = {
      ok: true,
      data: {
        runId: "r1",
        candidates: [
          { nodeId: "agent-task", engine: "claude-code", mode: "native-cli" },
          { nodeId: "chatty", engine: "pi", mode: "conversation" },
          { nodeId: "", engine: "claude-code" },
          { engine: "codex" },
          "garbage",
        ],
      },
    };
    expect(hijackCandidatesOf(body)).toEqual([
      { nodeId: "agent-task", engine: "claude-code", mode: "native-cli" },
      { nodeId: "chatty", engine: "pi", mode: "conversation" },
    ]);
    expect(hijackCandidatesOf(null)).toEqual([]);
    expect(hijackCandidatesOf({ candidates: [{ nodeId: "n", engine: "codex" }] })).toEqual([
      { nodeId: "n", engine: "codex", mode: "native-cli" },
    ]);
  });

  test("hijackCandidateForNode matches by node id only", () => {
    const candidates = [{ nodeId: "a", engine: "codex", mode: "native-cli" }];
    expect(hijackCandidateForNode(candidates, "a")?.engine).toBe("codex");
    expect(hijackCandidateForNode(candidates, "b")).toBeNull();
    expect(hijackCandidateForNode(candidates, undefined)).toBeNull();
  });

  test("no candidate means no button, regardless of statuses", () => {
    expect(hijackActionFor("running", true, false)).toBeNull();
    expect(hijackActionFor("finished", false, false)).toBeNull();
  });

  test("live run + live node offers a hand-off Hijack", () => {
    expect(hijackActionFor("running", true, true)).toEqual({ kind: "hijack", label: "Hijack" });
  });

  test("live run + finished node reopens the recorded session (post-mortem one lane without waiting for the fleet)", () => {
    expect(hijackActionFor("running", false, true)).toEqual({ kind: "reopen", label: "Reopen session" });
  });

  test("settled runs reopen the recorded session for finished AND failed nodes", () => {
    for (const status of ["finished", "failed", "cancelled", "waiting-approval", "paused", undefined]) {
      expect(hijackActionFor(status, false, true)).toEqual({ kind: "reopen", label: "Reopen session" });
    }
  });

  test("ptyHijackUrl builds a ws url with clamped geometry", () => {
    expect(ptyHijackUrl("http://127.0.0.1:7331", "run 1", "node/1", { cols: 120, rows: 40 })).toBe(
      "ws://127.0.0.1:7331/v1/pty/hijack?runId=run+1&nodeId=node%2F1&cols=120&rows=40",
    );
    expect(ptyHijackUrl("https://gw.example", "r", undefined, { cols: 0, rows: Number.NaN })).toBe(
      "wss://gw.example/v1/pty/hijack?runId=r&cols=80&rows=24",
    );
  });
});

describe("treeToXml", () => {
  test("serializes the tree as indented engine-style XML with status attributes", () => {
    const xml = treeToXml({
      id: "root",
      kind: "workflow",
      name: "ticket-fleet",
      status: "running",
      children: [
        {
          id: "seq",
          kind: "sequence",
          status: "running",
          children: [
            { id: "guard-baseline", kind: "task", status: "ok", children: [] },
            { id: "i531:implement", kind: "task", status: "running", iteration: 1, children: [] },
          ],
        },
      ],
    });
    expect(xml).toBe(
      [
        '<Workflow id="root" name="ticket-fleet" status="running">',
        '  <Sequence id="seq" status="running">',
        '    <Task id="guard-baseline" status="ok" />',
        '    <Task id="i531:implement" status="running" iteration="1" />',
        "  </Sequence>",
        "</Workflow>",
      ].join("\n"),
    );
  });

  test("escapes XML-hostile characters and tolerates null/empty input", () => {
    expect(treeToXml(null)).toBe("");
    expect(treeToXml({ id: 'a"<b>&c', kind: "task" })).toBe('<Task id="a&quot;&lt;b>&amp;c" />');
  });
});
