import { describe, expect, test } from "bun:test";
import { buildTimeline, nodeStateRowsOf } from "../src/monitor-ui/monitorModel.ts";
import { classifyEntries, estimateRun, etaRefreshMs, formatEta, hasOpenEndedWork, workloadExtent } from "../src/monitor-ui/monitorEtaModel.ts";

const now = 1_000_000;
const rows = (body: unknown) => buildTimeline(nodeStateRowsOf(body), now);

describe("monitor ETA model", () => {
  test("estimates all unsettled known work from settled pace", () => {
    expect(estimateRun([], now).kind).toBe("unknown");
    expect(estimateRun(rows([{ nodeId: "q", iteration: 0, state: "queued", updatedAtMs: 1 }]), now)).toMatchObject({ kind: "unknown", remainingTasks: 1 });
    const entries = rows([
      { nodeId: "a", iteration: 0, state: "finished", startedAtMs: now - 60_000, finishedAtMs: now },
      { nodeId: "b", iteration: 0, state: "failed", startedAtMs: now - 60_000, finishedAtMs: now },
      { nodeId: "c", iteration: 0, state: "finished", startedAtMs: now - 60_000, updatedAtMs: now },
      { nodeId: "d", iteration: 0, state: "queued", updatedAtMs: now - 1 },
      { nodeId: "e", iteration: 0, state: "pending", updatedAtMs: now - 1 },
    ]);
    expect(estimateRun(entries, now)).toMatchObject({ kind: "estimate", remainingMs: 120_000, etaAtMs: now + 120_000, sampleSize: 3, remainingTasks: 2 });
    expect(estimateRun(rows([{ nodeId: "a", iteration: 0, state: "finished", startedAtMs: now - 60_000, finishedAtMs: now }, { nodeId: "b", iteration: 0, state: "running", startedAtMs: now - 20_000 }]), now)).toMatchObject({ remainingMs: 60_000, inFlightTasks: 1 });
    expect(estimateRun(rows([{ nodeId: "a", iteration: 0, state: "finished", startedAtMs: now - 60_000, finishedAtMs: now }, { nodeId: "b", iteration: 0, state: "running", startedAtMs: now - 90_000 }]), now).remainingMs).toBe(60_000);
  });

  test("classifies waiting and cancelled rows without deflating pace", () => {
    const entries = rows([
      { nodeId: "ok", iteration: 0, state: "finished", startedAtMs: now - 60_000, finishedAtMs: now },
      { nodeId: "wait", iteration: 0, state: "waiting-approval", startedAtMs: now - 20_000 },
      { nodeId: "never", iteration: 0, state: "waiting-approval", updatedAtMs: now - 1 },
      { nodeId: "skip", iteration: 0, state: "skipped", startedAtMs: now - 1, finishedAtMs: now },
    ]);
    expect(classifyEntries(entries)).toMatchObject({ settled: expect.any(Array), inFlight: [expect.objectContaining({ nodeId: "wait" })], remaining: [expect.objectContaining({ nodeId: "never" })] });
    expect(estimateRun(entries, now)).toMatchObject({ sampleSize: 1, remainingTasks: 1, inFlightTasks: 1, remainingMs: 120_000 });
    expect(estimateRun(rows([{ nodeId: "a", iteration: 0, state: "finished", startedAtMs: now - 1, finishedAtMs: now }]), now, { openEnded: true }).kind).toBe("at-least");
  });

  test("detects open-ended work and reports extent", () => {
    expect(hasOpenEndedWork([{ nodeId: "x", iteration: 1, state: "finished" }])).toBe(true);
    expect(hasOpenEndedWork([], [{ kind: "LOOP" }])).toBe(true);
    expect(hasOpenEndedWork([], [{ kind: "foreach" }])).toBe(true);
    expect(hasOpenEndedWork([], [{ kind: "task" }])).toBe(false);
    const raw = [{ nodeId: "a", iteration: 0, state: "finished", startedAtMs: 1, finishedAtMs: 2 }, { nodeId: "b", iteration: 0, state: "waiting", startedAtMs: 2 }, { nodeId: "c", iteration: 0, state: "queued" }];
    expect(workloadExtent(nodeStateRowsOf(raw), [
      { kind: "agent" },
      { kind: "task", agent: "legacy-agent" },
      { kind: "task", agent: { engine: "codex" } },
      { kind: "compute", agent: { name: "not-an-agent-task" } },
    ], now - 120_000, now)).toMatchObject({ totalKnown: 3, settled: 1, running: 1, pending: 1, agentTasks: 3, elapsedMs: 120_000 });
    expect(workloadExtent(nodeStateRowsOf(raw), undefined, undefined, now).agentTasks).toBeUndefined();
  });

  test("formats fallbacks and accepts HTTP body variants", () => {
    expect(etaRefreshMs("running")).toBe(3_000); expect(etaRefreshMs("failed")).toBeNull();
    expect(formatEta({ kind: "estimate", remainingMs: 120_000, etaAtMs: now, avgTaskDurationMs: 1, sampleSize: 1, remainingTasks: 1, inFlightTasks: 0 })).toBe("~2m 00s left");
    expect(formatEta({ kind: "at-least", remainingMs: 45_000, etaAtMs: now, avgTaskDurationMs: 1, sampleSize: 1, remainingTasks: 1, inFlightTasks: 0 })).toBe("at least ~45s left");
    expect(formatEta({ kind: "unknown", sampleSize: 0, remainingTasks: 1, inFlightTasks: 0 })).toBe("estimating…");
    const camel = [{ nodeId: "a", iteration: 0, state: "finished", startedAtMs: now - 60_000, finishedAtMs: now }, { nodeId: "b", iteration: 0, state: "queued" }];
    const snake = [{ node_id: "a", iteration: 0, state: "finished", started_at_ms: now - 60_000, finished_at_ms: now }, { node_id: "b", iteration: 0, state: "queued" }];
    expect(estimateRun(rows({ ok: true, data: camel }), now).remainingMs).toBe(estimateRun(rows(camel), now).remainingMs);
    expect(estimateRun(rows(camel), now).remainingMs).toBe(estimateRun(rows(snake), now).remainingMs);
  });
});
