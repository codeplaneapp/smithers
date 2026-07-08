import { Database } from "bun:sqlite";
import { describe, expect, onTestFinished, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";

type NodeRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  state: string;
  updatedAtMs: number;
  outputTable: string;
  label: string | null;
};

type ScorerRow = {
  id: string;
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  scorerId: string;
  scorerName: string;
  source: string;
  score: number;
  reason: string | null;
  metaJson: string | null;
  scoredAtMs: number;
};

type EventRow = {
  runId: string;
  seq: number;
  type: string;
  payloadJson: string;
};

type CaseDb = {
  sqlite: Database;
  adapter: SmithersDb;
};

type GateOutcome =
  | { advanced: true; nextState: "running" }
  | {
      advanced: false;
      reason:
        | "scorer-failed"
        | "scorer-below-threshold"
        | "scorer-pending"
        | "scorer-missing";
      nextState: "blocked" | "pending";
    };

const RUN_ID = "run-case27";
const SCORER_NODE_ID = "produce-plan";
const DESTRUCTIVE_NODE_ID = "deploy-prod";
const SCORER_ID = "faithfulness-v1";
const THRESHOLD = 0.7;

function buildDb(): CaseDb {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function seedRun(adapter: SmithersDb, now: number): Promise<void> {
  await adapter.insertRun({
    runId: RUN_ID,
    workflowName: "case27-workflow",
    status: "running",
    createdAtMs: now - 5_000,
    startedAtMs: now - 4_000,
    heartbeatAtMs: now - 1_000,
    runtimeOwnerId: "engine-1",
  });
  await upsertNode(adapter, SCORER_NODE_ID, "finished", now - 2_000, "plan");
  await upsertNode(
    adapter,
    DESTRUCTIVE_NODE_ID,
    "pending",
    now - 2_000,
    "destructive:deploy",
  );
}

async function upsertNode(
  adapter: SmithersDb,
  nodeId: string,
  state: string,
  updatedAtMs: number,
  label: string,
): Promise<void> {
  await adapter.insertNode({
    runId: RUN_ID,
    nodeId,
    iteration: 0,
    state,
    lastAttempt: 1,
    updatedAtMs,
    outputTable: `out_${nodeId}`,
    label,
  });
}

async function recordScorerFinished(
  adapter: SmithersDb,
  score: number,
  now: number,
): Promise<void> {
  await adapter.insertScorerResult({
    id: `srow-${score}-${now}`,
    runId: RUN_ID,
    nodeId: SCORER_NODE_ID,
    iteration: 0,
    attempt: 0,
    scorerId: SCORER_ID,
    scorerName: "faithfulness",
    source: "live",
    score,
    reason: score < THRESHOLD ? "below threshold" : null,
    metaJson: null,
    scoredAtMs: now,
  });
  await appendEvent(adapter, "ScorerFinished", now, {
    runId: RUN_ID,
    nodeId: SCORER_NODE_ID,
    scorerId: SCORER_ID,
    scorerName: "faithfulness",
    score,
    timestampMs: now,
  });
}

async function recordScorerFailed(
  adapter: SmithersDb,
  errorMessage: string,
  now: number,
): Promise<void> {
  await appendEvent(adapter, "ScorerFailed", now, {
    runId: RUN_ID,
    nodeId: SCORER_NODE_ID,
    scorerId: SCORER_ID,
    scorerName: "faithfulness",
    error: errorMessage,
    timestampMs: now,
  });
}

async function recordScorerStarted(
  adapter: SmithersDb,
  now: number,
): Promise<void> {
  await appendEvent(adapter, "ScorerStarted", now, {
    runId: RUN_ID,
    nodeId: SCORER_NODE_ID,
    scorerId: SCORER_ID,
    scorerName: "faithfulness",
    timestampMs: now,
  });
}

async function appendEvent(
  adapter: SmithersDb,
  type: string,
  now: number,
  payload: Record<string, unknown>,
): Promise<void> {
  await adapter.insertEventWithNextSeq({
    runId: RUN_ID,
    timestampMs: now,
    type,
    payloadJson: JSON.stringify(payload),
  });
}

async function readNode(adapter: SmithersDb, nodeId: string): Promise<NodeRow> {
  const row = (await adapter.getNode(RUN_ID, nodeId, 0)) as NodeRow | undefined;
  if (!row) throw new Error(`node missing: ${nodeId}`);
  return row;
}

async function readScorerRows(
  adapter: SmithersDb,
  nodeId: string,
): Promise<ScorerRow[]> {
  return (await adapter.listScorerResults(RUN_ID, nodeId)) as ScorerRow[];
}

async function readEventsByType(
  adapter: SmithersDb,
  type: string,
): Promise<EventRow[]> {
  return (await adapter.listEventsByType(RUN_ID, type)) as EventRow[];
}

async function evaluateGate(
  adapter: SmithersDb,
  now: number,
): Promise<GateOutcome> {
  const rows = (await readScorerRows(adapter, SCORER_NODE_ID)).filter(
    (row) => row.scorerId === SCORER_ID,
  );
  const failedEvents = (await readEventsByType(adapter, "ScorerFailed")).filter(
    (evt) => {
      const payload = JSON.parse(evt.payloadJson) as { scorerId?: string };
      return payload.scorerId === SCORER_ID;
    },
  );
  const startedEvents = (
    await readEventsByType(adapter, "ScorerStarted")
  ).filter((evt) => {
    const payload = JSON.parse(evt.payloadJson) as { scorerId?: string };
    return payload.scorerId === SCORER_ID;
  });

  if (failedEvents.length > 0 && rows.length === 0) {
    await block(adapter, "scorer-failed", now);
    return { advanced: false, reason: "scorer-failed", nextState: "blocked" };
  }
  if (rows.length === 0 && startedEvents.length > 0) {
    return {
      advanced: false,
      reason: "scorer-pending",
      nextState: "pending",
    };
  }
  if (rows.length === 0) {
    return {
      advanced: false,
      reason: "scorer-missing",
      nextState: "pending",
    };
  }
  const latest = rows[rows.length - 1]!;
  if (latest.score < THRESHOLD) {
    await block(adapter, "scorer-below-threshold", now);
    return {
      advanced: false,
      reason: "scorer-below-threshold",
      nextState: "blocked",
    };
  }
  await upsertNode(
    adapter,
    DESTRUCTIVE_NODE_ID,
    "running",
    now,
    "destructive:deploy",
  );
  await appendEvent(adapter, "DestructiveNodeAdvanced", now, {
    runId: RUN_ID,
    nodeId: DESTRUCTIVE_NODE_ID,
    gatedBy: { scorerId: SCORER_ID, sourceNodeId: SCORER_NODE_ID },
    score: latest.score,
    threshold: THRESHOLD,
    timestampMs: now,
  });
  return { advanced: true, nextState: "running" };
}

async function block(
  adapter: SmithersDb,
  reason: "scorer-failed" | "scorer-below-threshold",
  now: number,
): Promise<void> {
  await upsertNode(
    adapter,
    DESTRUCTIVE_NODE_ID,
    "blocked",
    now,
    "destructive:deploy",
  );
  await appendEvent(adapter, "NodeGatedByScorerFailure", now, {
    runId: RUN_ID,
    nodeId: DESTRUCTIVE_NODE_ID,
    gatedBy: { scorerId: SCORER_ID, sourceNodeId: SCORER_NODE_ID },
    reason,
    threshold: THRESHOLD,
    timestampMs: now,
  });
}

describe("case 27: scorer failure blocks destructive downstream step", () => {
  test("scorer schema invariants: failure-or-low-score is queryable per (run, node, scorer)", async () => {
    const { sqlite, adapter } = buildDb();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now();
    await seedRun(adapter, t0);
    await recordScorerFinished(adapter, 0.42, t0 + 100);
    const rows = await readScorerRows(adapter, SCORER_NODE_ID);
    expect(rows.length).toBe(1);
    expect(rows[0]!.score).toBeLessThan(THRESHOLD);
    const destructive = await readNode(adapter, DESTRUCTIVE_NODE_ID);
    expect(destructive.state).toBe("pending");
    expect(destructive.label).toContain("destructive:");
  });

  test("A: scorer FAILS (ScorerFailed event, no row) -> destructive node is blocked, gating event recorded", async () => {
    const { sqlite, adapter } = buildDb();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now();
    await seedRun(adapter, t0);
    await recordScorerStarted(adapter, t0 + 50);
    await recordScorerFailed(adapter, "llm provider 500", t0 + 200);

    const outcome = await evaluateGate(adapter, t0 + 300);
    expect(outcome.advanced).toBe(false);
    if (!outcome.advanced) {
      expect(outcome.reason).toBe("scorer-failed");
      expect(outcome.nextState).toBe("blocked");
    }

    const destructive = await readNode(adapter, DESTRUCTIVE_NODE_ID);
    expect(destructive.state).toBe("blocked");
    expect(destructive.state).not.toBe("running");
    expect(destructive.state).not.toBe("succeeded");

    const gated = await readEventsByType(adapter, "NodeGatedByScorerFailure");
    expect(gated.length).toBe(1);
    const payload = JSON.parse(gated[0]!.payloadJson) as {
      runId: string;
      nodeId: string;
      gatedBy: { scorerId: string; sourceNodeId: string };
      reason: string;
    };
    expect(payload.runId).toBe(RUN_ID);
    expect(payload.nodeId).toBe(DESTRUCTIVE_NODE_ID);
    expect(payload.gatedBy.scorerId).toBe(SCORER_ID);
    expect(payload.gatedBy.sourceNodeId).toBe(SCORER_NODE_ID);
    expect(payload.reason).toBe("scorer-failed");

    const advanced = await readEventsByType(adapter, "DestructiveNodeAdvanced");
    expect(advanced.length).toBe(0);
  });

  test("A2: scorer score BELOW threshold -> destructive node is blocked", async () => {
    const { sqlite, adapter } = buildDb();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now();
    await seedRun(adapter, t0);
    await recordScorerFinished(adapter, 0.31, t0 + 200);

    const outcome = await evaluateGate(adapter, t0 + 300);
    expect(outcome.advanced).toBe(false);
    if (!outcome.advanced) {
      expect(outcome.reason).toBe("scorer-below-threshold");
    }
    expect((await readNode(adapter, DESTRUCTIVE_NODE_ID)).state).toBe("blocked");
    const gated = await readEventsByType(adapter, "NodeGatedByScorerFailure");
    expect(gated.length).toBe(1);
    const payload = JSON.parse(gated[0]!.payloadJson) as { reason: string };
    expect(payload.reason).toBe("scorer-below-threshold");
  });

  test("B: scorer PASSES (score above threshold) -> destructive node advances to running", async () => {
    const { sqlite, adapter } = buildDb();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now();
    await seedRun(adapter, t0);
    await recordScorerFinished(adapter, 0.92, t0 + 200);

    expect((await readNode(adapter, DESTRUCTIVE_NODE_ID)).state).toBe("pending");
    const outcome = await evaluateGate(adapter, t0 + 300);
    expect(outcome.advanced).toBe(true);
    if (outcome.advanced) {
      expect(outcome.nextState).toBe("running");
    }
    expect((await readNode(adapter, DESTRUCTIVE_NODE_ID)).state).toBe("running");
    expect(
      (await readEventsByType(adapter, "NodeGatedByScorerFailure")).length,
    ).toBe(0);
    const advanced = await readEventsByType(adapter, "DestructiveNodeAdvanced");
    expect(advanced.length).toBe(1);
    const payload = JSON.parse(advanced[0]!.payloadJson) as {
      nodeId: string;
      score: number;
      threshold: number;
    };
    expect(payload.nodeId).toBe(DESTRUCTIVE_NODE_ID);
    expect(payload.score).toBeGreaterThanOrEqual(THRESHOLD);
    expect(payload.threshold).toBe(THRESHOLD);
  });

  test("C: scorer IN-FLIGHT (started, no row, no fail) -> destructive node held in pending", async () => {
    const { sqlite, adapter } = buildDb();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now();
    await seedRun(adapter, t0);
    await recordScorerStarted(adapter, t0 + 50);

    const outcome = await evaluateGate(adapter, t0 + 100);
    expect(outcome.advanced).toBe(false);
    if (!outcome.advanced) {
      expect(outcome.reason).toBe("scorer-pending");
      expect(outcome.nextState).toBe("pending");
    }
    const destructive = await readNode(adapter, DESTRUCTIVE_NODE_ID);
    expect(destructive.state).toBe("pending");
    expect(destructive.state).not.toBe("running");
    expect(destructive.state).not.toBe("blocked");
    expect(
      (await readEventsByType(adapter, "NodeGatedByScorerFailure")).length,
    ).toBe(0);
    expect(
      (await readEventsByType(adapter, "DestructiveNodeAdvanced")).length,
    ).toBe(0);

    await recordScorerFinished(adapter, 0.95, t0 + 500);
    const second = await evaluateGate(adapter, t0 + 600);
    expect(second.advanced).toBe(true);
    expect((await readNode(adapter, DESTRUCTIVE_NODE_ID)).state).toBe("running");
  });

  test.skip("engine enforces scorer-gates-destructive-step contract end-to-end", () => {
    // SKIP: as of packages/engine/src/engine.js (around line 3710), scorers run
    // fire-and-forget via runScorersAsync() AFTER the upstream task already
    // finished, and there is no read-side check anywhere in the engine that
    // inspects _smithers_scorers / ScorerFailed events before letting a
    // downstream node advance. The _smithers_nodes.state machine has no
    // 'blocked' transition driven by scorer outcome, and scorer rows don't
    // carry a `status` column (only `score` is recorded; failures are
    // signalled by ScorerFailed events with NO row written; see
    // packages/scorers/src/run-scorers.js:81-94).
    //
    // The sub-tests above pin the *intended* schema-level contract:
    //   - destructive nodes carry a label / marker (here `destructive:*`),
    //   - low score or ScorerFailed event for a gating scorer must keep the
    //     downstream node out of `running` and write a
    //     NodeGatedByScorerFailure event,
    //   - in-flight scorer holds the downstream node in `pending`.
    //
    // Promote this case once the engine grows a real gate. The right home is
    // the readiness check in packages/engine/src/engine.js where a node moves
    // from `pending` -> `running`; it should consult _smithers_scorers and the
    // event log for any scorer bound as a gate to an upstream node and refuse
    // to advance unless score >= threshold.
    // Tracked: ticket smithers/0022 §E + #302 (engine scorer-gating not enforced).
  });
});
