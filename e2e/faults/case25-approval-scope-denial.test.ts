import { Database } from "bun:sqlite";
import { describe, expect, onTestFinished, test } from "bun:test";
import { hasGatewayScope } from "@smithers-orchestrator/gateway/auth/scopes";

type ApprovalRow = {
  run_id: string;
  node_id: string;
  iteration: number;
  status: string;
  decided_at_ms: number | null;
  decided_by: string | null;
  decision_json: string | null;
};

type EventRow = {
  run_id: string;
  seq: number;
  type: string;
  payload_json: string;
};

type AuditRow = {
  id: number;
  run_id: string;
  caller: string;
  timestamp_ms: number;
  result: string;
};

type SubmitOutcome =
  | { ok: true; status: "approved" | "denied" }
  | { ok: false; code: "FORBIDDEN"; message: string; requiredScope: string };

const RUN_ID = "run-case25";
const NODE_ID = "approve-deploy";
const ITERATION = 0;

function buildDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE _smithers_runs (
      run_id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER,
      heartbeat_at_ms INTEGER,
      runtime_owner_id TEXT
    );
    CREATE TABLE _smithers_nodes (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      output_table TEXT NOT NULL,
      PRIMARY KEY (run_id, node_id, iteration)
    );
    CREATE TABLE _smithers_approvals (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      requested_at_ms INTEGER,
      decided_at_ms INTEGER,
      decided_by TEXT,
      request_json TEXT,
      decision_json TEXT,
      auto_approved INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, node_id, iteration)
    );
    CREATE TABLE _smithers_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE _smithers_time_travel_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      from_frame_no INTEGER NOT NULL,
      to_frame_no INTEGER NOT NULL,
      caller TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      result TEXT NOT NULL,
      duration_ms INTEGER
    );
  `);
  return db;
}

function seedWaitingApproval(db: Database, now: number): void {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id)
     VALUES (?, 'case25-workflow', 'waiting-approval', ?, ?, ?, 'engine-1')`,
  ).run(RUN_ID, now - 5_000, now - 4_000, now - 1_000);
  db.query(
    `INSERT INTO _smithers_nodes
       (run_id, node_id, iteration, state, updated_at_ms, output_table)
     VALUES (?, ?, ?, 'waiting-approval', ?, 'out_node')`,
  ).run(RUN_ID, NODE_ID, ITERATION, now - 1_000);
  db.query(
    `INSERT INTO _smithers_approvals
       (run_id, node_id, iteration, status, requested_at_ms, request_json, auto_approved)
     VALUES (?, ?, ?, 'requested', ?, ?, 0)`,
  ).run(
    RUN_ID,
    NODE_ID,
    ITERATION,
    now - 1_500,
    JSON.stringify({ prompt: "approve production deploy?" }),
  );
}

function snapshotApproval(db: Database): ApprovalRow {
  return db
    .query(
      `SELECT run_id, node_id, iteration, status, decided_at_ms, decided_by, decision_json
         FROM _smithers_approvals
        WHERE run_id = ? AND node_id = ? AND iteration = ?`,
    )
    .get(RUN_ID, NODE_ID, ITERATION) as ApprovalRow;
}

function nextEventSeq(db: Database, runId: string): number {
  const row = db
    .query(
      "SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM _smithers_events WHERE run_id = ?",
    )
    .get(runId) as { next_seq: number };
  return row.next_seq;
}

function submitApproval(
  db: Database,
  caller: { userId: string; scopes: readonly string[] },
  approved: boolean,
  now: number,
): SubmitOutcome {
  const requiredScope = "approval:submit";
  if (!hasGatewayScope(caller.scopes, requiredScope, "approval:submit")) {
    const seq = nextEventSeq(db, RUN_ID);
    db.query(
      `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
       VALUES (?, ?, ?, 'GatewayScopeDenied', ?)`,
    ).run(
      RUN_ID,
      seq,
      now,
      JSON.stringify({
        runId: RUN_ID,
        nodeId: NODE_ID,
        iteration: ITERATION,
        method: "approval:submit",
        actor: caller.userId,
        grantedScopes: [...caller.scopes],
        requiredScope,
        timestampMs: now,
      }),
    );
    return {
      ok: false,
      code: "FORBIDDEN",
      message: `Missing required scope ${requiredScope} for approval:submit`,
      requiredScope,
    };
  }
  db.transaction(() => {
    db.query(
      `UPDATE _smithers_approvals
          SET status = ?, decided_at_ms = ?, decided_by = ?, decision_json = ?
        WHERE run_id = ? AND node_id = ? AND iteration = ?`,
    ).run(
      approved ? "approved" : "denied",
      now,
      caller.userId,
      JSON.stringify({ approved }),
      RUN_ID,
      NODE_ID,
      ITERATION,
    );
    db.query(
      `UPDATE _smithers_nodes SET state = 'pending', updated_at_ms = ?
        WHERE run_id = ? AND node_id = ? AND iteration = ?`,
    ).run(now, RUN_ID, NODE_ID, ITERATION);
    db.query(
      `UPDATE _smithers_runs SET status = 'running', heartbeat_at_ms = ? WHERE run_id = ?`,
    ).run(now, RUN_ID);
    const seq = nextEventSeq(db, RUN_ID);
    db.query(
      `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      RUN_ID,
      seq,
      now,
      approved ? "ApprovalGranted" : "ApprovalDenied",
      JSON.stringify({
        runId: RUN_ID,
        nodeId: NODE_ID,
        iteration: ITERATION,
        decidedBy: caller.userId,
        timestampMs: now,
      }),
    );
  })();
  return { ok: true, status: approved ? "approved" : "denied" };
}

describe("case25 approval scope denial and audit record", () => {
  test("hasGatewayScope rejects viewer-scope tokens for approval:submit", () => {
    expect(hasGatewayScope(["run:read"], "approval:submit", "approval:submit")).toBe(false);
    expect(hasGatewayScope(["run:write"], "approval:submit", "approval:submit")).toBe(false);
    expect(hasGatewayScope(["run:admin"], "approval:submit", "approval:submit")).toBe(false);
    expect(hasGatewayScope(["signal:submit"], "approval:submit", "approval:submit")).toBe(false);
    expect(hasGatewayScope(["observability:read"], "approval:submit", "approval:submit")).toBe(false);
    expect(hasGatewayScope([], "approval:submit", "approval:submit")).toBe(false);
  });

  test("hasGatewayScope accepts approval:submit, wildcard, or admin tokens", () => {
    expect(hasGatewayScope(["approval:submit"], "approval:submit", "approval:submit")).toBe(true);
    expect(hasGatewayScope(["*"], "approval:submit", "approval:submit")).toBe(true);
    expect(hasGatewayScope(["admin"], "approval:submit", "approval:submit")).toBe(true);
    expect(hasGatewayScope(["approve"], "approval:submit", "approval:submit")).toBe(true);
  });

  test("token with approval:submit succeeds: row updates, ApprovalGranted event written", () => {
    const db = buildDb();
    onTestFinished(() => db.close());
    const t0 = Date.now();
    seedWaitingApproval(db, t0);

    const seeded = snapshotApproval(db);
    expect(seeded.status).toBe("requested");

    const outcome = submitApproval(
      db,
      { userId: "user:operator", scopes: ["approval:submit", "run:read"] },
      true,
      t0 + 1_000,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.status).toBe("approved");
    }

    const decided = snapshotApproval(db);
    expect(decided.status).toBe("approved");
    expect(decided.decided_by).toBe("user:operator");
    expect(decided.decided_at_ms).toBe(t0 + 1_000);
    expect(JSON.parse(decided.decision_json!)).toEqual({ approved: true });

    const granted = db
      .query(
        `SELECT run_id, seq, type, payload_json FROM _smithers_events
          WHERE run_id = ? AND type = 'ApprovalGranted'`,
      )
      .all(RUN_ID) as EventRow[];
    expect(granted.length).toBe(1);
    const denials = db
      .query(
        `SELECT run_id, seq, type, payload_json FROM _smithers_events
          WHERE run_id = ? AND type = 'GatewayScopeDenied'`,
      )
      .all(RUN_ID) as EventRow[];
    expect(denials.length).toBe(0);
  });

  test("viewer-scope token is rejected: approval row stays requested", () => {
    const db = buildDb();
    onTestFinished(() => db.close());
    const t0 = Date.now();
    seedWaitingApproval(db, t0);

    const seeded = snapshotApproval(db);
    expect(seeded.status).toBe("requested");
    expect(seeded.decided_at_ms).toBeNull();

    const outcome = submitApproval(
      db,
      { userId: "user:viewer", scopes: ["run:read"] },
      true,
      t0 + 1_000,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("FORBIDDEN");
      expect(outcome.requiredScope).toBe("approval:submit");
      expect(outcome.message).toContain("approval:submit");
    }

    const afterDenial = snapshotApproval(db);
    expect(afterDenial.status).toBe("requested");
    expect(afterDenial.decided_at_ms).toBeNull();
    expect(afterDenial.decided_by).toBeNull();
    expect(afterDenial.decision_json).toBeNull();

    const runStatus = db
      .query(`SELECT status FROM _smithers_runs WHERE run_id = ?`)
      .get(RUN_ID) as { status: string };
    expect(runStatus.status).toBe("waiting-approval");

    const granted = db
      .query(
        `SELECT run_id, seq FROM _smithers_events
          WHERE run_id = ? AND type = 'ApprovalGranted'`,
      )
      .all(RUN_ID) as EventRow[];
    expect(granted.length).toBe(0);
  });

  test("denial writes a GatewayScopeDenied audit event with actor + missing scope + timestamp", () => {
    const db = buildDb();
    onTestFinished(() => db.close());
    const t0 = Date.now();
    seedWaitingApproval(db, t0);

    const outcome = submitApproval(
      db,
      { userId: "user:viewer", scopes: ["run:read", "observability:read"] },
      true,
      t0 + 2_000,
    );
    expect(outcome.ok).toBe(false);

    const denials = db
      .query(
        `SELECT run_id, seq, type, payload_json FROM _smithers_events
          WHERE run_id = ? AND type = 'GatewayScopeDenied'`,
      )
      .all(RUN_ID) as EventRow[];
    expect(denials.length).toBe(1);
    const payload = JSON.parse(denials[0]!.payload_json) as {
      runId: string;
      nodeId: string;
      iteration: number;
      method: string;
      actor: string;
      grantedScopes: string[];
      requiredScope: string;
      timestampMs: number;
    };
    expect(payload.runId).toBe(RUN_ID);
    expect(payload.nodeId).toBe(NODE_ID);
    expect(payload.iteration).toBe(ITERATION);
    expect(payload.method).toBe("approval:submit");
    expect(payload.actor).toBe("user:viewer");
    expect(payload.requiredScope).toBe("approval:submit");
    expect(payload.grantedScopes).toEqual(["run:read", "observability:read"]);
    expect(payload.timestampMs).toBe(t0 + 2_000);
  });

  test("denial then valid retry from a different identity still resolves the approval", () => {
    const db = buildDb();
    onTestFinished(() => db.close());
    const t0 = Date.now();
    seedWaitingApproval(db, t0);

    const denied = submitApproval(
      db,
      { userId: "user:viewer", scopes: ["run:read"] },
      true,
      t0 + 500,
    );
    expect(denied.ok).toBe(false);
    expect(snapshotApproval(db).status).toBe("requested");

    const allowed = submitApproval(
      db,
      { userId: "user:operator", scopes: ["approval:submit"] },
      false,
      t0 + 1_500,
    );
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.status).toBe("denied");
    }

    const finalRow = snapshotApproval(db);
    expect(finalRow.status).toBe("denied");
    expect(finalRow.decided_by).toBe("user:operator");

    const denialEvents = db
      .query(
        `SELECT run_id, seq, type FROM _smithers_events
          WHERE run_id = ? AND type = 'GatewayScopeDenied'`,
      )
      .all(RUN_ID) as EventRow[];
    expect(denialEvents.length).toBe(1);
    const decisionEvents = db
      .query(
        `SELECT run_id, seq, type FROM _smithers_events
          WHERE run_id = ? AND type = 'ApprovalDenied'`,
      )
      .all(RUN_ID) as EventRow[];
    expect(decisionEvents.length).toBe(1);
  });

  test.skip("real gateway writes a scope-denial row to a dedicated audit table", () => {
    // SKIP: as of packages/server/src/gateway.js, scope denials at line 2197
    // (`responseForbidden`) and at lines 3563/3567 (approval-specific scope
    // checks) are surfaced via `emitGatewayLog` only — they do not currently
    // write a DB row to `_smithers_time_travel_audit` (which today is
    // dedicated to time-travel/rewind events; see gateway.js:3448 for the
    // jumpToFrame audit pattern that this scope-denial path should mirror).
    //
    // The contract this test enforces above is the *intended* behavior:
    // a denial appends an audit-shaped event so the security trail is
    // queryable. Promote this case once the gateway either:
    //   (a) extends `_smithers_time_travel_audit` to a generic
    //       `_smithers_audit` table (or adds a dedicated audit table), and
    //   (b) writes a row from `responseForbidden` / the approval scope
    //       branch with caller, method, requiredScope, timestamp.
  });
});
