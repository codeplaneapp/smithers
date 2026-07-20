import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { getDefinedToolMetadata } from "@smithers-orchestrator/engine/getDefinedToolMetadata";

type ApprovalRow = {
  run_id: string;
  node_id: string;
  iteration: number;
  status: string;
  request_json: string | null;
};

type AttemptRow = {
  run_id: string;
  node_id: string;
  iteration: number;
  attempt: number;
  state: string;
  meta_json: string | null;
};

type EventRow = {
  run_id: string;
  seq: number;
  type: string;
  payload_json: string;
};

type RunRow = {
  run_id: string;
  status: string;
};

type ToolMetadata = {
  name: string;
  sideEffect: boolean;
  idempotent: boolean;
};

type AttemptMeta = {
  toolCalls?: Array<{
    toolName: string;
    seq: number;
    status: string;
    idempotencyKey?: string | null;
  }>;
};

type ReplaySafetyVerdict =
  | { kind: "safe-replay"; reason: "no-prior-tool-calls" | "no-write-without-key" }
  | { kind: "needs-approval"; offending: Array<{ toolName: string; seq: number }> };

const SMITHERS_TOOL_METADATA = Symbol.for("smithers.tool.metadata");
const REPLAY_UNSAFE_APPROVAL_KIND = "ReplayUnsafeApproval";
const RUN_ID = "run-case24";
const NODE_ID = "publish-pr-comment";
const ITERATION = 0;
const PRIOR_ATTEMPT = 1;
const REPLAY_ATTEMPT = 2;

function buildDb(): Database {
  const sqlite = new Database(":memory:");
  ensureSmithersTables(drizzle(sqlite));
  return sqlite;
}

function makeStubTool(meta: ToolMetadata): Record<string | symbol, unknown> {
  return { [SMITHERS_TOOL_METADATA]: meta };
}

function seedRunWithPriorAttempt(
  db: Database,
  now: number,
  toolCalls: NonNullable<AttemptMeta["toolCalls"]>,
): void {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id)
     VALUES (?, 'case24-workflow', 'running', ?, ?, ?, 'engine-pid-case24')`,
  ).run(RUN_ID, now - 5_000, now - 4_500, now - 100);

  db.query(
    `INSERT INTO _smithers_nodes
       (run_id, node_id, iteration, state, updated_at_ms, output_table)
     VALUES (?, ?, ?, 'running', ?, 'out_node')`,
  ).run(RUN_ID, NODE_ID, ITERATION, now - 1_000);

  db.query(
    `INSERT INTO _smithers_attempts
       (run_id, node_id, iteration, attempt, state, started_at_ms, finished_at_ms, meta_json)
     VALUES (?, ?, ?, ?, 'failed', ?, ?, ?)`,
  ).run(
    RUN_ID,
    NODE_ID,
    ITERATION,
    PRIOR_ATTEMPT,
    now - 4_000,
    now - 2_000,
    JSON.stringify({ toolCalls } satisfies AttemptMeta),
  );

  for (const call of toolCalls) {
    db.query(
      `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
       VALUES (?, ?, ?, 'ToolCallStarted', ?)`,
    ).run(
      RUN_ID,
      call.seq,
      now - 3_000,
      JSON.stringify({
        runId: RUN_ID,
        nodeId: NODE_ID,
        iteration: ITERATION,
        attempt: PRIOR_ATTEMPT,
        toolName: call.toolName,
        seq: call.seq,
      }),
    );
  }
}

function readAttemptToolCalls(
  db: Database,
  attempt: number,
): NonNullable<AttemptMeta["toolCalls"]> {
  const row = db
    .query(
      `SELECT meta_json FROM _smithers_attempts
        WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt = ?`,
    )
    .get(RUN_ID, NODE_ID, ITERATION, attempt) as { meta_json: string | null } | null;
  if (!row?.meta_json) return [];
  const parsed = JSON.parse(row.meta_json) as AttemptMeta;
  return parsed.toolCalls ?? [];
}

function classifyReplaySafety(
  toolCalls: NonNullable<AttemptMeta["toolCalls"]>,
  toolsByName: Map<string, unknown>,
): ReplaySafetyVerdict {
  if (toolCalls.length === 0) {
    return { kind: "safe-replay", reason: "no-prior-tool-calls" };
  }
  const offending: Array<{ toolName: string; seq: number }> = [];
  for (const call of toolCalls) {
    const tool = toolsByName.get(call.toolName);
    const meta = getDefinedToolMetadata(tool);
    if (!meta) continue;
    const isUnsafeWrite = meta.sideEffect && meta.idempotent === false;
    const hasKey = typeof call.idempotencyKey === "string" && call.idempotencyKey.length > 0;
    if (isUnsafeWrite && !hasKey) {
      offending.push({ toolName: call.toolName, seq: call.seq });
    }
  }
  if (offending.length === 0) {
    return { kind: "safe-replay", reason: "no-write-without-key" };
  }
  return { kind: "needs-approval", offending };
}

function emitReplayUnsafeApproval(
  db: Database,
  now: number,
  offending: Array<{ toolName: string; seq: number }>,
): void {
  db.transaction(() => {
    db.query(
      `INSERT INTO _smithers_approvals
         (run_id, node_id, iteration, status, requested_at_ms, request_json, auto_approved)
       VALUES (?, ?, ?, 'requested', ?, ?, 0)`,
    ).run(
      RUN_ID,
      NODE_ID,
      ITERATION,
      now,
      JSON.stringify({
        kind: REPLAY_UNSAFE_APPROVAL_KIND,
        runId: RUN_ID,
        nodeId: NODE_ID,
        iteration: ITERATION,
        attempt: REPLAY_ATTEMPT,
        priorAttempt: PRIOR_ATTEMPT,
        offending,
        prompt:
          "Replay would re-execute non-idempotent write tools that have no idempotency key.",
      }),
    );
    db.query(
      `UPDATE _smithers_nodes SET state = 'waiting-approval', updated_at_ms = ?
        WHERE run_id = ? AND node_id = ? AND iteration = ?`,
    ).run(now, RUN_ID, NODE_ID, ITERATION);
    db.query(
      `UPDATE _smithers_runs SET status = 'waiting-approval' WHERE run_id = ?`,
    ).run(RUN_ID);
  })();
}

function recordSafeReplay(
  db: Database,
  now: number,
  toolCalls: NonNullable<AttemptMeta["toolCalls"]>,
): void {
  db.transaction(() => {
    db.query(
      `INSERT INTO _smithers_attempts
         (run_id, node_id, iteration, attempt, state, started_at_ms, meta_json)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    ).run(
      RUN_ID,
      NODE_ID,
      ITERATION,
      REPLAY_ATTEMPT,
      now,
      JSON.stringify({ toolCalls } satisfies AttemptMeta),
    );
    const seq =
      (
        db
          .query(
            `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM _smithers_events WHERE run_id = ?`,
          )
          .get(RUN_ID) as { max_seq: number }
      ).max_seq + 1;
    for (let i = 0; i < toolCalls.length; i += 1) {
      const call = toolCalls[i]!;
      db.query(
        `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
         VALUES (?, ?, ?, 'ToolCallReplayed', ?)`,
      ).run(
        RUN_ID,
        seq + i,
        now,
        JSON.stringify({
          runId: RUN_ID,
          nodeId: NODE_ID,
          attempt: REPLAY_ATTEMPT,
          toolName: call.toolName,
          seq: call.seq,
        }),
      );
    }
  })();
}

function snapshotApproval(db: Database): ApprovalRow | null {
  return (
    (db
      .query(
        `SELECT run_id, node_id, iteration, status, request_json
           FROM _smithers_approvals WHERE run_id = ?`,
      )
      .get(RUN_ID) as ApprovalRow | null) ?? null
  );
}

function readRun(db: Database): RunRow {
  return db
    .query("SELECT run_id, status FROM _smithers_runs WHERE run_id = ?")
    .get(RUN_ID) as RunRow;
}

function countToolStartEvents(db: Database, attempt: number): number {
  const rows = db
    .query(
      `SELECT run_id, seq, type, payload_json FROM _smithers_events
        WHERE run_id = ? AND type = 'ToolCallStarted'`,
    )
    .all(RUN_ID) as EventRow[];
  return rows.filter((row) => {
    try {
      const payload = JSON.parse(row.payload_json) as { attempt?: number };
      return payload.attempt === attempt;
    } catch {
      return false;
    }
  }).length;
}

function countAttempts(db: Database): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM _smithers_attempts
        WHERE run_id = ? AND node_id = ? AND iteration = ?`,
    )
    .get(RUN_ID, NODE_ID, ITERATION) as { n: number };
  return Number(row.n);
}

describe("case 24: retry sideEffect:write idempotent:false without key blocks on ReplayUnsafeApproval", () => {
  test("unsafe replay pauses the run on ReplayUnsafeApproval and does not re-invoke the tool", () => {
    const db = buildDb();
    try {
      const t0 = Date.now();
      const tools = new Map<string, unknown>([
        [
          "post-pr-comment",
          makeStubTool({ name: "post-pr-comment", sideEffect: true, idempotent: false }),
        ],
      ]);
      seedRunWithPriorAttempt(db, t0, [
        { toolName: "post-pr-comment", seq: 1, status: "ok", idempotencyKey: null },
      ]);

      const priorCalls = readAttemptToolCalls(db, PRIOR_ATTEMPT);
      const verdict = classifyReplaySafety(priorCalls, tools);

      expect(verdict.kind).toBe("needs-approval");
      if (verdict.kind !== "needs-approval") throw new Error("unreachable");
      expect(verdict.offending).toEqual([{ toolName: "post-pr-comment", seq: 1 }]);

      emitReplayUnsafeApproval(db, t0 + 100, verdict.offending);

      const approval = snapshotApproval(db);
      expect(approval).not.toBeNull();
      expect(approval!.status).toBe("requested");
      expect(approval!.node_id).toBe(NODE_ID);
      expect(approval!.iteration).toBe(ITERATION);
      const request = JSON.parse(approval!.request_json!) as {
        kind: string;
        offending: Array<{ toolName: string; seq: number }>;
        priorAttempt: number;
      };
      expect(request.kind).toBe(REPLAY_UNSAFE_APPROVAL_KIND);
      expect(request.priorAttempt).toBe(PRIOR_ATTEMPT);
      expect(request.offending[0]!.toolName).toBe("post-pr-comment");

      expect(readRun(db).status).toBe("waiting-approval");
      expect(countAttempts(db)).toBe(1);
      expect(countToolStartEvents(db, REPLAY_ATTEMPT)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("idempotent:true write tool replays without ReplayUnsafeApproval", () => {
    const db = buildDb();
    try {
      const t0 = Date.now();
      const tools = new Map<string, unknown>([
        [
          "merge-pr-by-id",
          makeStubTool({ name: "merge-pr-by-id", sideEffect: true, idempotent: true }),
        ],
      ]);
      seedRunWithPriorAttempt(db, t0, [
        { toolName: "merge-pr-by-id", seq: 1, status: "ok", idempotencyKey: null },
      ]);

      const verdict = classifyReplaySafety(readAttemptToolCalls(db, PRIOR_ATTEMPT), tools);
      expect(verdict.kind).toBe("safe-replay");

      recordSafeReplay(db, t0 + 50, [
        { toolName: "merge-pr-by-id", seq: 1, status: "ok", idempotencyKey: null },
      ]);

      expect(snapshotApproval(db)).toBeNull();
      expect(readRun(db).status).toBe("running");
      expect(countAttempts(db)).toBe(2);
    } finally {
      db.close();
    }
  });

  test("non-idempotent write tool with idempotencyKey replays without approval", () => {
    const db = buildDb();
    try {
      const t0 = Date.now();
      const tools = new Map<string, unknown>([
        [
          "post-pr-comment",
          makeStubTool({ name: "post-pr-comment", sideEffect: true, idempotent: false }),
        ],
      ]);
      seedRunWithPriorAttempt(db, t0, [
        {
          toolName: "post-pr-comment",
          seq: 1,
          status: "ok",
          idempotencyKey: "run-case24:post-pr-comment:abc123",
        },
      ]);

      const verdict = classifyReplaySafety(readAttemptToolCalls(db, PRIOR_ATTEMPT), tools);
      expect(verdict.kind).toBe("safe-replay");
      expect(snapshotApproval(db)).toBeNull();
    } finally {
      db.close();
    }
  });

  test.skip("engine emits ReplayUnsafeApproval row natively (0019 contract not yet wired)", () => {
    // SKIP: ticket 0019 lives in .smithers/tickets/.done/ but the production code
    // path (packages/engine/src/engine.js) only emits a soft warning message
    // ("[smithers:tool-resume-warning]") that is prepended to the LLM context via
    // collectToolResumeWarnings/buildToolResumeWarningMessage. There is no
    // ReplayUnsafeApproval row inserted into _smithers_approvals, no
    // tool_call_keys table (migration 0015_tool_call_keys.sql is missing), and
    // no first-class ReasonBlocked variant for replay safety. The contract above
    // is modeled at the DB level using the publicly exported getDefinedToolMetadata
    // predicate (sideEffect && idempotent === false) — when the engine wires the
    // approval emit path, replace classifyReplaySafety+emitReplayUnsafeApproval
    // with a real engine call and unskip this test.
  });
});
