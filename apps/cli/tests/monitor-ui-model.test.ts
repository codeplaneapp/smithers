import { describe, expect, test } from "bun:test";
import {
  accountRowsOf,
  asArray,
  cronRowsOf,
  dataRowsOf,
  describeErrorCounter,
  formatLatencyMs,
  formatScore,
  histogramQuantile,
  histogramStats,
  metricValue,
  nextCron,
  nonZeroErrorCounters,
  openTicketCount,
  opsStats,
  parsePrometheusText,
  scoreRowsOf,
  scoresForNode,
  scoresSummary,
  scoreTone,
  autoExpandKeys,
  buildTimeline,
  canRetryTask,
  cancelConfirmationStateAt,
  cancelConfirmationTransition,
  clampFrameNo,
  connectionViewFor,
  diagnoseRun,
  diffPatchesOf,
  diffSummaryOf,
  embedModeFromSearch,
  eventViewFor,
  filterRuns,
  formatDiffSummary,
  formatDurationMs,
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
  isHeartbeatEvent,
  isNotableEvent,
  isPausable,
  isResumable,
  labelForStatus,
  looksLikeUnifiedDiff,
  middleTruncate,
  nodeStateRowsOf,
  nodeSummaryEligible,
  paginateRuns,
  pick,
  ptyHijackUrl,
  rowOf,
  runErrorOf,
  runProgress,
  RUNS_PAGE_SIZE,
  shortRunId,
  selectionSinkFor,
  sortRunsForTable,
  splitHeartbeatEvents,
  splitPatchText,
  statusOptions,
  sumDiffSummaries,
  taskProgressOf,
  timeAgo,
  toneForStatus,
  treeToXml,
  waitTone,
  workflowOptions,
} from "../src/monitor-ui/monitorModel.ts";

describe("embedded monitor bootstrap", () => {
  test("parses embed selection, validated origin, and explicit theme", () => {
    expect(embedModeFromSearch("?embed=1&runId=run-1&nodeId=build&hostOrigin=https%3A%2F%2Fhost.example%2F&theme=dark")).toEqual({
      embed: true,
      runId: "run-1",
      nodeId: "build",
      hostOrigin: "https://host.example",
      theme: "dark",
    });
    expect(embedModeFromSearch("?embed=1&theme=light").theme).toBe("light");
  });

  test("rejects malformed or non-origin host origins", () => {
    for (const value of [
      "https://host.example/path",
      "https://host.example/?query=1",
      "https://host.example/?",
      "https://host.example/#",
      "https:host.example",
      "https://host.example/foo/..",
      "https://host.example/.",
      "https://host.example/%2e",
      "https://host.example\\@evil.example",
      "https://*.example.com",
      "https://host%2eexample",
      "https://user:pass@host.example",
      "not-an-origin",
      "javascript:alert(1)",
    ]) {
      expect(embedModeFromSearch(`?embed=1&hostOrigin=${encodeURIComponent(value)}`).hostOrigin).toBeUndefined();
    }
  });

  test("ignores unsupported themes", () => {
    expect(embedModeFromSearch("?embed=1&theme=system").theme).toBeUndefined();
  });

  test("selects the safe sink for embed and standalone modes", () => {
    expect(selectionSinkFor({ embed: true, hostOrigin: "https://host.example" }, "run-1", "node-1")).toEqual({
      kind: "postMessage",
      targetOrigin: "https://host.example",
      message: { type: "smithers-monitor:selection", runId: "run-1", nodeId: "node-1" },
    });
    expect(selectionSinkFor({ embed: true }, "run-1", undefined)).toEqual({ kind: "none" });
    expect(selectionSinkFor({ embed: false }, undefined, "node-1")).toEqual({ kind: "url", nodeId: "node-1" });
  });
});

describe("cancel confirmation", () => {
  test("arms, confirms, keeps, and times out as pure transitions", () => {
    const armed = cancelConfirmationTransition({ armedAtMs: null }, "arm", 100);
    expect(armed).toEqual({ state: { armedAtMs: 100 }, decision: "armed" });
    expect(cancelConfirmationTransition(armed.state, "confirm", 200).decision).toBe("confirmed");
    expect(cancelConfirmationTransition(armed.state, "keep", 200)).toEqual({
      state: { armedAtMs: null },
      decision: "disarmed",
    });
    expect(cancelConfirmationStateAt(armed.state, 4_100)).toEqual({ armedAtMs: null });
    expect(cancelConfirmationTransition(armed.state, "confirm", 4_100).decision).toBe("disarmed");
  });
});

describe("status tones", () => {
  test("maps every run lifecycle status to a tone", () => {
    expect(toneForStatus("running")).toBe("running");
    expect(toneForStatus("in-progress")).toBe("running");
    expect(toneForStatus("continued")).toBe("ok");
    expect(toneForStatus("recovering")).toBe("waiting");
    expect(toneForStatus("waiting-approval")).toBe("waiting");
    expect(toneForStatus("waiting_event")).toBe("waiting");
    expect(toneForStatus("pending")).toBe("idle");
    expect(toneForStatus("queued")).toBe("idle");
    expect(toneForStatus("finished")).toBe("ok");
    expect(toneForStatus("succeeded")).toBe("ok");
    expect(toneForStatus("failed")).toBe("failed");
    expect(toneForStatus("stale")).toBe("failed");
    expect(toneForStatus("orphaned")).toBe("failed");
    // Cancelled is a deliberate human act — neutral gray, never failure red.
    expect(toneForStatus("cancelled")).toBe("idle");
    expect(toneForStatus("canceled")).toBe("idle");
    expect(toneForStatus("skipped")).toBe("idle");
  });

  test("unknown statuses stay neutral", () => {
    expect(toneForStatus("some-new-status")).toBe("idle");
    expect(toneForStatus(undefined)).toBe("idle");
  });

  test("labelForStatus normalizes underscores and blanks", () => {
    expect(labelForStatus("waiting_approval")).toBe("waiting-approval");
    expect(labelForStatus(undefined)).toBe("unknown");
  });
});

describe("connection states", () => {
  test("online is the only live view: pulsing dot, no hint, no action, no banner", () => {
    const view = connectionViewFor("online");
    expect(view.label).toBe("Live");
    expect(view.tone).toBe("ok");
    expect(view.pulse).toBe(true);
    expect(view.hint).toBeNull();
    expect(view.action).toBeNull();
    expect(view.banner).toBeNull();
  });

  test("connecting (and idle, and unknown) explains that queries are still pending", () => {
    for (const status of ["connecting", "idle", undefined]) {
      const view = connectionViewFor(status);
      expect(view.label).toBe("Connecting…");
      expect(view.tone).toBe("waiting");
      expect(view.pulse).toBe(false);
      expect(view.hint).toMatch(/queries are still pending/i);
      expect(view.action).toBeNull();
      expect(view.banner).toBeNull();
    }
  });

  test("offline keeps last-known data, reconnects automatically, and offers a manual refresh", () => {
    const view = connectionViewFor("offline");
    expect(view.label).toBe("Offline");
    expect(view.tone).toBe("failed");
    expect(view.pulse).toBe(false);
    expect(view.hint).toMatch(/last-known data/i);
    expect(view.hint).toMatch(/reconnecting automatically/i);
    expect(view.action).toEqual({ kind: "reload", label: "Refresh" });
    expect(view.banner?.title).toMatch(/gateway/i);
    expect(view.banner?.detail).toMatch(/automatically/i);
    expect(view.banner?.detail).toMatch(/refresh|re-open/i);
  });

  test("unauthorized names credentials/permissions and never reads like a network outage", () => {
    const view = connectionViewFor("unauthorized");
    expect(view.label).toBe("Unauthorized");
    expect(view.tone).toBe("failed");
    expect(view.pulse).toBe(false);
    const copy = [view.hint, view.banner?.title, view.banner?.detail].join(" ").toLowerCase();
    expect(copy).toContain("credentials or permissions are required");
    expect(copy).toContain("token");
    // No outage vocabulary: an auth failure must not masquerade as one.
    for (const outageWord of ["offline", "network", "unreachable", "can't reach", "not responding", "restarted", "outage"]) {
      expect(copy).not.toContain(outageWord);
    }
  });

  test("every degraded state shares the badge treatment: short label, guidance in the hint", () => {
    for (const status of ["connecting", "idle", "offline", "unauthorized"]) {
      const view = connectionViewFor(status);
      expect(view.pulse).toBe(false);
      expect(view.hint).not.toBeNull();
      // Guidance belongs in the hint; the badge label stays a short state name.
      expect(view.label.length).toBeLessThan(16);
      expect((view.hint ?? "").length).toBeGreaterThan(view.label.length);
    }
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

describe("runs table ordering", () => {
  const unsorted = [
    { runId: "old-finished", status: "finished", createdAtMs: 1 },
    { runId: "newer-finished", status: "finished", createdAtMs: 50 },
    { runId: "live", status: "running", createdAtMs: 10 },
    { runId: "blocked", status: "waiting-approval", createdAtMs: 5 },
    { runId: "corpse", status: "failed", createdAtMs: 99 },
  ];

  test("default is triage order: attention first, then active, newest first inside a band", () => {
    expect(sortRunsForTable(unsorted, "default").map((run) => run.runId)).toEqual([
      "blocked",
      "live",
      "newer-finished",
      "old-finished",
      "corpse",
    ]);
  });

  test("the one live run can never be buried by raw listRuns order", () => {
    const buried = [
      { runId: "h1", status: "finished", createdAtMs: 1 },
      { runId: "h2", status: "cancelled", createdAtMs: 2 },
      { runId: "live", status: "running", createdAtMs: 3 },
    ];
    expect(sortRunsForTable(buried)[0]?.runId).toBe("live");
  });

  test("newest/oldest are pure time sorts over the whole list", () => {
    expect(sortRunsForTable(unsorted, "newest").map((run) => run.runId)).toEqual([
      "corpse",
      "newer-finished",
      "live",
      "blocked",
      "old-finished",
    ]);
    expect(sortRunsForTable(unsorted, "oldest").map((run) => run.runId)).toEqual([
      "old-finished",
      "blocked",
      "live",
      "newer-finished",
      "corpse",
    ]);
  });

  test("middleTruncate keeps head and tail — the distinguishing suffix survives", () => {
    expect(middleTruncate("short")).toBe("short");
    const long = "issue-470-gateway-should-fully-encapsulate-all-db-access";
    const truncated = middleTruncate(long, 40);
    expect(truncated.length).toBeLessThanOrEqual(40);
    expect(truncated.startsWith("issue-470-gateway")).toBe(true);
    expect(truncated.endsWith("db-access")).toBe(true);
    expect(truncated).toContain("…");
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

  test("taskProgressOf counts logical tasks only — containers with numeric keys excluded", () => {
    const progress = taskProgressOf([
      { id: "0", status: "ok" }, // structural container row
      { id: "1", status: "ok" }, // structural container row
      { id: "implement", status: "ok" },
      { id: "verify", status: "failed" },
      { id: "deploy", status: "running" },
      { id: "implement", status: "failed" }, // repeated loop id: busiest status wins
    ]);
    expect(progress).toEqual({ done: 0, failed: 2, total: 3, fraction: 2 / 3 });
    expect(taskProgressOf([])).toBeNull();
  });

  test("runErrorOf reads the run-level errorJson message", () => {
    expect(
      runErrorOf({ errorJson: JSON.stringify({ name: "SmithersError", code: "WORKFLOW_RENDER_FAILED", message: "render threw" }) }),
    ).toBe("render threw");
    expect(runErrorOf({ errorJson: { message: "object form" } })).toBe("object form");
    expect(runErrorOf({ errorJson: "not json" })).toBe("not json");
    expect(runErrorOf({ error: "plain field" })).toBe("plain field");
    expect(runErrorOf({})).toBeUndefined();
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

  test("FrameCommitted with a structured trigger never renders [object Object]", () => {
    const line = formatEventLine({
      event: "FrameCommitted",
      seq: 18,
      payload: { frameNo: 3, trigger: { type: "node-finished", nodeId: "verify" } },
    });
    expect(line.detail).not.toContain("[object Object]");
    expect(line.detail).toBe("frame 3 · node-finished");
  });

  test("heartbeats split out of a frame buffer for the collapsed liveness row", () => {
    const frames = [
      { event: "NodeStarted", seq: 1 },
      { event: "TaskHeartbeat", seq: 2 },
      { event: "run.heartbeat", seq: 3 },
      { event: "TaskHeartbeat", seq: 4 },
      { event: "NodeFinished", seq: 5 },
    ];
    const { heartbeats, rest } = splitHeartbeatEvents(frames);
    expect(heartbeats.map((frame) => frame.seq)).toEqual([2, 3, 4]);
    expect(rest.map((frame) => frame.seq)).toEqual([1, 5]);
    expect(isHeartbeatEvent("TaskHeartbeat")).toBe(true);
    expect(isHeartbeatEvent("NodeStarted")).toBe(false);
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
    expect(d.fix).toContain("add capacity");
    // The monitor renders a one-click "Resume now" button off this field.
    expect(d.action).toBe("resume");
  });

  test("stale heartbeat offers the one-click resume action", () => {
    const d = diagnoseRun({
      ...base,
      status: "running",
      healthState: "stale",
      treeNodes: nodes(["a", "ok"]),
    });
    expect(d.tone).toBe("warn");
    expect(d.headline).toContain("heartbeat");
    expect(d.action).toBe("resume");
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
    // A tripped guard must never get a one-click resume button.
    expect(d.action).toBeUndefined();
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

  test("live run + finished node hides the button because hijack would park the whole run", () => {
    // The PTY invokes `smithers hijack --target <node>`, whose live-run path
    // requests a hand-off of the entire run rather than reopening one lane.
    expect(hijackActionFor("running", false, true)).toBeNull();
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

describe("unified diff detection", () => {
  const gitDiff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
  ].join("\n");

  test("recognizes git and bare unified diffs", () => {
    expect(looksLikeUnifiedDiff(gitDiff)).toBe(true);
    expect(looksLikeUnifiedDiff("  \n" + gitDiff)).toBe(true);
    expect(
      looksLikeUnifiedDiff("--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new"),
    ).toBe(true);
  });

  test("rejects prose, JSON, and header pairs without hunks", () => {
    expect(looksLikeUnifiedDiff(undefined)).toBe(false);
    expect(looksLikeUnifiedDiff(42)).toBe(false);
    expect(looksLikeUnifiedDiff("just some text with a + sign")).toBe(false);
    expect(looksLikeUnifiedDiff('{"diff": "--- separator ---"}')).toBe(false);
    // ---/+++ pair but no @@ hunk anywhere: not a diff.
    expect(looksLikeUnifiedDiff("--- before\n+++ after\nno hunks here")).toBe(false);
  });

  test("diffSummaryOf counts files and content lines, never headers", () => {
    expect(diffSummaryOf(gitDiff)).toEqual({ files: 1, added: 2, removed: 1 });
    const two = `${gitDiff}\ndiff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-x\n+y`;
    expect(diffSummaryOf(two)).toEqual({ files: 2, added: 3, removed: 2 });
    // Bare patch without `diff --git` headers counts `+++ ` file headers.
    expect(diffSummaryOf("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b")).toEqual({ files: 1, added: 1, removed: 1 });
  });

  test("sumDiffSummaries and formatDiffSummary compose the rollup line", () => {
    const total = sumDiffSummaries([
      { files: 1, added: 2, removed: 1 },
      { files: 1, added: 0, removed: 5 },
    ]);
    expect(total).toEqual({ files: 2, added: 2, removed: 6 });
    expect(formatDiffSummary(total)).toBe("2 files, +2/−6");
    expect(formatDiffSummary({ files: 1, added: 0, removed: 0 })).toBe("1 file, +0/−0");
  });

  test("splitPatchText chunks a bundle on diff --git boundaries", () => {
    const multi = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-p",
      "+q",
    ].join("\n");
    const chunks = splitPatchText(multi);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].startsWith("diff --git a/a.ts")).toBe(true);
    expect(chunks[1].startsWith("diff --git a/b.ts")).toBe(true);
    // Content lines mentioning diff --git (prefixed +/-/space) never split.
    const tricky = "diff --git a/x b/x\n@@ -1 +1 @@\n+diff --git fake\n context";
    expect(splitPatchText(tricky)).toHaveLength(1);
    // Bare patches without headers stay one chunk; blank input yields none.
    expect(splitPatchText("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b")).toHaveLength(1);
    expect(splitPatchText("\n \n")).toHaveLength(0);
  });

  test("diffPatchesOf reads the getNodeDiff envelope and drops malformed rows", () => {
    const body = {
      ok: true,
      data: {
        seq: 3,
        baseRef: "abc",
        patches: [
          { path: "a.ts", diff: "diff --git a/a.ts b/a.ts" },
          { path: "broken" },
          "junk",
        ],
      },
    };
    expect(diffPatchesOf(body)).toEqual([{ path: "a.ts", diff: "diff --git a/a.ts b/a.ts" }]);
    expect(diffPatchesOf({ patches: [{ path: "x", diff: "d" }] })).toEqual([{ path: "x", diff: "d" }]);
    expect(diffPatchesOf(null)).toEqual([]);
    expect(diffPatchesOf({ ok: false, error: { message: "no diff" } })).toEqual([]);
  });
});

describe("timeline", () => {
  test("nodeStateRowsOf tolerates envelopes, bare arrays, and snake_case rows", () => {
    const enveloped = nodeStateRowsOf({
      ok: true,
      data: [
        { node_id: "plan", iteration: 0, state: "finished", last_attempt: 1, updated_at_ms: 50, started_at_ms: 10, finished_at_ms: 40, label: "Plan" },
      ],
    });
    expect(enveloped).toEqual([
      { nodeId: "plan", iteration: 0, state: "finished", lastAttempt: 1, updatedAtMs: 50, label: "Plan", startedAtMs: 10, finishedAtMs: 40 },
    ]);
    const bare = nodeStateRowsOf([{ nodeId: "x", state: "failed" }, { state: "no-id" }, "junk"]);
    expect(bare).toEqual([{ nodeId: "x", iteration: 0, state: "failed" }]);
    expect(nodeStateRowsOf(undefined)).toEqual([]);
  });

  test("buildTimeline orders executions chronologically with loops unrolled", () => {
    const rows = [
      { nodeId: "review", iteration: 1, state: "finished", startedAtMs: 300, finishedAtMs: 350, updatedAtMs: 350 },
      { nodeId: "implement", iteration: 0, state: "finished", startedAtMs: 100, finishedAtMs: 200, updatedAtMs: 200 },
      { nodeId: "review", iteration: 0, state: "failed", startedAtMs: 210, finishedAtMs: 250, updatedAtMs: 250 },
      // Every _smithers_nodes row carries updatedAtMs from its insert — an
      // early insert time must NOT float a never-run node to the top.
      { nodeId: "publish", iteration: 0, state: "pending", updatedAtMs: 5 },
    ];
    const timeline = buildTimeline(rows, 1_000);
    expect(timeline.map((entry) => entry.key)).toEqual(["implement#0", "review#0", "review#1", "publish#0"]);
    expect(timeline[0].durationMs).toBe(100);
    expect(timeline[0].endMs).toBe(200);
    // Never-run rows sink to the end with no invented duration or end time.
    expect(timeline[3].durationMs).toBeUndefined();
    expect(timeline[3].endMs).toBeUndefined();
  });

  test("buildTimeline measures live rows against now and settles on updatedAtMs fallback", () => {
    const timeline = buildTimeline(
      [
        { nodeId: "live", iteration: 0, state: "in-progress", startedAtMs: 400, updatedAtMs: 450 },
        { nodeId: "settled", iteration: 0, state: "failed", startedAtMs: 100, updatedAtMs: 180 },
      ],
      1_000,
    );
    const live = timeline.find((entry) => entry.nodeId === "live")!;
    const settled = timeline.find((entry) => entry.nodeId === "settled")!;
    expect(live.durationMs).toBe(600);
    expect(live.endMs).toBeUndefined();
    // A settled row without finishedAtMs falls back to its last state write.
    expect(settled.endMs).toBe(180);
    expect(settled.durationMs).toBe(80);
  });

  test("buildTimeline breaks start-time ties deterministically by key", () => {
    const timeline = buildTimeline(
      [
        { nodeId: "b", iteration: 0, state: "finished", startedAtMs: 100, finishedAtMs: 110, updatedAtMs: 110 },
        { nodeId: "a", iteration: 0, state: "finished", startedAtMs: 100, finishedAtMs: 120, updatedAtMs: 120 },
      ],
      1_000,
    );
    expect(timeline.map((entry) => entry.key)).toEqual(["a#0", "b#0"]);
  });

  test("formatDurationMs renders compact durations and an honest dash", () => {
    expect(formatDurationMs(undefined)).toBe("—");
    expect(formatDurationMs(4_000)).toBe("4s");
    expect(formatDurationMs(125_000)).toBe("2m 05s");
    expect(formatDurationMs(3_780_000)).toBe("1h 3m");
  });
});

describe("run and task controls", () => {
  test("isPausable only offers pause for actively running runs", () => {
    expect(isPausable("running")).toBe(true);
    expect(isPausable("waiting-approval")).toBe(false);
    expect(isPausable("paused")).toBe(false);
    expect(isPausable("failed")).toBe(false);
    expect(isPausable(undefined)).toBe(false);
  });

  test("canRetryTask requires a failed node and a settled run", () => {
    expect(canRetryTask("failed", "failed")).toBe(true);
    expect(canRetryTask("failed", "finished")).toBe(true);
    expect(canRetryTask("failed", "cancelled")).toBe(true);
    expect(canRetryTask("failed", "paused")).toBe(true);
    expect(canRetryTask("failed", "waiting-quota")).toBe(true);
    // A live engine owns run state — the gateway RPC would refuse.
    expect(canRetryTask("failed", "running")).toBe(false);
    expect(canRetryTask("failed", "waiting-approval")).toBe(false);
    expect(canRetryTask("failed", "waiting-event")).toBe(false);
    expect(canRetryTask("failed", "waiting-timer")).toBe(false);
    // Only failed nodes are retryable.
    expect(canRetryTask("ok", "failed")).toBe(false);
    expect(canRetryTask("running", "failed")).toBe(false);
    expect(canRetryTask(undefined, "failed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Prometheus text parsing (the /metrics scrape behind the ops strip and the
// Metrics view).
// ---------------------------------------------------------------------------

describe("parsePrometheusText", () => {
  test("parses counters, gauges, and the TYPE map", () => {
    const scrape = parsePrometheusText(
      [
        "# HELP smithers_gateway_runs_started_total Gateway runs started",
        "# TYPE smithers_gateway_runs_started_total counter",
        "smithers_gateway_runs_started_total 12",
        "# TYPE smithers_gateway_connections_active gauge",
        "smithers_gateway_connections_active 3",
      ].join("\n"),
    );
    expect(scrape.types.smithers_gateway_runs_started_total).toBe("counter");
    expect(scrape.types.smithers_gateway_connections_active).toBe("gauge");
    expect(scrape.samples).toEqual([
      { name: "smithers_gateway_runs_started_total", labels: {}, value: 12 },
      { name: "smithers_gateway_connections_active", labels: {}, value: 3 },
    ]);
  });

  test("parses labels, +Inf, and float values", () => {
    const scrape = parsePrometheusText(
      [
        'smithers_agent_duration_ms_bucket{le="100",engine="codex",model="gpt-5.3"} 2',
        'smithers_agent_duration_ms_bucket{le="+Inf",engine="codex",model="gpt-5.3"} 5',
        'smithers_gateway_rpc_duration_ms_sum{method="listRuns",transport="http"} 194.46',
      ].join("\n"),
    );
    expect(scrape.samples[0].labels).toEqual({ le: "100", engine: "codex", model: "gpt-5.3" });
    expect(scrape.samples[1].labels.le).toBe("+Inf");
    expect(scrape.samples[1].value).toBe(5);
    expect(scrape.samples[2].value).toBeCloseTo(194.46);
  });

  test("unescapes quoted label values (backslash, quote, newline)", () => {
    const scrape = parsePrometheusText('m{path="a\\\\b",msg="say \\"hi\\"",text="line1\\nline2"} 1');
    expect(scrape.samples[0].labels).toEqual({ path: "a\\b", msg: 'say "hi"', text: "line1\nline2" });
  });

  test("a closing brace inside a label value does not truncate parsing", () => {
    const scrape = parsePrometheusText('m{expr="{a}"} 7');
    expect(scrape.samples[0]).toEqual({ name: "m", labels: { expr: "{a}" }, value: 7 });
  });

  test("skips malformed lines instead of failing the whole scrape", () => {
    const scrape = parsePrometheusText(
      ["not a metric line", "m{unclosed=\"x} 1", "ok_metric 2", "bad_value abc", ""].join("\n"),
    );
    expect(scrape.samples).toEqual([{ name: "ok_metric", labels: {}, value: 2 }]);
  });

  test("drops a trailing timestamp on sample lines", () => {
    const scrape = parsePrometheusText("m 42 1712345678000");
    expect(scrape.samples[0].value).toBe(42);
  });
});

describe("histogramQuantile", () => {
  const buckets = [
    { le: 100, count: 0 },
    { le: 200, count: 10 },
    { le: 400, count: 18 },
    { le: Infinity, count: 20 },
  ];

  test("interpolates within the target bucket", () => {
    // p50: rank 10 lands exactly at the 200ms bucket's cumulative count.
    expect(histogramQuantile(0.5, buckets)).toBe(200);
    // p90: rank 18 → the 400ms bucket's upper edge.
    expect(histogramQuantile(0.9, buckets)).toBe(400);
    // p75: rank 15 → interpolated between 200 and 400: 200 + 200*(5/8).
    expect(histogramQuantile(0.75, buckets)).toBeCloseTo(325);
  });

  test("a quantile landing in +Inf reports the highest finite bound", () => {
    expect(histogramQuantile(0.99, buckets)).toBe(400);
  });

  test("empty and zero-count histograms return undefined", () => {
    expect(histogramQuantile(0.5, [])).toBeUndefined();
    expect(
      histogramQuantile(0.5, [
        { le: 100, count: 0 },
        { le: Infinity, count: 0 },
      ]),
    ).toBeUndefined();
  });
});

describe("histogramStats", () => {
  const scrape = parsePrometheusText(
    [
      // codex histogram split across two operations — must merge per engine·model.
      'smithers_agent_duration_ms_bucket{le="100",engine="codex",model="gpt-5.3",operation="a"} 1',
      'smithers_agent_duration_ms_bucket{le="+Inf",engine="codex",model="gpt-5.3",operation="a"} 2',
      'smithers_agent_duration_ms_bucket{le="100",engine="codex",model="gpt-5.3",operation="b"} 3',
      'smithers_agent_duration_ms_bucket{le="+Inf",engine="codex",model="gpt-5.3",operation="b"} 4',
      // a second group with zero observations — must be dropped.
      'smithers_agent_duration_ms_bucket{le="100",engine="claude",model="fable"} 0',
      'smithers_agent_duration_ms_bucket{le="+Inf",engine="claude",model="fable"} 0',
    ].join("\n"),
  );

  test("groups by the requested labels, summing across the rest", () => {
    const stats = histogramStats(scrape, "smithers_agent_duration_ms", ["engine", "model"]);
    expect(stats).toHaveLength(1);
    expect(stats[0].key).toBe("codex · gpt-5.3");
    expect(stats[0].labels).toEqual({ engine: "codex", model: "gpt-5.3" });
    expect(stats[0].count).toBe(6);
    // rank 3 of 6 lands inside the merged 0–100 bucket (count 4): 100 * 3/4.
    expect(stats[0].p50).toBe(75);
    expect(stats[0].p95).toBeDefined();
  });

  test("an all-zero histogram (fresh gateway) yields no rows", () => {
    const empty = parsePrometheusText(
      ['x_bucket{le="100"} 0', 'x_bucket{le="+Inf"} 0'].join("\n"),
    );
    expect(histogramStats(empty, "x", [])).toEqual([]);
  });

  test("sorts groups by count descending", () => {
    const two = parsePrometheusText(
      [
        'd_bucket{le="+Inf",m="small"} 2',
        'd_bucket{le="+Inf",m="big"} 9',
        'd_bucket{le="100",m="small"} 2',
        'd_bucket{le="100",m="big"} 9',
      ].join("\n"),
    );
    expect(histogramStats(two, "d", ["m"]).map((stat) => stat.key)).toEqual(["big", "small"]);
  });
});

describe("metricValue and error counters", () => {
  const scrape = parsePrometheusText(
    [
      "smithers_gateway_runs_started_total 4",
      'smithers_gateway_rpc_calls_total{method="listRuns"} 16',
      'smithers_gateway_rpc_calls_total{method="getRun"} 15',
      "smithers_agent_errors_total 0",
      'smithers_gateway_errors_total{code="EPIPE"} 3',
      "smithers_agent_duration_ms_sum 120",
      "smithers_agent_duration_ms_count 2",
    ].join("\n"),
  );

  test("metricValue sums matching samples (optionally label-filtered)", () => {
    expect(metricValue(scrape, "smithers_gateway_runs_started_total")).toBe(4);
    expect(metricValue(scrape, "smithers_gateway_rpc_calls_total")).toBe(31);
    expect(metricValue(scrape, "smithers_gateway_rpc_calls_total", { method: "getRun" })).toBe(15);
    expect(metricValue(scrape, "nope")).toBeUndefined();
  });

  test("nonZeroErrorCounters keeps only non-zero error series, excluding histogram parts", () => {
    const errors = nonZeroErrorCounters(scrape);
    expect(errors).toHaveLength(1);
    expect(errors[0].name).toBe("smithers_gateway_errors_total");
    expect(errors[0].value).toBe(3);
  });

  test("describeErrorCounter translates known counters and prettifies the rest", () => {
    expect(describeErrorCounter("smithers_gateway_errors_total", { code: "Error", kind: "timer" })).toBe(
      "gateway internal errors · code Error · kind timer",
    );
    expect(describeErrorCounter("smithers_agent_errors_total", {})).toBe("agent errors");
    expect(describeErrorCounter("smithers_errors_total", {})).toBe("engine errors");
    // Unknown counters degrade to readable words, never raw snake_case.
    expect(describeErrorCounter("smithers_webhook_delivery_errors_total", {})).toBe("webhook delivery errors");
  });
});

describe("formatLatencyMs", () => {
  test("renders ms, seconds, and minutes at honest precision", () => {
    expect(formatLatencyMs(412)).toBe("412ms");
    expect(formatLatencyMs(1_240)).toBe("1.2s");
    expect(formatLatencyMs(45_000)).toBe("45s");
    expect(formatLatencyMs(95_000)).toBe("1m 35s");
    expect(formatLatencyMs(undefined)).toBe("—");
    expect(formatLatencyMs(Infinity)).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// Workspace ops stats (derived client-side from the fetched runs list).
// ---------------------------------------------------------------------------

describe("opsStats", () => {
  const noon = new Date(2026, 6, 10, 12, 0, 0).getTime();

  test("counts active, attention, live engines, and today's completions", () => {
    const stats = opsStats(
      [
        { status: "running", heartbeatAtMs: noon - 5_000 },
        { status: "running", heartbeatAtMs: noon - 120_000 }, // stale engine
        { status: "waiting-approval" },
        { status: "paused" },
        { status: "finished", finishedAtMs: noon - 3_600_000 },
        { status: "finished", finishedAtMs: noon - 24 * 3_600_000 }, // yesterday
        { status: "failed", finishedAtMs: noon - 60_000 },
        { status: "cancelled", finishedAtMs: noon - 60_000 }, // cancelled ≠ completed/failed
      ],
      noon,
    );
    expect(stats).toEqual({ active: 2, attention: 2, enginesLive: 1, completedToday: 1, failedToday: 1 });
  });

  test("tolerates snake_case rows and missing fields", () => {
    const stats = opsStats(
      [
        { status: "running", heartbeat_at_ms: noon - 1_000 },
        { status: "finished", finished_at_ms: noon - 1_000 },
        { status: "finished" }, // no finish time — not counted as today
      ],
      noon,
    );
    expect(stats.enginesLive).toBe(1);
    expect(stats.completedToday).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Crons. Real cronList responses re-list each cron once per registered
// workflow sharing the DB adapter (hundreds of duplicate rows whose
// `workflow` field is the iterating workflow's key, not the cron's) — the
// reader dedupes by cronId and trusts workflowPath.
// ---------------------------------------------------------------------------

describe("cronRowsOf", () => {
  test("dedupes duplicated cron rows and derives workflow from workflowPath", () => {
    const rows = cronRowsOf({
      ok: true,
      data: [
        {
          cronId: "c-1",
          pattern: "*/3 * * * *",
          workflowPath: ".smithers/workflows/test-fortress-monitor.tsx",
          workflow: "audit", // per-workflow duplicate noise — not the truth
          enabled: true,
          lastRunAtMs: 100,
          nextRunAtMs: 200,
          errorJson: null,
        },
        {
          cronId: "c-1",
          pattern: "*/3 * * * *",
          workflowPath: ".smithers/workflows/test-fortress-monitor.tsx",
          workflow: "audit-burndown",
          enabled: true,
        },
        {
          cronId: "c-2",
          pattern: "*/15 * * * *",
          workflowPath: ".smithers/workflows/ticket-fleet.tsx",
          enabled: 1, // sqlite boolean
          nextRunAtMs: 150,
          errorJson: '{"message":"spawn failed"}',
        },
      ],
    });
    expect(rows).toHaveLength(2);
    // enabled crons sort by soonest next fire
    expect(rows[0]).toMatchObject({ cronId: "c-2", workflow: "ticket-fleet", enabled: true, error: "spawn failed" });
    expect(rows[1]).toMatchObject({
      cronId: "c-1",
      workflow: "test-fortress-monitor",
      pattern: "*/3 * * * *",
      lastRunAtMs: 100,
      nextRunAtMs: 200,
    });
    expect(rows[1].error).toBeUndefined();
  });

  test("keeps a non-JSON errorJson string verbatim and sinks disabled crons", () => {
    const rows = cronRowsOf([
      { cronId: "a", pattern: "* * * * *", enabled: false, errorJson: "plain failure text", nextRunAtMs: 1 },
      { cronId: "b", pattern: "* * * * *", enabled: true, nextRunAtMs: 500 },
    ]);
    expect(rows.map((row) => row.cronId)).toEqual(["b", "a"]);
    expect(rows[1].error).toBe("plain failure text");
  });

  test("nextCron picks the soonest enabled cron with a scheduled fire", () => {
    const crons = cronRowsOf([
      { cronId: "a", pattern: "*", enabled: false, nextRunAtMs: 10 },
      { cronId: "b", pattern: "*", enabled: true, nextRunAtMs: 300 },
      { cronId: "c", pattern: "*", enabled: true, nextRunAtMs: 200 },
      { cronId: "d", pattern: "*", enabled: true },
    ]);
    expect(nextCron(crons)?.cronId).toBe("c");
    expect(nextCron([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scores.
// ---------------------------------------------------------------------------

describe("scores", () => {
  const body = {
    ok: true,
    data: [
      { nodeId: "verify", iteration: 0, attempt: 1, scorerId: "s1", scorerName: "tests-pass", score: 1, scoredAtMs: 100 },
      { nodeId: "implement", iteration: 0, attempt: 0, scorerId: "s2", scorerName: "diff-quality", score: 0.62, reason: "minor nits", scoredAtMs: 300 },
      { nodeId: "implement", iteration: 1, attempt: 0, scorerId: "s2", scorerName: "diff-quality", score: 0.31, scoredAtMs: 200 },
    ],
  };

  test("scoreRowsOf reads the wire rows, newest first, tolerating snake_case", () => {
    const rows = scoreRowsOf(body);
    expect(rows.map((row) => row.scoredAtMs)).toEqual([300, 200, 100]);
    expect(rows[0]).toMatchObject({ nodeId: "implement", scorerName: "diff-quality", score: 0.62, reason: "minor nits" });
    const snake = scoreRowsOf([{ node_id: "n", scorer_id: "x", scorer_name: "X", score: 0.5 }]);
    expect(snake[0]).toMatchObject({ nodeId: "n", scorerName: "X", iteration: 0, attempt: 0 });
  });

  test("rows without a nodeId or numeric score are dropped", () => {
    expect(scoreRowsOf({ ok: true, data: [{ score: 1 }, { nodeId: "n" }, "junk"] })).toEqual([]);
  });

  test("scoreTone thresholds a normalized [0,1] score", () => {
    expect(scoreTone(1)).toBe("ok");
    expect(scoreTone(0.8)).toBe("ok");
    expect(scoreTone(0.79)).toBe("waiting");
    expect(scoreTone(0.5)).toBe("waiting");
    expect(scoreTone(0.49)).toBe("failed");
    expect(scoreTone(0)).toBe("failed");
  });

  test("formatScore renders two decimals for fractions, bare integers", () => {
    expect(formatScore(0.617)).toBe("0.62");
    expect(formatScore(1)).toBe("1");
    expect(formatScore(0)).toBe("0");
    expect(formatScore(NaN)).toBe("—");
  });

  test("scoresSummary averages and scoresForNode filters", () => {
    const rows = scoreRowsOf(body);
    const summary = scoresSummary(rows);
    expect(summary.count).toBe(3);
    expect(summary.avg).toBeCloseTo((1 + 0.62 + 0.31) / 3);
    expect(scoresSummary([])).toEqual({ count: 0, avg: 0 });
    expect(scoresForNode(rows, "implement")).toHaveLength(2);
    expect(scoresForNode(rows, "verify")).toHaveLength(1);
    expect(scoresForNode(rows, undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Accounts / tickets / generic envelope.
// ---------------------------------------------------------------------------

describe("ops strip readers", () => {
  test("dataRowsOf accepts {ok,data} envelopes and bare arrays", () => {
    expect(dataRowsOf({ ok: true, data: [1, 2] })).toEqual([1, 2]);
    expect(dataRowsOf([3])).toEqual([3]);
    expect(dataRowsOf({ ok: false })).toEqual([]);
    expect(dataRowsOf(null)).toEqual([]);
  });

  test("accountRowsOf marks accounts ready when a config dir or API key exists", () => {
    const rows = accountRowsOf({
      ok: true,
      data: [
        { label: "kimi-1", provider: "kimi", hasConfigDir: true, hasApiKey: false, model: null },
        { label: "gemini-1", provider: "gemini-api", hasConfigDir: false, hasApiKey: false, model: "gemini-3.1-pro" },
        { label: "keyed", provider: "openai", has_config_dir: false, has_api_key: true },
        { provider: "junk-without-label" },
      ],
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.ready)).toEqual([true, false, true]);
    expect(rows[1].model).toBe("gemini-3.1-pro");
  });

  test("openTicketCount treats done/closed/resolved as closed, unknown as open", () => {
    expect(
      openTicketCount({
        ok: true,
        data: [
          { path: "a", status: "open" },
          { path: "b", status: "Done" },
          { path: "c", status: null },
          { path: "d", status: "in-progress" },
          { path: "e", status: "closed" },
        ],
      }),
    ).toBe(3);
    expect(openTicketCount({ ok: true, data: [] })).toBe(0);
  });
});
