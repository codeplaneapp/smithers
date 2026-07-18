import { describe, expect, test } from "bun:test";
import { statusForRpcError } from "../src/gateway.js";
import { CACHE_MAX_ENTRIES, HISTORY_MAX_ENTRIES, HISTORY_MAX_RUNS, MAX_EVENTS, fallbackRecapSummary, notableRunEvents, runRecapRoute } from "../src/gatewayRoutes/runRecap.js";

function setup(rows: any[] = [{ seq: 0, type: "RunStarted", payload_json: "{}" }]) {
  const adapter = {
    getRun: async () => ({ runId: "run_1" }),
    getLastEventSeq: async () => rows.at(-1)?.seq ?? 0,
    listEventHistory: async (_id: string, { afterSeq, limit }: any) => rows.filter((row) => row.seq > afterSeq).slice(0, limit),
  };
  return { adapter, resolveRun: async () => ({ adapter }), cache: new Map(), history: new Map(), now: () => 1 };
}

describe("runRecapRoute", () => {
  test("validates ids, watermark, and missing runs with contract-documented statuses", async () => {
    const badRunId = await runRecapRoute({ ...setup(), runId: "BAD" }).catch((error) => error);
    const badSince = await runRecapRoute({ ...setup(), runId: "run_1", sinceSeq: -1 }).catch((error) => error);
    const missing = await runRecapRoute({ ...setup(), runId: "run_1", resolveRun: async () => null }).catch((error) => error);
    await expect(runRecapRoute({ ...setup(), runId: "run_1", sinceSeq: 1.5 })).rejects.toMatchObject({ code: "InvalidRequest" });
    // The versioned contract documents InvalidRequest; every thrown code must
    // dispatch to a 4xx, never fall through statusForRpcError to a 500.
    expect(badSince.code).toBe("InvalidRequest");
    expect(statusForRpcError(badRunId.code)).toBe(400);
    expect(statusForRpcError(badSince.code)).toBe(400);
    expect(statusForRpcError(missing.code)).toBe(404);
  });

  test("clamps a sinceSeq past the end of the run instead of inverting the interval", async () => {
    const state = setup([{ seq: 0, type: "RunStarted", payload_json: "{}" }, { seq: 1, type: "NodeFinished", payload_json: "{}" }]);
    const recap = await runRecapRoute({ ...state, runId: "run_1", sinceSeq: 100 });
    expect(recap).toMatchObject({ fromSeq: 1, toSeq: 1, notableEvents: 0 });
    expect(recap.fromSeq).toBeLessThanOrEqual(recap.toSeq);
  });

  test("filters snake/camel rows and gives a deterministic facts fallback", async () => {
    const state = setup([{ seq: 0, type: "RunStarted", payload_json: "{}" }, { seq: 1, type: "FrameCommitted", payload_json: "{}" }, { seq: 2, type: "NodeFailed", payloadJson: '{"nodeId":"x","errorMessage":"boom"}' }]);
    const recap = await runRecapRoute({ ...state, runId: "run_1" });
    expect(recap).toMatchObject({ fromSeq: 0, toSeq: 2, eventsConsidered: 3, notableEvents: 2, source: "facts" });
    expect(notableRunEvents([{ type: "FrameCommitted" }, { type: "NodeRetrying" }, { type: "ApprovalGranted" }, { type: "ApprovalResolved" }])).toHaveLength(2);
    expect(fallbackRecapSummary([{ type: "NodeFailed", payload_json: '{"node_id":"x","error_json":"{\\"message\\":\\"boom\\"}"}' }])).toContain("boom");
  });

  test("passes a bounded filtered delta to the narrator and falls back on bad answers", async () => {
    const state = setup([{ seq: 1, type: "FrameCommitted", payload_json: "{}" }, { seq: 2, type: "NodeFinished", payload_json: "{}" }]);
    let seen: any[] = [];
    const narrated = await runRecapRoute({ ...state, runId: "run_1", summarize: async ({ events, fromSeq, toSeq }: any) => { seen = events; expect([fromSeq, toSeq]).toEqual([0, 2]); return { summary: "done", agentId: "terra" }; } });
    expect(narrated).toMatchObject({ summary: "done", source: "agent", agentId: "terra" });
    expect(seen.map((event) => event.type)).toEqual(["NodeFinished"]);
    const fallback = await runRecapRoute({ ...setup(), runId: "run_1", summarize: async () => ({ summary: "" }) });
    expect(fallback.source).toBe("facts");
  });

  test("replays empty deltas and evicts cache entries through route calls", async () => {
    const rows = Array.from({ length: CACHE_MAX_ENTRIES + 2 }, (_, seq) => ({ seq, type: "NodeFinished", payload_json: "{}" }));
    const state = setup(rows);
    let narrations = 0;
    const first = await runRecapRoute({ ...state, runId: "run_1", summarize: async () => ({ summary: `narrated ${++narrations}` }) });
    const replay = await runRecapRoute({ ...state, runId: "run_1" });
    expect(first.source).toBe("agent");
    expect(replay.cached).toBe(true);
    for (let index = 1; index <= CACHE_MAX_ENTRIES; index++) await runRecapRoute({ ...state, runId: "run_1", sinceSeq: index, summarize: async () => ({ summary: `narrated ${++narrations}` }) });
    expect(state.cache.size).toBe(CACHE_MAX_ENTRIES);
    expect(narrations).toBe(CACHE_MAX_ENTRIES + 1);
  });

  test("never narrates rows appended after its captured sequence watermark", async () => {
    const state = setup([{ seq: 1, type: "NodeFinished", payload_json: "{}" }, { seq: 2, type: "NodeFailed", payload_json: "{}" }]);
    state.adapter.getLastEventSeq = async () => 1;
    let narrated: any[] = [];
    const recap = await runRecapRoute({ ...state, runId: "run_1", summarize: async ({ events }: any) => { narrated = events; return { summary: "one" }; } });
    expect(recap).toMatchObject({ toSeq: 1, eventsConsidered: 1, notableEvents: 1 });
    expect(narrated.map((event) => event.seq)).toEqual([1]);
  });

  test("never re-includes a durable seq 0 event in the next delta", async () => {
    const rows: any[] = [{ seq: 0, type: "RunStarted", payload_json: "{}" }];
    const state = setup(rows);
    const narrated: number[][] = [];
    const summarize = async ({ events }: any) => { narrated.push(events.map((event: any) => event.seq)); return { summary: `recap ${narrated.length}` }; };
    await runRecapRoute({ ...state, runId: "run_1", summarize });
    rows.push({ seq: 1, type: "NodeFinished", payload_json: "{}" });
    const second = await runRecapRoute({ ...state, runId: "run_1", summarize });
    expect(narrated).toEqual([[0], [1]]);
    expect(second).toMatchObject({ fromSeq: 1, toSeq: 1 });
  });

  test("advances the scan watermark across a capped non-notable span to reach a later notable event", async () => {
    const rows: any[] = [{ seq: 0, type: "NodeFinished", payload_json: "{}" }];
    const state = setup(rows);
    const first = await runRecapRoute({ ...state, runId: "run_1", summarize: async () => ({ summary: "first recap" }) });
    for (let seq = 1; seq <= MAX_EVENTS; seq++) rows.push({ seq, type: "FrameCommitted", payload_json: "{}" });
    rows.push({ seq: MAX_EVENTS + 1, type: "NodeFailed", payload_json: '{"nodeId":"x"}' });
    // The capped scan finds nothing notable: it replays the old recap but must
    // still advance, or the NodeFailed behind the span stays unreachable.
    const replayed = await runRecapRoute({ ...state, runId: "run_1", summarize: async () => ({ summary: "unused" }) });
    expect(replayed).toMatchObject({ summary: "first recap", cached: true, toSeq: MAX_EVENTS });
    let narrated: number[] = [];
    const third = await runRecapRoute({ ...state, runId: "run_1", summarize: async ({ events }: any) => { narrated = events.map((event: any) => event.seq); return { summary: "failure recap" }; } });
    expect(narrated).toEqual([MAX_EVENTS + 1]);
    expect(third).toMatchObject({ summary: "failure recap", fromSeq: MAX_EVENTS + 1, toSeq: MAX_EVENTS + 1 });
    expect(first.toSeq).toBe(0);
  });

  test("treats a delta of exactly the scan cap as complete, not truncated", async () => {
    const rows = Array.from({ length: MAX_EVENTS }, (_, seq) => ({ seq, type: "NodeFinished", payload_json: "{}" }));
    const recap = await runRecapRoute({ ...setup(rows), runId: "run_1" });
    expect(recap).toMatchObject({ toSeq: MAX_EVENTS - 1, eventsConsidered: MAX_EVENTS });
    expect(recap.summary).not.toContain("truncated");
  });

  test("bounds the per-run history map for a long-lived gateway", async () => {
    const history = new Map();
    for (let index = 0; index < HISTORY_MAX_RUNS + 1; index++) {
      const state = setup();
      state.history = history;
      state.adapter.getRun = async () => ({ runId: `run_${index}` });
      await runRecapRoute({ ...state, runId: `run_${index}` });
    }
    expect(history.size).toBe(HISTORY_MAX_RUNS);
    expect(history.has("run_0")).toBe(false);
    expect(history.has(`run_${HISTORY_MAX_RUNS}`)).toBe(true);
  });

  test("moves the watermark and retains a twenty-entry newest-first history", async () => {
    const rows: any[] = [{ seq: 0, type: "RunStarted", payload_json: "{}" }];
    const state = setup(rows);
    await runRecapRoute({ ...state, runId: "run_1", summarize: async () => { throw new Error("offline"); } });
    for (let seq = 1; seq <= HISTORY_MAX_ENTRIES + 2; seq++) {
      rows.push({ seq, type: "NodeFinished", payload_json: "{}" });
      await runRecapRoute({ ...state, runId: "run_1", summarize: async () => ({ summary: `at ${seq}`, agentId: "n" }) });
    }
    const latest = await runRecapRoute({ ...state, runId: "run_1" });
    expect(latest.cached).toBe(true);
    expect(latest.history).toHaveLength(HISTORY_MAX_ENTRIES);
    expect(latest.history[0].toSeq).toBe(HISTORY_MAX_ENTRIES + 2);
  });
});
