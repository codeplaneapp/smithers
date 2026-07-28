import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
// Relative imports so the WORKTREE units under test are exercised (a package
// barrel would resolve to whatever install node_modules points at).
import { SmithersDb } from "../../../packages/db/src/adapter.js";
import { ensureSmithersTables } from "../../../packages/db/src/ensure.js";
import {
  RUN_STATUS_RECENT_WINDOW_MS,
  buildRunStatusSummary,
  isQuotaAttemptFailure,
  parseFrameDependsOn,
  renderRunStatusHuman,
  runStatusCtaCommands,
  summarizeRunStatus,
} from "../src/run-status.js";

const NOW = Date.UTC(2026, 6, 12, 12, 0, 0);
const MIN = 60_000;

function createMemoryDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function seedRun(adapter, runId, overrides = {}) {
  await adapter.insertRun({
    runId,
    workflowName: "status-fixture",
    workflowPath: "workflow.tsx",
    status: "running",
    createdAtMs: NOW - 60 * MIN,
    startedAtMs: NOW - 59 * MIN,
    finishedAtMs: null,
    heartbeatAtMs: NOW - 1_000,
    ...overrides,
  });
}

async function seedNode(adapter, runId, nodeId, state, updatedAtMs, iteration = 0) {
  await adapter.insertNode({
    runId,
    nodeId,
    iteration,
    state,
    lastAttempt: 1,
    updatedAtMs,
    outputTable: "outputs",
    label: nodeId,
  });
}

async function seedAttempt(adapter, runId, nodeId, overrides = {}) {
  await adapter.insertAttempt({
    runId,
    nodeId,
    iteration: 0,
    attempt: 1,
    state: "finished",
    startedAtMs: NOW - 5 * MIN,
    finishedAtMs: NOW - 2 * MIN,
    ...overrides,
  });
}

function agentMeta(engine, model, extra = {}) {
  return JSON.stringify({ agentEngine: engine, agentModel: model, ...extra });
}

const QUOTA_RESET_AT = NOW + 42 * MIN;
const QUOTA_ERROR_JSON = JSON.stringify({
  code: "AGENT_QUOTA_EXCEEDED",
  message: "hit a provider usage/quota limit",
  details: { failureQuota: true, quotaResetAtMs: QUOTA_RESET_AT },
});

describe("summarizeRunStatus verdicts (real sqlite rows)", () => {
  test("running-healthy: in-progress work plus recent finishes, with a codex/claude model mix", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await seedRun(adapter, "r1", {
        configJson: JSON.stringify({
          startedBy: { harness: "codex", sessionId: "thread-1", prompt: "private launch context", detected: true },
        }),
      });
      // 3 finished: two inside the 10m window, one old (outside).
      await seedNode(adapter, "r1", "plan", "finished", NOW - 40 * MIN);
      await seedNode(adapter, "r1", "impl-1", "finished", NOW - 4 * MIN);
      await seedNode(adapter, "r1", "impl-2", "finished", NOW - 2 * MIN);
      await seedNode(adapter, "r1", "impl-3", "in-progress", NOW - 6 * MIN);
      await seedNode(adapter, "r1", "review", "pending", NOW - 6 * MIN);
      await seedNode(adapter, "r1", "ship", "pending", NOW - 6 * MIN);
      await seedAttempt(adapter, "r1", "plan", { metaJson: agentMeta("codex", "gpt-5.6-luna") });
      await seedAttempt(adapter, "r1", "impl-1", { metaJson: agentMeta("codex", "gpt-5.6-luna") });
      await seedAttempt(adapter, "r1", "impl-2", { metaJson: agentMeta("claude", "claude-sonnet-5") });
      await seedAttempt(adapter, "r1", "impl-3", {
        state: "in-progress",
        startedAtMs: NOW - 6 * MIN,
        finishedAtMs: null,
        metaJson: agentMeta("codex", "gpt-5.6-luna"),
      });

      const summary = await buildRunStatusSummary(adapter, "r1", { nowMs: NOW });

      expect(summary.verdict).toBe("running-healthy");
      expect(summary.counts).toMatchObject({
        finished: 3,
        inProgress: 1,
        pending: 2,
        failed: 0,
        total: 6,
      });
      expect(summary.modelMix).toEqual([
        { engine: "codex", model: "gpt-5.6-luna", attempts: 3, quotaParked: false },
        { engine: "claude", model: "claude-sonnet-5", attempts: 1, quotaParked: false },
      ]);
      expect(summary.throughput).toMatchObject({
        recentFinished: 2,
        totalFinished: 3,
        windowMs: RUN_STATUS_RECENT_WINDOW_MS,
      });
      // Bottleneck is the serialized in-progress node, not a wall of ids.
      expect(summary.bottleneck).toEqual([
        { nodeId: "impl-3", iteration: 0, state: "in-progress", detail: "running 6m 0s" },
      ]);
      expect(summary.quota).toBeNull();
      expect(summary.startedBy).toEqual({ harness: "codex", sessionId: "thread-1", detected: true });

      const human = renderRunStatusHuman(summary);
      const lines = human.split("\n");
      expect(lines.length).toBeLessThanOrEqual(8);
      expect(lines[0]).toContain("running-healthy");
      expect(human).toContain("codex/gpt-5.6-luna x3");
      expect(human).toContain("claude/claude-sonnet-5 x1");
      expect(human).toContain("2 finished in last 10m");
      expect(human).toContain("impl-3");
      expect(human).toContain("Started  codex · thread-1");
      expect(human).not.toContain("private launch context");
    } finally {
      sqlite.close();
    }
  });

  test("blocked: nothing running and pending work gated by a failed dependency (frame dependsOn names the gate)", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await seedRun(adapter, "r2");
      await seedNode(adapter, "r2", "build", "finished", NOW - 30 * MIN);
      await seedNode(adapter, "r2", "test", "failed", NOW - 20 * MIN);
      await seedNode(adapter, "r2", "deploy", "pending", NOW - 20 * MIN);
      await seedNode(adapter, "r2", "announce", "pending", NOW - 20 * MIN);
      await seedAttempt(adapter, "r2", "test", {
        state: "failed",
        finishedAtMs: NOW - 20 * MIN,
        metaJson: agentMeta("claude", "claude-sonnet-5"),
        errorJson: JSON.stringify({ code: "TASK_FAILED", message: "bun test exited 1: 3 failures" }),
      });

      const nodes = await adapter.listNodes("r2");
      const attempts = await adapter.listAttemptsForRun("r2");
      const run = await adapter.getRun("r2");
      const deps = new Map([
        ["deploy", { dependsOn: ["test"], continueOnFail: false }],
        ["announce", { dependsOn: ["deploy"], continueOnFail: false }],
      ]);
      const summary = summarizeRunStatus({ run, nodes, attempts, nowMs: NOW, deps });

      expect(summary.verdict).toBe("blocked");
      expect(summary.reason).toContain("stuck behind 1 failed node(s)");
      expect(summary.counts).toMatchObject({ finished: 1, inProgress: 0, pending: 2, failed: 1 });
      expect(summary.bottleneck).toEqual([
        {
          nodeId: "test",
          iteration: 0,
          state: "failed",
          detail: "bun test exited 1: 3 failures",
        },
      ]);

      // Fallback without dependency metadata still calls it blocked
      // (failures alongside idle pending work).
      const noDeps = summarizeRunStatus({ run, nodes, attempts, nowMs: NOW });
      expect(noDeps.verdict).toBe("blocked");
      expect(noDeps.bottleneck.map((b) => b.nodeId)).toEqual(["test"]);
    } finally {
      sqlite.close();
    }
  });

  test("deps that do NOT gate the pending work leave the verdict stalled, not blocked", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await seedRun(adapter, "r2b");
      await seedNode(adapter, "r2b", "optional", "failed", NOW - 30 * MIN);
      await seedNode(adapter, "r2b", "main", "pending", NOW - 30 * MIN);
      const summary = summarizeRunStatus({
        run: await adapter.getRun("r2b"),
        nodes: await adapter.listNodes("r2b"),
        attempts: await adapter.listAttemptsForRun("r2b"),
        nowMs: NOW,
        // main does not depend on the failed node.
        deps: new Map([["main", { dependsOn: [], continueOnFail: false }]]),
      });
      expect(summary.verdict).toBe("stalled");
    } finally {
      sqlite.close();
    }
  });

  test("waiting-quota: run parked by the engine carries the reset time from the run row", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await seedRun(adapter, "r3", {
        status: "waiting-quota",
        heartbeatAtMs: null,
        errorJson: JSON.stringify({ quotaBlockedCount: 2, resetAtMs: QUOTA_RESET_AT }),
      });
      await seedNode(adapter, "r3", "a", "finished", NOW - 15 * MIN);
      await seedNode(adapter, "r3", "b", "pending", NOW - 5 * MIN);

      const summary = await buildRunStatusSummary(adapter, "r3", { nowMs: NOW });

      expect(summary.verdict).toBe("waiting-quota");
      expect(summary.reason).toContain("2 task(s) quota-parked");
      expect(summary.quota).toMatchObject({ resetAtMs: QUOTA_RESET_AT });
      expect(summary.reason).toContain(new Date(QUOTA_RESET_AT).toISOString());
    } finally {
      sqlite.close();
    }
  });

  test("waiting-quota: a still-parked quota attempt flags the verdict and the model-mix group even when the run row says running", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await seedRun(adapter, "r4");
      await seedNode(adapter, "r4", "done-1", "finished", NOW - 3 * MIN);
      // Quota-parked node: newest attempt failed on quota, node not finished.
      await seedNode(adapter, "r4", "parked", "pending", NOW - 4 * MIN);
      await seedAttempt(adapter, "r4", "done-1", { metaJson: agentMeta("codex", "gpt-5.6-luna") });
      await seedAttempt(adapter, "r4", "parked", {
        state: "failed",
        finishedAtMs: NOW - 4 * MIN,
        metaJson: agentMeta("claude", "claude-fable-5"),
        errorJson: QUOTA_ERROR_JSON,
      });

      const summary = await buildRunStatusSummary(adapter, "r4", { nowMs: NOW });

      expect(summary.verdict).toBe("waiting-quota");
      expect(summary.quota).toEqual({
        parkedCount: 1,
        parkedNodeIds: ["parked"],
        resetAtMs: QUOTA_RESET_AT,
      });
      const claude = summary.modelMix.find((m) => m.model === "claude-fable-5");
      expect(claude?.quotaParked).toBe(true);
      const codex = summary.modelMix.find((m) => m.model === "gpt-5.6-luna");
      expect(codex?.quotaParked).toBe(false);
      expect(summary.bottleneck).toEqual([
        {
          nodeId: "parked",
          iteration: 0,
          state: "quota-parked",
          detail: `resets ${new Date(QUOTA_RESET_AT).toISOString()}`,
        },
      ]);
      expect(renderRunStatusHuman(summary)).toContain("[quota-parked]");
    } finally {
      sqlite.close();
    }
  });

  test("a quota failure that was later retried to success is NOT parked", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await seedRun(adapter, "r5");
      await seedNode(adapter, "r5", "recovered", "finished", NOW - 2 * MIN);
      await seedNode(adapter, "r5", "next", "in-progress", NOW - MIN);
      await seedAttempt(adapter, "r5", "recovered", {
        attempt: 1,
        state: "failed",
        finishedAtMs: NOW - 8 * MIN,
        errorJson: QUOTA_ERROR_JSON,
        metaJson: agentMeta("claude", "claude-fable-5"),
      });
      await seedAttempt(adapter, "r5", "recovered", {
        attempt: 2,
        state: "finished",
        metaJson: agentMeta("claude", "claude-fable-5"),
      });

      const summary = await buildRunStatusSummary(adapter, "r5", { nowMs: NOW });

      expect(summary.verdict).toBe("running-healthy");
      expect(summary.quota).toBeNull();
      expect(summary.modelMix).toEqual([
        { engine: "claude", model: "claude-fable-5", attempts: 2, quotaParked: false },
      ]);
    } finally {
      sqlite.close();
    }
  });

  test("terminal and paused runs map straight to done / cancelled / failed / paused", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      const cases = [
        ["done-run", { status: "finished", finishedAtMs: NOW - MIN }, "done"],
        ["cancelled-run", { status: "cancelled", finishedAtMs: NOW - MIN }, "cancelled"],
        [
          "failed-run",
          {
            status: "failed",
            finishedAtMs: NOW - MIN,
            errorJson: JSON.stringify({ code: "TASK_FAILED", message: "boom" }),
          },
          "failed",
        ],
        ["paused-run", { status: "paused" }, "paused"],
      ];
      for (const [runId, overrides, expected] of cases) {
        await seedRun(adapter, runId, { heartbeatAtMs: null, ...overrides });
        const summary = await buildRunStatusSummary(adapter, runId, { nowMs: NOW });
        expect(summary.verdict).toBe(expected);
      }
      const failed = await buildRunStatusSummary(adapter, "failed-run", { nowMs: NOW });
      expect(failed.reason).toContain("boom");
    } finally {
      sqlite.close();
    }
  });

  test("surfaces a forced side-effect crossing without changing a finished run verdict", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await seedRun(adapter, "forced-finished", {
        status: "finished",
        finishedAtMs: NOW - MIN,
        heartbeatAtMs: null,
      });
      await adapter.insertEventWithNextSeq({
        runId: "forced-finished",
        type: "SideEffectBoundaryCrossed",
        timestampMs: NOW - 30_000,
        payloadJson: JSON.stringify({
          type: "SideEffectBoundaryCrossed",
          runId: "forced-finished",
          operation: "replay",
          opId: "forced-op",
          timestampMs: NOW - 30_000,
          report: {
            blocking: [{ nodeId: "send", iteration: 0, attempt: 1, seq: 1 }],
            revertible: [],
            warnings: [],
          },
        }),
      });

      const summary = await buildRunStatusSummary(adapter, "forced-finished", { nowMs: NOW });

      expect(summary.status).toBe("finished");
      expect(summary.verdict).toBe("done");
      expect(summary.attention).toMatchObject({
        operation: "replay",
        opId: "forced-op",
        crossedCount: 1,
      });
      expect(renderRunStatusHuman(summary)).toContain("Attention forced replay crossed 1 external effect");
      expect(runStatusCtaCommands(summary)[0]).toEqual({
        command: "why forced-finished",
        description: "Explain blockers in depth",
      });
    } finally {
      sqlite.close();
    }
  });

  test("surfaces late completion of an archived tool as needs-attention", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await seedRun(adapter, "late-tool", {
        status: "failed",
        finishedAtMs: NOW - MIN,
        heartbeatAtMs: null,
      });
      await adapter.insertEventWithNextSeq({
        runId: "late-tool",
        type: "SideEffectBoundaryCrossed",
        timestampMs: NOW - 30_000,
        payloadJson: JSON.stringify({
          type: "SideEffectBoundaryCrossed",
          runId: "late-tool",
          operation: "late-tool-completion",
          opId: "late-call",
          lateCompletion: true,
          archivedByOp: "rewind-op",
          timestampMs: NOW - 30_000,
          report: {
            blocking: [{ nodeId: "send", iteration: 0, attempt: 1, seq: 1 }],
            revertible: [],
            warnings: [],
          },
        }),
      });

      const summary = await buildRunStatusSummary(adapter, "late-tool", { nowMs: NOW });

      expect(summary.attention).toMatchObject({
        lateCompletion: true,
        archivedByOp: "rewind-op",
      });
      expect(renderRunStatusHuman(summary)).toContain(
        "Attention external effect completed after its journal row was reverted or archived",
      );
    } finally {
      sqlite.close();
    }
  });

  test("renders warning-only fork crossings as information without forced attention", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await seedRun(adapter, "warning-only-fork", {
        status: "finished",
        finishedAtMs: NOW - MIN,
        heartbeatAtMs: null,
      });
      await adapter.insertEventWithNextSeq({
        runId: "warning-only-fork",
        type: "SideEffectBoundaryCrossed",
        timestampMs: NOW - 30_000,
        payloadJson: JSON.stringify({
          type: "SideEffectBoundaryCrossed",
          runId: "warning-only-fork",
          operation: "fork",
          opId: "warning-op",
          warningOnly: true,
          timestampMs: NOW - 30_000,
          report: {
            blocking: [],
            revertible: [],
            warnings: [{ nodeId: "send", iteration: 0, attempt: 1, seq: 1 }],
          },
        }),
      });

      const summary = await buildRunStatusSummary(adapter, "warning-only-fork", { nowMs: NOW });
      const rendered = renderRunStatusHuman(summary);

      expect(summary.attention).toBeUndefined();
      expect(summary.information).toMatchObject({
        operation: "fork",
        warningCount: 1,
      });
      expect(rendered).toContain("Info     fork recorded 1 side-effect warning; no crossing was forced");
      expect(rendered).not.toContain("Attention");
      expect(rendered).not.toContain("forced fork crossed 0");
      expect(runStatusCtaCommands(summary).some((entry) => entry.command === "why warning-only-fork")).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  test("stalled: pending work, nothing running, nothing finished recently", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await seedRun(adapter, "r6");
      await seedNode(adapter, "r6", "old-done", "finished", NOW - 45 * MIN);
      await seedNode(adapter, "r6", "next", "pending", NOW - 45 * MIN);

      const summary = await buildRunStatusSummary(adapter, "r6", { nowMs: NOW });

      expect(summary.verdict).toBe("stalled");
      expect(summary.throughput.recentFinished).toBe(0);
      expect(summary.throughput.totalFinished).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  test("waiting-approval run status reads as blocked and names the gate", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await seedRun(adapter, "r7", { status: "waiting-approval", heartbeatAtMs: null });
      await seedNode(adapter, "r7", "gate", "waiting-approval", NOW - 5 * MIN);

      const summary = await buildRunStatusSummary(adapter, "r7", { nowMs: NOW });

      expect(summary.verdict).toBe("blocked");
      expect(summary.reason).toContain("approval");
      expect(summary.bottleneck.map((b) => b.nodeId)).toEqual(["gate"]);
    } finally {
      sqlite.close();
    }
  });

  test("shows the latest durable oneshot control without exposing the steering message", async () => {
    const { sqlite, adapter } = createMemoryDb();
    try {
      await seedRun(adapter, "oneshot-control", { workflowName: "oneshot" });
      await adapter.insertEventWithNextSeq({
        runId: "oneshot-control",
        timestampMs: NOW - 2_000,
        type: "OneshotSteerQueued",
        payloadJson: JSON.stringify({
          type: "OneshotSteerQueued",
          runId: "oneshot-control",
          nodeId: "steer",
          messageId: "message-1",
          message: "private steering text",
          engine: "claude-code",
          delivery: "queued",
          timestampMs: NOW - 2_000,
        }),
      });
      await adapter.insertEventWithNextSeq({
        runId: "oneshot-control",
        timestampMs: NOW - 1_000,
        type: "OneshotSteerAcknowledged",
        payloadJson: JSON.stringify({
          type: "OneshotSteerAcknowledged",
          runId: "oneshot-control",
          nodeId: "steer",
          messageId: "message-1",
          engine: "claude-code",
          delivery: "agent-acked",
          timestampMs: NOW - 1_000,
        }),
      });

      const summary = await buildRunStatusSummary(adapter, "oneshot-control", { nowMs: NOW });
      expect(summary.oneshotControl).toMatchObject({
        kind: "steer",
        status: "agent-acked",
        messageId: "message-1",
      });
      const rendered = renderRunStatusHuman(summary);
      expect(rendered).toContain("Control  steer agent-acked");
      expect(rendered).not.toContain("private steering text");
    } finally {
      sqlite.close();
    }
  });
});

describe("quota + frame helpers", () => {
  test("isQuotaAttemptFailure matches the engine's shapes: code, details flag, legacy metaJson flag", () => {
    expect(isQuotaAttemptFailure({ errorJson: QUOTA_ERROR_JSON })).toBe(true);
    expect(
      isQuotaAttemptFailure({
        errorJson: JSON.stringify({ code: "OTHER", details: { failureQuota: true } }),
      }),
    ).toBe(true);
    expect(isQuotaAttemptFailure({ metaJson: JSON.stringify({ failureQuota: true }) })).toBe(true);
    expect(
      isQuotaAttemptFailure({
        errorJson: JSON.stringify({ code: "TASK_FAILED", message: "no" }),
      }),
    ).toBe(false);
    expect(isQuotaAttemptFailure(null)).toBe(false);
  });

  test("parseFrameDependsOn walks a frame XML tree for dependsOn/continueOnFail", () => {
    const frame = JSON.stringify({
      kind: "element",
      tag: "smithers:workflow",
      props: {},
      children: [
        { kind: "element", tag: "smithers:task", props: { id: "build" }, children: [] },
        {
          kind: "element",
          tag: "smithers:task",
          props: { id: "deploy", dependsOn: '["build","test"]' },
          children: [],
        },
        {
          kind: "element",
          tag: "smithers:task",
          props: { id: "lint", dependsOn: "build", continueOnFail: "true" },
          children: [],
        },
      ],
    });
    const deps = parseFrameDependsOn(frame);
    expect(deps.get("deploy")).toEqual({ dependsOn: ["build", "test"], continueOnFail: false });
    expect(deps.get("lint")).toEqual({ dependsOn: ["build"], continueOnFail: true });
    expect(deps.get("build")).toEqual({ dependsOn: [], continueOnFail: false });
    expect(parseFrameDependsOn(null).size).toBe(0);
    expect(parseFrameDependsOn("not json").size).toBe(0);
  });
});
