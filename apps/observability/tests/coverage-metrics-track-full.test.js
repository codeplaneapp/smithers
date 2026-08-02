import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { metricsServiceAdapter, trackEvent } from "@smthrs/observability/metrics";

/** @param {any} event */
function runTrack(event) {
  return Effect.runPromise(trackEvent(event));
}
function snapshot() {
  return Effect.runPromise(metricsServiceAdapter.snapshot());
}
/** @param {Record<string, string>} labels */
function labelsKey(labels) {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
}
/** @param {string} name @param {Record<string, string>} [labels] */
function key(name, labels = {}) {
  return `${name}|${labelsKey(labels)}`;
}
/** @param {Map<string, any>} before @param {Map<string, any>} after @param {string} name @param {Record<string, string>} [labels] */
function delta(before, after, name, labels = {}) {
  const k = key(name, labels);
  return (after.get(k)?.value ?? 0) - (before.get(k)?.value ?? 0);
}
/** @param {Map<string, any>} before @param {Map<string, any>} after @param {string} name @param {Record<string, string>} [labels] */
function histCount(before, after, name, labels = {}) {
  const k = key(name, labels);
  return (after.get(k)?.count ?? 0) - (before.get(k)?.count ?? 0);
}

describe("trackEvent — sandbox lifecycle", () => {
  test("SandboxCreated with runtime increments created_total and active gauge by runtime", async () => {
    const before = await snapshot();
    await runTrack({ type: "SandboxCreated", runId: "r", runtime: "docker", timestampMs: Date.now() });
    const after = await snapshot();
    expect(delta(before, after, "smithers.events.emitted_total")).toBe(1);
    expect(delta(before, after, "smithers.sandbox.created_total", { runtime: "docker" })).toBe(1);
    expect(delta(before, after, "smithers.sandbox.active", { runtime: "docker" })).toBe(1);
  });
  test("SandboxCreated without runtime uses the unlabeled counters", async () => {
    const before = await snapshot();
    await runTrack({ type: "SandboxCreated", runId: "r", runtime: "", timestampMs: Date.now() });
    const after = await snapshot();
    expect(delta(before, after, "smithers.sandbox.created_total")).toBe(1);
    expect(delta(before, after, "smithers.sandbox.active")).toBe(1);
  });
  test("SandboxShipped records the bundle size histogram", async () => {
    const before = await snapshot();
    await runTrack({ type: "SandboxShipped", runId: "r", bundleSizeBytes: 2048, timestampMs: Date.now() });
    const after = await snapshot();
    expect(histCount(before, after, "smithers.sandbox.bundle_size_bytes")).toBe(1);
  });
  test("SandboxBundleReceived records bundle size and patch count", async () => {
    const before = await snapshot();
    await runTrack({
      type: "SandboxBundleReceived",
      runId: "r",
      bundleSizeBytes: 1024,
      patchCount: 7,
      timestampMs: Date.now(),
    });
    const after = await snapshot();
    expect(histCount(before, after, "smithers.sandbox.bundle_size_bytes")).toBe(1);
    expect(histCount(before, after, "smithers.sandbox.patch_count")).toBe(1);
  });
  test("SandboxCompleted with runtime tags completed_total and decrements active", async () => {
    const before = await snapshot();
    await runTrack({
      type: "SandboxCompleted",
      runId: "r",
      runtime: "docker",
      status: "succeeded",
      durationMs: 500,
      timestampMs: Date.now(),
    });
    const after = await snapshot();
    expect(delta(before, after, "smithers.sandbox.completed_total", { runtime: "docker", status: "succeeded" })).toBe(
      1,
    );
    expect(delta(before, after, "smithers.sandbox.active", { runtime: "docker" })).toBe(-1);
    expect(histCount(before, after, "smithers.sandbox.duration_ms")).toBe(1);
  });
  test("SandboxCompleted without runtime tags completed_total by status", async () => {
    const before = await snapshot();
    await runTrack({
      type: "SandboxCompleted",
      runId: "r",
      runtime: "",
      status: "failed",
      durationMs: 10,
      timestampMs: Date.now(),
    });
    const after = await snapshot();
    expect(delta(before, after, "smithers.sandbox.completed_total", { status: "failed" })).toBe(1);
    expect(delta(before, after, "smithers.sandbox.active")).toBe(-1);
  });
  test("SandboxFailed increments errors", async () => {
    const before = await snapshot();
    await runTrack({ type: "SandboxFailed", runId: "r", timestampMs: Date.now() });
    const after = await snapshot();
    expect(delta(before, after, "smithers.errors.total")).toBe(1);
  });
  test("SandboxDiffReviewRequested and SandboxDiffAccepted record patch counts; Rejected errors", async () => {
    const before = await snapshot();
    await runTrack({ type: "SandboxDiffReviewRequested", runId: "r", patchCount: 3, timestampMs: Date.now() });
    await runTrack({ type: "SandboxDiffAccepted", runId: "r", patchCount: 3, timestampMs: Date.now() });
    await runTrack({ type: "SandboxDiffRejected", runId: "r", patchCount: 3, timestampMs: Date.now() });
    const after = await snapshot();
    expect(histCount(before, after, "smithers.sandbox.patch_count")).toBe(2);
    expect(delta(before, after, "smithers.errors.total")).toBe(1);
  });
});

describe("trackEvent — run continuation, approvals, misc", () => {
  test("RunContinuedAsNew with ancestryDepth records carried-state and ancestry histograms", async () => {
    const before = await snapshot();
    await runTrack({
      type: "RunContinuedAsNew",
      runId: "r",
      carriedStateSize: 4096,
      ancestryDepth: 5,
      timestampMs: Date.now(),
    });
    const after = await snapshot();
    expect(delta(before, after, "smithers.runs.continued_total")).toBe(1);
    expect(delta(before, after, "smithers.runs.active")).toBe(-1);
    expect(histCount(before, after, "smithers.runs.carried_state_bytes")).toBe(1);
    expect(histCount(before, after, "smithers.runs.ancestry_depth")).toBe(1);
  });
  test("RunContinuedAsNew without ancestryDepth omits the ancestry histogram", async () => {
    const before = await snapshot();
    await runTrack({ type: "RunContinuedAsNew", runId: "r", carriedStateSize: 8, timestampMs: Date.now() });
    const after = await snapshot();
    expect(delta(before, after, "smithers.runs.continued_total")).toBe(1);
    expect(histCount(before, after, "smithers.runs.ancestry_depth")).toBe(0);
  });
  test("ApprovalAutoApproved increments granted only", async () => {
    const before = await snapshot();
    await runTrack({ type: "ApprovalAutoApproved", runId: "r", nodeId: "n", timestampMs: Date.now() });
    const after = await snapshot();
    expect(delta(before, after, "smithers.approvals.granted")).toBe(1);
  });
  test("NodeCancelled decrements active nodes", async () => {
    const before = await snapshot();
    await runTrack({ type: "NodeCancelled", runId: "r", nodeId: "n", timestampMs: Date.now() });
    const after = await snapshot();
    expect(delta(before, after, "smithers.nodes.active")).toBe(-1);
  });
  test("RunForked, ReplayStarted and SnapshotCaptured just count the event", async () => {
    const before = await snapshot();
    await runTrack({ type: "RunForked", runId: "r", timestampMs: Date.now() });
    await runTrack({ type: "ReplayStarted", runId: "r", timestampMs: Date.now() });
    await runTrack({ type: "SnapshotCaptured", runId: "r", frameNo: 1, timestampMs: Date.now() });
    const after = await snapshot();
    expect(delta(before, after, "smithers.events.emitted_total")).toBe(3);
  });
});

describe("trackEvent — context window buckets", () => {
  /** @param {number} inputTokens @param {string} bucket */
  async function assertBucket(inputTokens, bucket) {
    const labels = { agent: "a", model: "m" };
    const before = await snapshot();
    await runTrack({
      type: "TokenUsageReported",
      runId: "r",
      model: "m",
      agent: "a",
      inputTokens,
      outputTokens: 0,
      timestampMs: Date.now(),
    });
    const after = await snapshot();
    expect(delta(before, after, "smithers.tokens.context_window_bucket_total", { ...labels, bucket })).toBe(1);
  }
  test("classifies < 50k", () => assertBucket(40_000, "lt_50k"));
  test("classifies 50k-100k", () => assertBucket(75_000, "gte_50k_lt_100k"));
  test("classifies 200k-500k", () => assertBucket(300_000, "gte_200k_lt_500k"));
  test("classifies 500k-1m", () => assertBucket(600_000, "gte_500k_lt_1m"));
  test("classifies >= 1m", () => assertBucket(1_500_000, "gte_1m"));
  test("falls back to cached input tokens when inputTokens is zero", async () => {
    const labels = { agent: "a", model: "m" };
    const before = await snapshot();
    await runTrack({
      type: "TokenUsageReported",
      runId: "r",
      model: "m",
      agent: "a",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 10_000,
      timestampMs: Date.now(),
    });
    const after = await snapshot();
    expect(delta(before, after, "smithers.tokens.context_window_bucket_total", { ...labels, bucket: "lt_50k" })).toBe(
      1,
    );
    expect(delta(before, after, "smithers.tokens.cache_read_total", labels)).toBe(20_000);
    expect(delta(before, after, "smithers.tokens.cache_write_total", labels)).toBe(10_000);
  });
});

describe("trackEvent — agent events", () => {
  test("started emits a sessions_total with status=started", async () => {
    const before = await snapshot();
    await runTrack({
      type: "AgentEvent",
      runId: "r",
      engine: "codex",
      event: { type: "started", engine: "codex-cli", resume: true, timestampMs: Date.now() },
      timestampMs: Date.now(),
    });
    const after = await snapshot();
    expect(
      delta(before, after, "smithers.agent_sessions_total", {
        engine: "codex-cli",
        source: "event",
        status: "started",
        resume: "true",
      }),
    ).toBe(1);
  });
  test("action with level=error emits an errors_total", async () => {
    const before = await snapshot();
    await runTrack({
      type: "AgentEvent",
      runId: "r",
      event: {
        type: "action",
        engine: "e",
        action: { kind: "tool_call", title: "run" },
        level: "error",
        phase: "running",
        entryType: "tool",
        ok: false,
        timestampMs: Date.now(),
      },
      timestampMs: Date.now(),
    });
    const after = await snapshot();
    expect(
      delta(before, after, "smithers.agent_errors_total", {
        engine: "e",
        source: "event",
        event_type: "action",
        action_kind: "tool_call",
      }),
    ).toBe(1);
  });
  test("action with a retry-key detail emits a retries_total", async () => {
    const before = await snapshot();
    await runTrack({
      type: "AgentEvent",
      runId: "r",
      event: {
        type: "action",
        engine: "e",
        action: { kind: "wait", title: "waiting", detail: { retryAfter: 1000 } },
        level: "info",
        phase: "running",
        entryType: "log",
        ok: true,
        timestampMs: Date.now(),
      },
      timestampMs: Date.now(),
    });
    const after = await snapshot();
    expect(
      delta(before, after, "smithers.agent_retries_total", { engine: "e", source: "event", reason: "event_signal" }),
    ).toBe(1);
  });
  test("action with a retry phrase in the title emits a retries_total", async () => {
    const before = await snapshot();
    await runTrack({
      type: "AgentEvent",
      runId: "r",
      event: {
        type: "action",
        engine: "e",
        action: { kind: "wait", title: "rate limit hit", detail: {} },
        level: "info",
        phase: "running",
        entryType: "log",
        ok: true,
        timestampMs: Date.now(),
      },
      timestampMs: Date.now(),
    });
    const after = await snapshot();
    expect(
      delta(before, after, "smithers.agent_retries_total", { engine: "e", source: "event", reason: "event_signal" }),
    ).toBe(1);
  });
  test("action without retry signal does not emit retries", async () => {
    const before = await snapshot();
    await runTrack({
      type: "AgentEvent",
      runId: "r",
      event: {
        type: "action",
        engine: "e",
        action: { kind: "read", title: "reading file", detail: {} },
        level: "info",
        phase: "running",
        entryType: "tool",
        ok: true,
        timestampMs: Date.now(),
      },
      timestampMs: Date.now(),
    });
    const after = await snapshot();
    expect(
      delta(before, after, "smithers.agent_retries_total", { engine: "e", source: "event", reason: "event_signal" }),
    ).toBe(0);
  });
  test("completed ok=true with usage emits sessions and per-kind token totals", async () => {
    const before = await snapshot();
    await runTrack({
      type: "AgentEvent",
      runId: "r",
      event: {
        type: "completed",
        engine: "e",
        ok: true,
        resume: false,
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, reasoningTokens: 20 },
        timestampMs: Date.now(),
      },
      timestampMs: Date.now(),
    });
    const after = await snapshot();
    expect(
      delta(before, after, "smithers.agent_sessions_total", {
        engine: "e",
        source: "event",
        status: "completed",
        resume: "false",
      }),
    ).toBe(1);
    expect(delta(before, after, "smithers.agent_tokens_total", { engine: "e", source: "event", kind: "input" })).toBe(
      100,
    );
    expect(delta(before, after, "smithers.agent_tokens_total", { engine: "e", source: "event", kind: "output" })).toBe(
      50,
    );
    expect(
      delta(before, after, "smithers.agent_tokens_total", { engine: "e", source: "event", kind: "reasoning" }),
    ).toBe(20);
    expect(delta(before, after, "smithers.agent_tokens_total", { engine: "e", source: "event", kind: "total" })).toBe(
      185,
    );
  });
  test("completed with snake_case + nested usage aliases resolves token totals", async () => {
    const before = await snapshot();
    await runTrack({
      type: "AgentEvent",
      runId: "r",
      event: {
        type: "completed",
        engine: "e",
        ok: true,
        resume: false,
        usage: {
          input_tokens: 200,
          completion_tokens: 40,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 15,
          outputTokenDetails: { reasoningTokens: 8 },
          totalTokens: 300,
        },
        timestampMs: Date.now(),
      },
      timestampMs: Date.now(),
    });
    const after = await snapshot();
    expect(delta(before, after, "smithers.agent_tokens_total", { engine: "e", source: "event", kind: "input" })).toBe(
      200,
    );
    expect(delta(before, after, "smithers.agent_tokens_total", { engine: "e", source: "event", kind: "output" })).toBe(
      40,
    );
    expect(
      delta(before, after, "smithers.agent_tokens_total", { engine: "e", source: "event", kind: "reasoning" }),
    ).toBe(8);
    expect(delta(before, after, "smithers.agent_tokens_total", { engine: "e", source: "event", kind: "total" })).toBe(
      300,
    );
  });
  test("completed ok=false with a retry phrase emits errors and retries; engine falls back to unknown", async () => {
    const before = await snapshot();
    await runTrack({
      type: "AgentEvent",
      runId: "r",
      event: { type: "completed", ok: false, resume: false, error: "backoff and retry", timestampMs: Date.now() },
      timestampMs: Date.now(),
    });
    const after = await snapshot();
    expect(
      delta(before, after, "smithers.agent_sessions_total", {
        engine: "unknown",
        source: "event",
        status: "failed",
        resume: "false",
      }),
    ).toBe(1);
    expect(
      delta(before, after, "smithers.agent_errors_total", {
        engine: "unknown",
        source: "event",
        event_type: "completed",
      }),
    ).toBe(1);
    expect(
      delta(before, after, "smithers.agent_retries_total", {
        engine: "unknown",
        source: "event",
        reason: "event_signal",
      }),
    ).toBe(1);
  });
});
