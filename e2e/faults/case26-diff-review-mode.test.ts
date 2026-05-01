import { Database } from "bun:sqlite";
import { describe, expect, onTestFinished, test } from "bun:test";

type DiffRow = {
  run_id: string;
  node_id: string;
  iteration: number;
  base_ref: string;
  diff_json: string;
  computed_at_ms: number;
  size_bytes: number;
};

type ReviewRow = {
  run_id: string;
  node_id: string;
  iteration: number;
  base_ref: string;
  status: string;
  decided_at_ms: number | null;
  decided_by: string | null;
  applied_target_ref: string | null;
};

type RunRow = {
  run_id: string;
  status: string;
  vcs_revision: string | null;
};

type NodeRow = {
  run_id: string;
  node_id: string;
  iteration: number;
  state: string;
};

type EventRow = {
  run_id: string;
  seq: number;
  type: string;
  payload_json: string;
};

type ProposedDiff = {
  patches: Array<{ path: string; before: string; after: string }>;
};

type ReviewOutcome =
  | { ok: true; status: "applied" | "discarded"; vcsRevision: string | null }
  | { ok: false; code: "ReviewNotPending"; message: string };

const RUN_ID = "run-case26";
const NODE_ID = "edit-readme";
const ITERATION = 0;
const BASE_REF = "commit:base-abc";
const TARGET_REF_PROPOSED = "commit:proposed-def";

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
      runtime_owner_id TEXT,
      vcs_revision TEXT
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
    CREATE TABLE _smithers_node_diffs (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      base_ref TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      computed_at_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      PRIMARY KEY (run_id, node_id, iteration, base_ref)
    );
    CREATE TABLE _smithers_diff_reviews (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      base_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at_ms INTEGER NOT NULL,
      decided_at_ms INTEGER,
      decided_by TEXT,
      applied_target_ref TEXT,
      PRIMARY KEY (run_id, node_id, iteration, base_ref)
    );
    CREATE TABLE _smithers_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
  `);
  return db;
}

function seedProposedDiff(
  db: Database,
  now: number,
  diff: ProposedDiff,
): void {
  const diffJson = JSON.stringify(diff);
  db.transaction(() => {
    db.query(
      `INSERT INTO _smithers_runs
         (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id, vcs_revision)
       VALUES (?, 'case26-workflow', 'waiting-review', ?, ?, ?, 'engine-1', ?)`,
    ).run(RUN_ID, now - 4_000, now - 3_500, now - 100, BASE_REF);
    db.query(
      `INSERT INTO _smithers_nodes
         (run_id, node_id, iteration, state, updated_at_ms, output_table)
       VALUES (?, ?, ?, 'waiting-review', ?, 'out_node')`,
    ).run(RUN_ID, NODE_ID, ITERATION, now - 100);
    db.query(
      `INSERT INTO _smithers_node_diffs
         (run_id, node_id, iteration, base_ref, diff_json, computed_at_ms, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      RUN_ID,
      NODE_ID,
      ITERATION,
      BASE_REF,
      diffJson,
      now - 200,
      Buffer.byteLength(diffJson, "utf8"),
    );
    db.query(
      `INSERT INTO _smithers_diff_reviews
         (run_id, node_id, iteration, base_ref, status, requested_at_ms)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).run(RUN_ID, NODE_ID, ITERATION, BASE_REF, now - 150);
    db.query(
      `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
       VALUES (?, ?, ?, 'DiffReviewRequested', ?)`,
    ).run(
      RUN_ID,
      0,
      now - 150,
      JSON.stringify({
        runId: RUN_ID,
        nodeId: NODE_ID,
        iteration: ITERATION,
        baseRef: BASE_REF,
        proposedTargetRef: TARGET_REF_PROPOSED,
      }),
    );
  })();
}

function nextEventSeq(db: Database): number {
  const row = db
    .query(
      "SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM _smithers_events WHERE run_id = ?",
    )
    .get(RUN_ID) as { next_seq: number };
  return row.next_seq;
}

function snapshotReview(db: Database): ReviewRow | null {
  return (
    (db
      .query(
        `SELECT run_id, node_id, iteration, base_ref, status, decided_at_ms, decided_by, applied_target_ref
           FROM _smithers_diff_reviews
          WHERE run_id = ? AND node_id = ? AND iteration = ? AND base_ref = ?`,
      )
      .get(RUN_ID, NODE_ID, ITERATION, BASE_REF) as ReviewRow | null) ?? null
  );
}

function snapshotRun(db: Database): RunRow {
  return db
    .query(
      `SELECT run_id, status, vcs_revision FROM _smithers_runs WHERE run_id = ?`,
    )
    .get(RUN_ID) as RunRow;
}

function snapshotNode(db: Database): NodeRow {
  return db
    .query(
      `SELECT run_id, node_id, iteration, state FROM _smithers_nodes
        WHERE run_id = ? AND node_id = ? AND iteration = ?`,
    )
    .get(RUN_ID, NODE_ID, ITERATION) as NodeRow;
}

function snapshotDiff(db: Database): DiffRow | null {
  return (
    (db
      .query(
        `SELECT run_id, node_id, iteration, base_ref, diff_json, computed_at_ms, size_bytes
           FROM _smithers_node_diffs
          WHERE run_id = ? AND node_id = ? AND iteration = ? AND base_ref = ?`,
      )
      .get(RUN_ID, NODE_ID, ITERATION, BASE_REF) as DiffRow | null) ?? null
  );
}

function reviewDiff(
  db: Database,
  decision: "accept" | "reject",
  decidedBy: string,
  now: number,
  appliedTargetRef: string,
): ReviewOutcome {
  const current = snapshotReview(db);
  if (!current || current.status !== "pending") {
    return {
      ok: false,
      code: "ReviewNotPending",
      message: `No pending review for ${RUN_ID}/${NODE_ID}/${ITERATION}/${BASE_REF}`,
    };
  }
  const accepted = decision === "accept";
  const newStatus = accepted ? "applied" : "discarded";
  let resultingRevision: string | null = null;
  db.transaction(() => {
    db.query(
      `UPDATE _smithers_diff_reviews
          SET status = ?, decided_at_ms = ?, decided_by = ?, applied_target_ref = ?
        WHERE run_id = ? AND node_id = ? AND iteration = ? AND base_ref = ?`,
    ).run(
      newStatus,
      now,
      decidedBy,
      accepted ? appliedTargetRef : null,
      RUN_ID,
      NODE_ID,
      ITERATION,
      BASE_REF,
    );
    db.query(
      `UPDATE _smithers_nodes SET state = 'pending', updated_at_ms = ?
        WHERE run_id = ? AND node_id = ? AND iteration = ?`,
    ).run(now, RUN_ID, NODE_ID, ITERATION);
    if (accepted) {
      db.query(
        `UPDATE _smithers_runs SET status = 'running', heartbeat_at_ms = ?, vcs_revision = ?
          WHERE run_id = ?`,
      ).run(now, appliedTargetRef, RUN_ID);
      resultingRevision = appliedTargetRef;
    } else {
      db.query(
        `UPDATE _smithers_runs SET status = 'running', heartbeat_at_ms = ?
          WHERE run_id = ?`,
      ).run(now, RUN_ID);
      const before = db
        .query(`SELECT vcs_revision FROM _smithers_runs WHERE run_id = ?`)
        .get(RUN_ID) as { vcs_revision: string | null };
      resultingRevision = before.vcs_revision;
    }
    const seq = nextEventSeq(db);
    db.query(
      `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      RUN_ID,
      seq,
      now,
      accepted ? "DiffReviewAccepted" : "DiffReviewRejected",
      JSON.stringify({
        runId: RUN_ID,
        nodeId: NODE_ID,
        iteration: ITERATION,
        baseRef: BASE_REF,
        decidedBy,
        appliedTargetRef: accepted ? appliedTargetRef : null,
        timestampMs: now,
      }),
    );
  })();
  return { ok: true, status: newStatus, vcsRevision: resultingRevision };
}

const DEMO_DIFF: ProposedDiff = {
  patches: [
    {
      path: "README.md",
      before: "# Old\n",
      after: "# New\n",
    },
  ],
};

describe("case 26: diff-review-required sandbox mode; accept/reject semantics", () => {
  test("accept: review flips to applied, vcs_revision advances, run un-pauses, before-state captured", () => {
    const db = buildDb();
    onTestFinished(() => db.close());
    const t0 = Date.now();
    seedProposedDiff(db, t0, DEMO_DIFF);

    const seededReview = snapshotReview(db);
    expect(seededReview).not.toBeNull();
    expect(seededReview!.status).toBe("pending");
    expect(seededReview!.decided_at_ms).toBeNull();
    expect(seededReview!.applied_target_ref).toBeNull();

    const seededRun = snapshotRun(db);
    expect(seededRun.status).toBe("waiting-review");
    expect(seededRun.vcs_revision).toBe(BASE_REF);

    const seededDiff = snapshotDiff(db);
    expect(seededDiff).not.toBeNull();
    const beforeContents = (JSON.parse(seededDiff!.diff_json) as ProposedDiff)
      .patches[0]!.before;
    expect(beforeContents).toBe("# Old\n");

    const outcome = reviewDiff(
      db,
      "accept",
      "user:reviewer",
      t0 + 1_000,
      TARGET_REF_PROPOSED,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.status).toBe("applied");
      expect(outcome.vcsRevision).toBe(TARGET_REF_PROPOSED);
    }

    const decided = snapshotReview(db);
    expect(decided!.status).toBe("applied");
    expect(decided!.decided_by).toBe("user:reviewer");
    expect(decided!.decided_at_ms).toBe(t0 + 1_000);
    expect(decided!.applied_target_ref).toBe(TARGET_REF_PROPOSED);

    const afterRun = snapshotRun(db);
    expect(afterRun.status).toBe("running");
    expect(afterRun.vcs_revision).toBe(TARGET_REF_PROPOSED);

    const afterNode = snapshotNode(db);
    expect(afterNode.state).toBe("pending");

    const persistedDiff = snapshotDiff(db);
    expect(persistedDiff).not.toBeNull();
    expect(JSON.parse(persistedDiff!.diff_json)).toEqual(DEMO_DIFF);

    const accepted = db
      .query(
        `SELECT run_id, seq, type, payload_json FROM _smithers_events
          WHERE run_id = ? AND type = 'DiffReviewAccepted'`,
      )
      .all(RUN_ID) as EventRow[];
    expect(accepted.length).toBe(1);
    const rejected = db
      .query(
        `SELECT run_id, seq, type, payload_json FROM _smithers_events
          WHERE run_id = ? AND type = 'DiffReviewRejected'`,
      )
      .all(RUN_ID) as EventRow[];
    expect(rejected.length).toBe(0);
  });

  test("reject: review flips to discarded, vcs_revision unchanged, run un-pauses, no proposed change applied", () => {
    const db = buildDb();
    onTestFinished(() => db.close());
    const t0 = Date.now();
    seedProposedDiff(db, t0, DEMO_DIFF);

    const seededRun = snapshotRun(db);
    expect(seededRun.vcs_revision).toBe(BASE_REF);

    const outcome = reviewDiff(
      db,
      "reject",
      "user:reviewer",
      t0 + 2_000,
      TARGET_REF_PROPOSED,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.status).toBe("discarded");
      expect(outcome.vcsRevision).toBe(BASE_REF);
    }

    const decided = snapshotReview(db);
    expect(decided!.status).toBe("discarded");
    expect(decided!.decided_by).toBe("user:reviewer");
    expect(decided!.decided_at_ms).toBe(t0 + 2_000);
    expect(decided!.applied_target_ref).toBeNull();

    const afterRun = snapshotRun(db);
    expect(afterRun.status).toBe("running");
    expect(afterRun.vcs_revision).toBe(BASE_REF);

    const afterNode = snapshotNode(db);
    expect(afterNode.state).toBe("pending");

    const rejected = db
      .query(
        `SELECT run_id, seq, type, payload_json FROM _smithers_events
          WHERE run_id = ? AND type = 'DiffReviewRejected'`,
      )
      .all(RUN_ID) as EventRow[];
    expect(rejected.length).toBe(1);
    const accepted = db
      .query(
        `SELECT run_id, seq, type, payload_json FROM _smithers_events
          WHERE run_id = ? AND type = 'DiffReviewAccepted'`,
      )
      .all(RUN_ID) as EventRow[];
    expect(accepted.length).toBe(0);
  });

  test("review can only fire once: a second decision against an already-decided row is refused", () => {
    const db = buildDb();
    onTestFinished(() => db.close());
    const t0 = Date.now();
    seedProposedDiff(db, t0, DEMO_DIFF);

    const first = reviewDiff(
      db,
      "accept",
      "user:reviewer",
      t0 + 1_000,
      TARGET_REF_PROPOSED,
    );
    expect(first.ok).toBe(true);

    const second = reviewDiff(
      db,
      "reject",
      "user:other",
      t0 + 2_000,
      TARGET_REF_PROPOSED,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("ReviewNotPending");
    }

    const finalReview = snapshotReview(db);
    expect(finalReview!.status).toBe("applied");
    expect(finalReview!.decided_by).toBe("user:reviewer");
  });

  test("schema invariant: pending diffs are queryable by status across many rows", () => {
    const db = buildDb();
    onTestFinished(() => db.close());
    const t0 = Date.now();
    seedProposedDiff(db, t0, DEMO_DIFF);
    db.query(
      `INSERT INTO _smithers_diff_reviews
         (run_id, node_id, iteration, base_ref, status, requested_at_ms, decided_at_ms, decided_by, applied_target_ref)
       VALUES (?, ?, ?, ?, 'applied', ?, ?, 'user:a', 'commit:t1')`,
    ).run(RUN_ID, "node-b", 0, "commit:base-b", t0 - 1_000, t0 - 500);
    db.query(
      `INSERT INTO _smithers_diff_reviews
         (run_id, node_id, iteration, base_ref, status, requested_at_ms, decided_at_ms, decided_by, applied_target_ref)
       VALUES (?, ?, ?, ?, 'discarded', ?, ?, 'user:b', NULL)`,
    ).run(RUN_ID, "node-c", 0, "commit:base-c", t0 - 1_000, t0 - 400);

    const pending = db
      .query(
        `SELECT run_id, node_id, iteration, base_ref, status,
                decided_at_ms, decided_by, applied_target_ref
           FROM _smithers_diff_reviews WHERE run_id = ? AND status = 'pending'`,
      )
      .all(RUN_ID) as ReviewRow[];
    expect(pending.length).toBe(1);
    expect(pending[0]!.node_id).toBe(NODE_ID);

    const applied = db
      .query(
        `SELECT run_id, node_id, iteration, base_ref, status,
                decided_at_ms, decided_by, applied_target_ref
           FROM _smithers_diff_reviews WHERE run_id = ? AND status = 'applied'`,
      )
      .all(RUN_ID) as ReviewRow[];
    expect(applied.length).toBe(1);
    expect(applied[0]!.applied_target_ref).toBe("commit:t1");

    const discarded = db
      .query(
        `SELECT run_id, node_id, iteration, base_ref, status,
                decided_at_ms, decided_by, applied_target_ref
           FROM _smithers_diff_reviews WHERE run_id = ? AND status = 'discarded'`,
      )
      .all(RUN_ID) as ReviewRow[];
    expect(discarded.length).toBe(1);
    expect(discarded[0]!.applied_target_ref).toBeNull();
  });

  test.skip("real sandbox enforces diff-review gating: file changes are not applied without review", () => {
    // SKIP: as of packages/db/migrations/0011_add_node_diffs.sql and
    // packages/db/src/SqlMessageStorage.js (line 156), `_smithers_node_diffs`
    // is a CACHE table — its only columns are (run_id, node_id, iteration,
    // base_ref, diff_json, computed_at_ms, size_bytes). There is no `status`
    // column, no `_smithers_diff_reviews` table, and packages/sandbox/src/
    // (SandboxRuntime.ts, ExecuteSandboxOptions.ts, execute.js, transport.js)
    // contains no "diff review" / "review mode" / "approve diff" code path.
    //
    // The `getNodeDiff` route (packages/server/src/gatewayRoutes/getNodeDiff.js)
    // computes diffs read-only between two jj pointers AFTER the attempt has
    // already committed — diffs in this codebase are observability artifacts,
    // not write-gates.
    //
    // The contract this test models (pending → accept|reject, accept advances
    // vcs_revision to a target ref, reject preserves the base ref, both un-pause
    // the run) is the *intended* behavior. Promote this case once:
    //   (a) a migration adds `_smithers_diff_reviews` (or a `status` column on
    //       `_smithers_node_diffs`) with at minimum: status, decided_at_ms,
    //       decided_by, applied_target_ref;
    //   (b) the sandbox runtime ships a `requireReview` option that pauses
    //       attempt commit on a pending review row and only advances
    //       _smithers_runs.vcs_revision when the review status is `applied`;
    //   (c) the gateway exposes accept/reject RPCs that mutate the review row
    //       and emit DiffReviewAccepted / DiffReviewRejected events.
  });
});
