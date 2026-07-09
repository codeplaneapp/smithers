import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  acquireLeaseLock,
  ambiguousSideEffectNodes,
  boundedContext,
  compareProgress,
  decisionAfterSolRepair,
  generateWithAgentFallback,
  knownStateDecision,
  parseEventEvidence,
  parseHealthDecision,
  parseSolRepairResult,
  parseWorkflowRunSummary,
  parseWatchdogArgs,
  progressSnapshot,
  releaseLeaseLock,
  runSmithersJson,
  shouldEscalate,
  stateKeyForRunId,
  validateReplacementRun,
} from "../scripts/codex-issue-merge-watchdog";

const watchdogScript = fileURLToPath(new URL("../scripts/codex-issue-merge-watchdog.ts", import.meta.url));

async function runWatchdogProcess(
  runId: string,
  responses: Record<string, { output: string; exitCode?: number }>,
  ticks = 1,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const root = mkdtempSync(join(tmpdir(), "smithers-watchdog-process-"));
  const binary = join(root, "smithers-fixture");
  const runner = join(root, "watchdog-runner.ts");
  const stateDir = join(root, "state");
  const source = [
    "#!/usr/bin/env bun",
    `const responses = ${JSON.stringify(responses)};`,
    "const response = responses[Bun.argv[2]] ?? { output: '', exitCode: 1 };",
    "process.stdout.write(response.output);",
    "process.exit(response.exitCode ?? 0);",
    "",
  ].join("\n");
  try {
    writeFileSync(binary, source, { mode: 0o700 });
    writeFileSync(
      runner,
      `import { watchdogMain } from ${JSON.stringify(pathToFileURL(watchdogScript).href)};\nawait watchdogMain();\n`,
    );
    chmodSync(binary, 0o700);
    let result: { status: number; stdout: string; stderr: string } | undefined;
    for (let index = 0; index < ticks; index += 1) {
      const stdoutPath = join(root, `watchdog-${index}.stdout`);
      const stderrPath = join(root, `watchdog-${index}.stderr`);
      const child = Bun.spawn(["/usr/bin/env", "bun",
        runner,
        "--run-id", runId,
        "--root", root,
        "--state-dir", stateDir,
      ], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? root,
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
          SMITHERS_BIN: binary,
        },
        stdout: Bun.file(stdoutPath),
        stderr: Bun.file(stderrPath),
      });
      const status = await child.exited;
      const stdout = existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "";
      const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : "";
      result = { status, stdout, stderr };
      if (!stdout.trim()) {
        throw new Error(
          `Watchdog fixture tick ${index + 1} emitted no JSON (status=${status}, stderr=${stderr})`,
        );
      }
    }
    if (!result) throw new Error("At least one watchdog fixture tick is required.");
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("codex issue merge watchdog", () => {
  test("is a one-shot cron command by default", () => {
    const options = parseWatchdogArgs(["run-123"], "/tmp/smithers-watchdog");
    expect(options.runId).toBe("run-123");
    expect(options.once).toBe(true);
    expect(options.intervalSeconds).toBe(300);
    expect(options.cooldownMinutes).toBe(30);
    expect(options.stateDir).toBe("/tmp/smithers-watchdog/.smithers/state/codex-issue-merge-watchdog");
  });

  test("supports a foreground interval and explicit cooldown", () => {
    const options = parseWatchdogArgs([
      "--run-id", "run-456",
      "--interval-seconds", "60",
      "--cooldown-minutes", "45",
      "--root", "/tmp/repo",
    ]);
    expect(options.once).toBe(false);
    expect(options.intervalSeconds).toBe(60);
    expect(options.cooldownMinutes).toBe(45);
    expect(options.rootDir).toBe("/tmp/repo");
  });

  test("recognizes durable waits, terminal success, failures, and intentional cancellation", () => {
    expect(knownStateDecision({ runState: { state: "waiting-approval" } })).toMatchObject({ healthy: true, repairRequired: false });
    expect(knownStateDecision({ runState: { state: "waiting-event" } })).toMatchObject({ healthy: true, repairRequired: false });
    expect(knownStateDecision(
      { ok: true, data: { runState: { state: "succeeded" } } },
      Date.now(),
      { successful: true, blocked: 0 },
    )).toMatchObject({ healthy: true, repairRequired: false });
    expect(knownStateDecision({ ok: true, data: { runState: { state: "succeeded" } } })).toBeNull();
    expect(knownStateDecision(
      { ok: true, data: { runState: { state: "succeeded" } } },
      Date.now(),
      { successful: false, blocked: 2 },
    )).toMatchObject({ healthy: false, repairRequired: true });
    expect(knownStateDecision({ ok: true, data: { runState: { state: "succeeded" }, failedChildren: 2 } })).toBeNull();
    expect(knownStateDecision({ runState: { state: "stale" } })).toMatchObject({ healthy: false, repairRequired: true });
    expect(knownStateDecision({ runState: { state: "cancelled" } })).toMatchObject({ healthy: false, repairRequired: false });
    expect(knownStateDecision({ runState: { state: "running" } })).toBeNull();
  });

  test("escalates a quota wait that remained parked after its reset", () => {
    const inspect = { ok: true, data: { runState: { state: "waiting-quota", blocked: { resetAtMs: 1_000 } } } };
    expect(knownStateDecision(inspect, 999)).toMatchObject({ healthy: true, repairRequired: false });
    expect(knownStateDecision(inspect, 1_001)).toMatchObject({ healthy: false, repairRequired: true });
    expect(knownStateDecision({ runState: { state: "waiting-quota", blocked: { kind: "quota" } } }, 1_001)).toBeNull();
  });

  test("unhealthy durable-wait metadata overrides an otherwise healthy wait state", () => {
    const inspect = {
      runState: {
        state: "waiting-timer",
        blocked: { kind: "timer", wakeAt: "2026-07-09T00:00:00.000Z" },
        unhealthy: { kind: "timer-overdue", wakeAt: "2026-07-09T00:00:00.000Z", overdueMs: 60_000 },
      },
    };
    expect(knownStateDecision(inspect)).toMatchObject({
      healthy: false,
      repairRequired: true,
      state: "waiting-timer",
      recommendedAction: "resume or supervise the overdue timer",
    });
  });

  test("parses exact Terra JSON and rejects wrapped or contradictory output", () => {
    const raw = '{"healthy":false,"repairRequired":true,"state":"stalled","reason":"no progress","recommendedAction":"retry task"}';
    expect(parseHealthDecision(raw)).toEqual({
      healthy: false,
      repairRequired: true,
      state: "stalled",
      reason: "no progress",
      recommendedAction: "retry task",
    });
    expect(parseHealthDecision(`diagnosis:\n\`\`\`json\n${raw}\n\`\`\``)).toBeNull();
    expect(parseHealthDecision('{"healthy":true,"repairRequired":true,"state":"contradictory"}')).toBeNull();
  });

  test("parses the durable workflow summary from plain and full-output envelopes", () => {
    const summary = { successful: false, blocked: 3, selected: 5, mergedLocally: 2 };
    expect(parseWorkflowRunSummary(JSON.stringify(summary))).toEqual(summary);
    expect(parseWorkflowRunSummary(JSON.stringify({ ok: true, data: { row: summary } }))).toEqual(summary);
    expect(parseWorkflowRunSummary(JSON.stringify({ successful: true, blocked: 0, merged_locally: 4 }))).toMatchObject({
      successful: true,
      blocked: 0,
      mergedLocally: 4,
    });
    expect(parseWorkflowRunSummary('{"successful":"yes","blocked":0}')).toBeNull();
  });

  test("fingerprints durable event and node progress across ticks", () => {
    const inspect = {
      data: {
        run: { id: "run-progress", status: "running", workflow: "Codex Issue Merge Queue" },
        runState: { state: "running" },
        steps: [{ id: "i1:research", state: "in-progress", attempt: 1 }],
      },
    };
    const firstEvents = parseEventEvidence([
      JSON.stringify({ runId: "run-progress", seq: 0, timestampMs: 10, type: "RunStarted", payload: {} }),
      JSON.stringify({ runId: "run-progress", seq: 1, timestampMs: 20, type: "NodeStarted", payload: { nodeId: "i1:research" } }),
    ].join("\n"));
    expect(firstEvents).not.toBeNull();
    const firstSnapshot = progressSnapshot("run-progress", inspect, firstEvents!);
    expect(firstSnapshot).not.toBeNull();
    const first = compareProgress(undefined, firstSnapshot!, 100);
    expect(first.changedSinceLastTick).toBeNull();
    expect(first.current.unchangedTicks).toBe(0);

    const unchanged = compareProgress(first.current, firstSnapshot!, 200);
    expect(unchanged.changedSinceLastTick).toBe(false);
    expect(unchanged.current.changedAt).toBe(100);
    expect(unchanged.current.unchangedTicks).toBe(1);

    const laterEvents = parseEventEvidence(`${firstEvents!.map((event) => JSON.stringify(event)).join("\n")}\n${JSON.stringify({
      runId: "run-progress",
      seq: 2,
      timestampMs: 30,
      type: "TaskHeartbeat",
      payload: { nodeId: "i1:research" },
    })}`);
    const laterSnapshot = progressSnapshot("run-progress", inspect, laterEvents!);
    const advanced = compareProgress(unchanged.current, laterSnapshot!, 300);
    expect(advanced.changedSinceLastTick).toBe(true);
    expect(advanced.current.changedAt).toBe(300);
    expect(advanced.current.unchangedTicks).toBe(0);
    expect(parseEventEvidence("not-json")).toBeNull();
  });

  test("identifies ambiguous VCS side-effect nodes from durable node state and events", () => {
    const inspect = {
      data: {
        run: { status: "failed" },
        runState: { state: "failed" },
        steps: [
          { id: "i1:sync-pr", state: "failed", attempt: 1 },
          { id: "i2:queue-rebase", state: "in-progress", attempt: 1 },
          { id: "i3:land-prepare", state: "cancelled", attempt: 1 },
          { id: "i4:land-local-main", state: "pending", attempt: 0 },
          { id: "i5:research", state: "failed", attempt: 1 },
        ],
      },
    };
    const events = parseEventEvidence([
      JSON.stringify({ runId: "run-side-effects", seq: 1, timestampMs: 10, type: "NodeFailed", payload: { nodeId: "i1:sync-pr" } }),
      JSON.stringify({ runId: "run-side-effects", seq: 2, timestampMs: 20, type: "NodeStarted", payload: { nodeId: "i4:land-local-main" } }),
    ].join("\n"));
    expect(ambiguousSideEffectNodes(inspect, events!)).toEqual([
      "i1:sync-pr",
      "i2:queue-rebase",
      "i3:land-prepare",
      "i4:land-local-main",
    ]);
  });

  test("accepts only exact structured Sol repair results and verifies replacement lineage", () => {
    const raw = JSON.stringify({ outcome: "repaired", replacementRunId: "run-replacement", summary: "forked cleanly" });
    expect(parseSolRepairResult(raw, "run-current")).toEqual({
      outcome: "repaired",
      replacementRunId: "run-replacement",
      summary: "forked cleanly",
    });
    expect(parseSolRepairResult(`report:\n${raw}`, "run-current")).toBeNull();
    expect(parseSolRepairResult(JSON.stringify({ outcome: "repaired", replacementRunId: "../unsafe", summary: "bad" }), "run-current")).toBeNull();
    expect(parseSolRepairResult(JSON.stringify({ outcome: "no-change", replacementRunId: "run-other", summary: "bad" }), "run-current")).toBeNull();

    const current = { data: { run: { id: "run-current", workflow: "Codex Issue Merge Queue", started: "2026-07-09T10:00:00.000Z" }, runState: { state: "failed" }, steps: [] } };
    const linked = { data: { run: { id: "run-replacement", workflow: "Codex Issue Merge Queue", parentRunId: "run-current", started: "2026-07-09T10:01:00.000Z" }, runState: { state: "running" }, steps: [] } };
    expect(validateReplacementRun(current, linked, "run-current", "run-replacement")).toEqual({ ok: true });
    const unlinked = { data: { run: { id: "run-replacement", workflow: "Codex Issue Merge Queue", started: "2026-07-09T10:01:00.000Z" }, runState: { state: "running" }, steps: [] } };
    expect(validateReplacementRun(current, unlinked, "run-current", "run-replacement")).toMatchObject({ ok: false });
    const unrelated = { data: { run: { id: "run-replacement", workflow: "Other Workflow", started: "2026-07-09T10:01:00.000Z" }, runState: { state: "running" }, steps: [] } };
    expect(validateReplacementRun(current, unrelated, "run-current", "run-replacement")).toMatchObject({ ok: false });
  });

  test("turns a Sol human-required outcome into an explicit manual non-repair state", () => {
    const unhealthy = { healthy: false, repairRequired: true, state: "failed", reason: "failed", recommendedAction: "repair" };
    expect(decisionAfterSolRepair(unhealthy, {
      outcome: "human-required",
      replacementRunId: null,
      summary: "reconcile the PR branch",
    })).toMatchObject({
      manualInterventionRequired: true,
      decision: {
        healthy: false,
        repairRequired: false,
        state: "repair-human-required",
        reason: "reconcile the PR branch",
      },
    });
    expect(decisionAfterSolRepair(unhealthy, {
      outcome: "repaired",
      replacementRunId: null,
      summary: "resumed",
    })).toEqual({ decision: unhealthy, manualInterventionRequired: false });
  });

  test("falls through an ordered agent array on preflight or unusable output", async () => {
    const calls: string[] = [];
    const preflightFailure = {
      preflight: async () => {
        calls.push("first:preflight");
        throw new Error("provider unavailable");
      },
      generate: async () => {
        calls.push("first:generate");
        return { text: "must not run" };
      },
    };
    const malformed = {
      generate: async () => {
        calls.push("second:generate");
        return { text: "not-json" };
      },
    };
    const fallback = {
      generate: async () => {
        calls.push("third:generate");
        return { text: '{"ok":true}' };
      },
    };

    expect(await generateWithAgentFallback(
      [preflightFailure, malformed, fallback],
      { prompt: "health check" },
      (text) => text === '{"ok":true}',
    )).toBe('{"ok":true}');
    expect(calls).toEqual(["first:preflight", "second:generate", "third:generate"]);
    await expect(generateWithAgentFallback([], { prompt: "x" })).rejects.toThrow("must not be empty");
  });

  test("enforces the Sol escalation cooldown", () => {
    const now = 10_000_000;
    expect(shouldEscalate(now, undefined, 30)).toBe(true);
    expect(shouldEscalate(now, now - 29 * 60_000, 30)).toBe(false);
    expect(shouldEscalate(now, now - 30 * 60_000, 30)).toBe(true);
  });

  test("bounds diagnostic context by UTF-8 bytes", () => {
    const bounded = boundedContext(`start-${"🌍".repeat(100)}`, 64);
    expect(Buffer.byteLength(bounded.split("\n").slice(1).join("\n"), "utf8")).toBeLessThanOrEqual(64);
    expect(bounded.endsWith("🌍")).toBe(true);
  });

  test("uses a bounded collision-resistant state key for an untrusted run id", () => {
    const shared = `../../${"a".repeat(300)}`;
    const first = stateKeyForRunId(`${shared}-one`);
    const second = stateKeyForRunId(`${shared}-two`);
    expect(first.length).toBeLessThanOrEqual(113);
    expect(first).not.toContain("/");
    expect(first).not.toStartWith(".");
    expect(first).not.toBe(second);
    expect(stateKeyForRunId(`${shared}-one`)).toBe(first);
  });

  test("never steals an old lease while its recorded owner is alive", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-watchdog-lock-"));
    const lockPath = join(root, "run.lock");
    try {
      const first = acquireLeaseLock(lockPath, 1_000, 1_000);
      expect(first).not.toBeNull();
      expect(JSON.parse(readFileSync(join(lockPath, "lease.json"), "utf8"))).toMatchObject({
        pid: process.pid,
        createdAt: 1_000,
      });
      expect(acquireLeaseLock(lockPath, 1_999, 1_000)).toBeNull();
      expect(acquireLeaseLock(lockPath, 2_000, 1_000)).toBeNull();
      releaseLeaseLock(first!);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers a lease whose recorded owner process exited", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-watchdog-pid-lock-"));
    const lockPath = join(root, "run.lock");
    try {
      const abandoned = acquireLeaseLock(lockPath, 1_000, 60_000, 2_147_483_647);
      expect(abandoned).not.toBeNull();
      const replacement = acquireLeaseLock(lockPath, 1_001, 60_000);
      expect(replacement).not.toBeNull();
      releaseLeaseLock(abandoned!);
      expect(existsSync(lockPath)).toBe(true);
      releaseLeaseLock(replacement!);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the TTL only to recover an incomplete lock with no live-owner metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-watchdog-incomplete-lock-"));
    const lockPath = join(root, "run.lock");
    try {
      mkdirSync(lockPath);
      utimesSync(lockPath, 1, 1);
      const replacement = acquireLeaseLock(lockPath, 2_000, 500);
      expect(replacement).not.toBeNull();
      releaseLeaseLock(replacement!);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists an unchanged progress fingerprint across separate cron processes", async () => {
    const runId = "run-cross-tick";
    const inspect = {
      ok: true,
      data: {
        run: { id: runId, workflow: "Codex Issue Merge Queue", status: "waiting-event", started: "2026-07-09T10:00:00.000Z" },
        runState: { state: "waiting-event", blocked: { kind: "event", nodeId: "signal", correlationKey: "ready" } },
        steps: [{ id: "signal", state: "waiting-event", attempt: 1 }],
      },
    };
    const result = await runWatchdogProcess(runId, {
      inspect: { output: JSON.stringify(inspect) },
      why: { output: JSON.stringify({ ok: true, data: { blocker: "event" } }) },
      events: {
        output: `${JSON.stringify({
          runId,
          seq: 8,
          timestampMs: Date.now() - 1_000,
          type: "NodeWaitingEvent",
          payload: { nodeId: "signal" },
        })}\n`,
      },
    }, 2);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      diagnosticFailure: false,
      progress: {
        changedSinceLastTick: false,
        unchangedTicks: 1,
      },
    });
  }, 60_000);

  test("returns a nonzero process exit and never escalates malformed diagnostics", async () => {
    const runId = "run-malformed";
    const result = await runWatchdogProcess(runId, {
      inspect: { output: "{malformed\n" },
      why: { output: JSON.stringify({ ok: true, data: { reason: "unknown" } }) },
      events: { output: `${JSON.stringify({ runId, seq: 0, timestampMs: 1, type: "RunStarted", payload: {} })}\n` },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      runId,
      diagnosticFailure: true,
      repairRequired: false,
      escalated: false,
    });
  }, 30_000);

  test("returns nonzero and refuses Sol for an ambiguous side-effecting node", async () => {
    const runId = "run-ambiguous-side-effect";
    const inspect = {
      ok: true,
      data: {
        run: {
          id: runId,
          workflow: "Codex Issue Merge Queue",
          status: "failed",
          started: "2026-07-09T10:00:00.000Z",
        },
        runState: { state: "failed" },
        steps: [{ id: "i1:sync-pr", state: "failed", attempt: 1 }],
      },
    };
    const result = await runWatchdogProcess(runId, {
      inspect: { output: JSON.stringify(inspect) },
      why: { output: JSON.stringify({ ok: true, data: { reason: "sync failed" } }) },
      events: {
        output: `${JSON.stringify({
          runId,
          seq: 4,
          timestampMs: 100,
          type: "NodeFailed",
          payload: { nodeId: "i1:sync-pr", attempt: 1 },
        })}\n`,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      runId,
      diagnosticFailure: false,
      manualInterventionRequired: true,
      repairRequired: false,
      escalated: false,
      ambiguousSideEffectNodes: ["i1:sync-pr"],
    });
  }, 30_000);

  test("terminates a stuck Smithers command at its deadline", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-watchdog-command-"));
    const binary = join(root, "stuck-smithers");
    try {
      writeFileSync(binary, "#!/bin/sh\nwhile :; do :; done\n", { mode: 0o700 });
      chmodSync(binary, 0o700);
      const startedAt = Date.now();
      const result = runSmithersJson("inspect", "run-stuck", root, { binary, timeoutMs: 50 });
      expect(result.ok).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(result.output).toContain("ETIMEDOUT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
