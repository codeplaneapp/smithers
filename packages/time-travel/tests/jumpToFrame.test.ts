import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import {
  JumpToFrameError,
  jumpToFrame,
} from "../src/jumpToFrame.js";
import { captureSnapshot } from "../src/snapshot/index.js";
import { listRewindAuditRows } from "../src/rewindAudit.js";

function setupDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS out_a (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      value INTEGER,
      PRIMARY KEY (run_id, node_id, iteration)
    );
    CREATE TABLE IF NOT EXISTS out_b (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      value INTEGER,
      PRIMARY KEY (run_id, node_id, iteration)
    );
  `);
  return {
    sqlite,
    adapter: new SmithersDb(db),
  };
}

async function seedRun(adapter: SmithersDb, runId: string) {
  await adapter.insertRun({
    runId,
    workflowName: "wf",
    status: "finished",
    createdAtMs: 1,
    startedAtMs: 1,
    finishedAtMs: 999,
    configJson: JSON.stringify({ auth: { triggeredBy: "user:owner" } }),
  });
  await adapter.insertFrame({
    runId,
    frameNo: 0,
    createdAtMs: 100,
    xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: {} }),
    xmlHash: "h0",
    mountedTaskIdsJson: "[]",
    taskIndexJson: "[]",
    note: "f0",
  });
  await adapter.insertFrame({
    runId,
    frameNo: 1,
    createdAtMs: 200,
    xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: { frame: 1 } }),
    xmlHash: "h1",
    mountedTaskIdsJson: "[]",
    taskIndexJson: "[]",
    note: "f1",
  });
  await adapter.insertFrame({
    runId,
    frameNo: 2,
    createdAtMs: 300,
    xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: { frame: 2 } }),
    xmlHash: "h2",
    mountedTaskIdsJson: "[]",
    taskIndexJson: "[]",
    note: "f2",
  });

  await adapter.insertNode({
    runId,
    nodeId: "task:one",
    iteration: 0,
    state: "finished",
    lastAttempt: 1,
    updatedAtMs: 160,
    outputTable: "out_a",
    label: "one",
  });
  await adapter.insertNode({
    runId,
    nodeId: "task:two",
    iteration: 0,
    state: "finished",
    lastAttempt: 1,
    updatedAtMs: 260,
    outputTable: "out_b",
    label: "two",
  });

  await adapter.insertAttempt({
    runId,
    nodeId: "task:one",
    iteration: 0,
    attempt: 1,
    state: "finished",
    startedAtMs: 150,
    finishedAtMs: 170,
    jjPointer: "ptr-one",
    jjCwd: "/tmp/sandbox-a",
  });
  await adapter.insertAttempt({
    runId,
    nodeId: "task:two",
    iteration: 0,
    attempt: 1,
    state: "finished",
    startedAtMs: 250,
    finishedAtMs: 270,
    jjPointer: "ptr-two",
    jjCwd: "/tmp/sandbox-a",
  });

  const client = (adapter as any).db.session.client;
  client.query(`INSERT INTO out_a (run_id, node_id, iteration, value) VALUES (?, ?, ?, ?)`).run(runId, "task:one", 0, 1);
  client.query(`INSERT INTO out_b (run_id, node_id, iteration, value) VALUES (?, ?, ?, ?)`).run(runId, "task:two", 0, 2);

  await adapter.upsertNodeDiffCache({
    runId,
    nodeId: "task:two",
    iteration: 0,
    baseRef: "ptr-one",
    diffJson: JSON.stringify({ patches: [] }),
    computedAtMs: 280,
    sizeBytes: 2,
  });
}

function makeNoVcsHooks() {
  return {
    getCurrentPointerImpl: async (_cwd?: string) => "pre-pointer",
    revertToPointerImpl: async (_pointer: string, _cwd?: string) => ({ success: true }),
  };
}

describe("jumpToFrame", () => {
  test("removes output from a parallel attempt spanning the target frame", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-spanning");
      await captureSnapshot(adapter, "run-spanning", 1, {
        nodes: [{ runId: "run-spanning", nodeId: "task:one", iteration: 0, state: "finished", lastAttempt: 1, updatedAtMs: 160, outputTable: "out_a", label: "one" }],
        outputs: { out_a: [{ nodeId: "task:one", iteration: 0, value: 1 }] },
        ralph: [], input: {}, vcsPointer: null, workflowHash: null,
      } as never);
      const client = (adapter as any).db.session.client;
      client.query(`UPDATE _smithers_attempts SET started_at_ms = ?, finished_at_ms = ? WHERE run_id = ? AND node_id = ?`).run(150, 250, "run-spanning", "task:two");
      await jumpToFrame({ adapter, runId: "run-spanning", frameNo: 1, confirm: true, ...makeNoVcsHooks() });
      expect(client.query(`SELECT * FROM out_b WHERE run_id = ?`).all("run-spanning")).toHaveLength(0);
      expect(await adapter.getNode("run-spanning", "task:two", 0)).toBeUndefined();
      expect((await adapter.listAttemptsForRun("run-spanning")).some((attempt) => attempt.nodeId === "task:two")).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  test("truncates frames/attempts/outputs, invalidates diffs, writes audit row", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-truncate");

      const result = await jumpToFrame({
        adapter,
        runId: "run-truncate",
        frameNo: 1,
        confirm: true,
        caller: "user:owner",
        ...makeNoVcsHooks(),
      });

      expect(result.ok).toBe(true);
      expect(result.newFrameNo).toBe(1);
      expect(result.revertedSandboxes).toBe(1);
      expect(result.deletedFrames).toBe(1);
      expect(result.deletedAttempts).toBe(1);
      expect(result.invalidatedDiffs).toBeGreaterThanOrEqual(1);

      const frames = await adapter.listFrames("run-truncate", 100);
      expect(frames.every((frame) => frame.frameNo <= 1)).toBe(true);

      const attempts = await adapter.listAttemptsForRun("run-truncate");
      expect(attempts.map((attempt) => attempt.nodeId)).toEqual(["task:one"]);

      const client = (adapter as any).db.session.client;
      const outA = client
        .query(`SELECT value FROM out_a WHERE run_id = ? AND node_id = ? AND iteration = ? LIMIT 1`)
        .get("run-truncate", "task:one", 0);
      const outB = client
        .query(`SELECT value FROM out_b WHERE run_id = ? AND node_id = ? AND iteration = ? LIMIT 1`)
        .get("run-truncate", "task:two", 0);
      expect(outA?.value).toBe(1);
      expect(outB).toBeNull();

      const audits = await listRewindAuditRows(adapter, { runId: "run-truncate" });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.result).toBe("success");

      const events = await adapter.listEventsByType("run-truncate", "TimeTravelJumped");
      expect(events).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  test("restores an overwritten target payload, not only the target key set", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-overwrite");
      await captureSnapshot(adapter, "run-overwrite", 1, {
        nodes: [{ runId: "run-overwrite", nodeId: "task:one", iteration: 0, state: "finished", lastAttempt: 1, updatedAtMs: 160, outputTable: "out_a", label: "one" }],
        outputs: { out_a: [{ nodeId: "task:one", iteration: 0, value: 1 }] },
        ralph: [], input: {}, vcsPointer: null, workflowHash: null,
      });
      const client = adapter.db.session.client;
      client.query(`UPDATE out_a SET value = ? WHERE run_id = ? AND node_id = ?`).run(99, "run-overwrite", "task:one");
      await jumpToFrame({ adapter, runId: "run-overwrite", frameNo: 1, confirm: true, ...makeNoVcsHooks() });
      expect(client.query(`SELECT value FROM out_a WHERE run_id = ? AND node_id = ?`).get("run-overwrite", "task:one").value).toBe(1);
      expect(await adapter.getNode("run-overwrite", "task:two", 0)).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  test("input boundaries: invalid runId, invalid frameNo, missing confirm", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await expect(
        jumpToFrame({ adapter, runId: "../etc/passwd", frameNo: 0, confirm: true }),
      ).rejects.toMatchObject({ code: "InvalidRunId" });

      await expect(
        jumpToFrame({ adapter, runId: "run-ok", frameNo: -1, confirm: true }),
      ).rejects.toMatchObject({ code: "InvalidFrameNo" });

      await expect(
        jumpToFrame({ adapter, runId: "run-ok", frameNo: 0, confirm: false }),
      ).rejects.toMatchObject({ code: "ConfirmationRequired" });
    } finally {
      sqlite.close();
    }
  });

  test("frame boundary cases: latest is no-op, +1 is out-of-range, run with no frames", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-bounds");

      const noop = await jumpToFrame({
        adapter,
        runId: "run-bounds",
        frameNo: 2,
        confirm: true,
        caller: "user:owner",
        ...makeNoVcsHooks(),
      });
      expect(noop.ok).toBe(true);
      expect(noop.deletedFrames).toBe(0);
      expect(noop.deletedAttempts).toBe(0);

      await expect(
        jumpToFrame({
          adapter,
          runId: "run-bounds",
          frameNo: 3,
          confirm: true,
          caller: "user:owner",
          ...makeNoVcsHooks(),
        }),
      ).rejects.toMatchObject({ code: "FrameOutOfRange" });

      await adapter.insertRun({
        runId: "run-no-frames",
        workflowName: "wf",
        status: "running",
        createdAtMs: 1,
      });
      await expect(
        jumpToFrame({
          adapter,
          runId: "run-no-frames",
          frameNo: 0,
          confirm: true,
          caller: "user:owner",
          ...makeNoVcsHooks(),
        }),
      ).rejects.toMatchObject({ code: "FrameOutOfRange" });
    } finally {
      sqlite.close();
    }
  });

  test("unsupported sandbox is rejected before state changes", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      const runId = "run-unsupported";
      await adapter.insertRun({
        runId,
        workflowName: "wf",
        status: "finished",
        createdAtMs: 1,
      });
      await adapter.insertFrame({
        runId,
        frameNo: 0,
        createdAtMs: 100,
        xmlJson: "{}",
        xmlHash: "h0",
      });
      await adapter.insertFrame({
        runId,
        frameNo: 1,
        createdAtMs: 200,
        xmlJson: "{}",
        xmlHash: "h1",
      });
      await adapter.insertAttempt({
        runId,
        nodeId: "task:after",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: 150,
        finishedAtMs: 180,
        jjPointer: "ptr-after",
        jjCwd: "/tmp/unsupported",
      });

      await expect(
        jumpToFrame({
          adapter,
          runId,
          frameNo: 0,
          confirm: true,
          caller: "user:owner",
          getCurrentPointerImpl: async () => "pre",
          revertToPointerImpl: async () => ({ success: true }),
        }),
      ).rejects.toMatchObject({ code: "UnsupportedSandbox" });

      const frames = await adapter.listFrames(runId, 10);
      expect(frames).toHaveLength(2);
      const attempts = await adapter.listAttemptsForRun(runId);
      expect(attempts).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  test("rate limit: 11th rewind in one hour returns RateLimited", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-rate");
      const client = (adapter as any).db.session.client;
      for (let index = 0; index < 10; index += 1) {
        client
          .query(
            `INSERT INTO _smithers_time_travel_audit (
               run_id,
               from_frame_no,
               to_frame_no,
               caller,
               timestamp_ms,
               result,
               duration_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run("run-rate", 2, 1, "user:owner", Date.now() - 1_000, "success", 10);
      }

      await expect(
        jumpToFrame({
          adapter,
          runId: "run-rate",
          frameNo: 1,
          confirm: true,
          caller: "user:owner",
          ...makeNoVcsHooks(),
        }),
      ).rejects.toMatchObject({ code: "RateLimited" });

      const audits = await listRewindAuditRows(adapter, { runId: "run-rate" });
      expect(audits).toHaveLength(11);
      expect(audits[10]?.result).toBe("failed");
    } finally {
      sqlite.close();
    }
  });

  test("concurrent second caller gets Busy", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-busy");

      let releasePause: (() => void) | null = null;
      const pauseGate = new Promise<void>((resolve) => {
        releasePause = resolve;
      });

      const first = jumpToFrame({
        adapter,
        runId: "run-busy",
        frameNo: 1,
        confirm: true,
        caller: "user:owner",
        ...makeNoVcsHooks(),
        pauseRunLoop: async () => {
          await pauseGate;
        },
      });

      await Promise.resolve();

      await expect(
        jumpToFrame({
          adapter,
          runId: "run-busy",
          frameNo: 1,
          confirm: true,
          caller: "user:owner",
          ...makeNoVcsHooks(),
        }),
      ).rejects.toMatchObject({ code: "Busy" });

      releasePause?.();
      await expect(first).resolves.toMatchObject({ ok: true });
    } finally {
      sqlite.close();
    }
  });

  test("lost lease ownership aborts before destructive work", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-lease-lost");
      let reverted = false;

      await expect(
        jumpToFrame({
          adapter,
          runId: "run-lease-lost",
          frameNo: 1,
          confirm: true,
          caller: "user:owner",
          getCurrentPointerImpl: async () => "pre-pointer",
          revertToPointerImpl: async () => {
            reverted = true;
            return { success: true };
          },
          hooks: {
            beforeStep: (step) => {
              if (step === "revert-sandboxes") {
                sqlite
                  .query(
                    `UPDATE _smithers_rewind_leases
                        SET owner_token = ?, expires_at_ms = ?
                      WHERE run_id = ?`,
                  )
                  .run("replacement-owner", Date.now() + 60_000, "run-lease-lost");
              }
            },
          },
        }),
      ).rejects.toMatchObject({ code: "Busy" });

      expect(reverted).toBe(false);
      expect(
        (await adapter.listFrames("run-lease-lost", 100))
          .map((frame) => frame.frameNo)
          .sort((a, b) => a - b),
      ).toEqual([0, 1, 2]);
    } finally {
      sqlite.close();
    }
  });

  test("run not found surfaces RunNotFound", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await expect(
        jumpToFrame({
          adapter,
          runId: "run-missing",
          frameNo: 0,
          confirm: true,
          caller: "user:owner",
          ...makeNoVcsHooks(),
        }),
      ).rejects.toMatchObject({ code: "RunNotFound" });
    } finally {
      sqlite.close();
    }
  });

  test("errors are typed JumpToFrameError", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await expect(
        jumpToFrame({ adapter, runId: "bad/..", frameNo: 0, confirm: true }),
      ).rejects.toBeInstanceOf(JumpToFrameError);
    } finally {
      sqlite.close();
    }
  });

  test("rewind truncates snapshots and vcs-tags, not just frames", async () => {
    // Regression: deleteFramesAfter only deleted _smithers_frames, orphaning the
    // _smithers_snapshots and _smithers_vcs_tags rows (both keyed run_id,frame_no)
    // for the discarded frames. Snapshots are the fork/hydration source, so
    // fork/replay/loadLatestSnapshot/timeline could resurrect rewound-away state.
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-snap");
      for (const frameNo of [0, 1, 2]) {
        sqlite
          .query(
            `INSERT INTO _smithers_snapshots (run_id, frame_no, nodes_json, outputs_json, ralph_json, input_json, vcs_pointer, workflow_hash, content_hash, created_at_ms)
             VALUES (?, ?, '[]', '{}', '[]', '{}', ?, 'wh', ?, ?)`,
          )
          .run("run-snap", frameNo, `ptr-${frameNo}`, `ch-${frameNo}`, 100 + frameNo);
        sqlite
          .query(
            `INSERT INTO _smithers_vcs_tags (run_id, frame_no, vcs_type, vcs_pointer, vcs_root, jj_operation_id, created_at_ms)
             VALUES (?, ?, 'jj', ?, '/root', ?, ?)`,
          )
          .run("run-snap", frameNo, `ptr-${frameNo}`, `op-${frameNo}`, 100 + frameNo);
      }

      await jumpToFrame({
        adapter,
        runId: "run-snap",
        frameNo: 1,
        confirm: true,
        caller: "user:owner",
        ...makeNoVcsHooks(),
      });

      const snapshots = sqlite
        .query(`SELECT frame_no FROM _smithers_snapshots WHERE run_id = ? ORDER BY frame_no`)
        .all("run-snap") as Array<{ frame_no: number }>;
      const vcsTags = sqlite
        .query(`SELECT frame_no FROM _smithers_vcs_tags WHERE run_id = ? ORDER BY frame_no`)
        .all("run-snap") as Array<{ frame_no: number }>;
      // Frame 2 (after the rewind target) is discarded from BOTH side tables.
      expect(snapshots.map((row) => row.frame_no)).toEqual([0, 1]);
      expect(vcsTags.map((row) => row.frame_no)).toEqual([0, 1]);
    } finally {
      sqlite.close();
    }
  });

  test("refuses to rewind a run that still looks live, unless forced", async () => {
    // A rewind must also reject a still-live engine owner. The durable rewind
    // lease coordinates rewind operators, while this guard prevents the engine
    // itself from writing frames during the destructive operation.
    const { adapter, sqlite } = setupDb();
    try {
      await adapter.insertRun({
        runId: "run-live",
        workflowName: "wf",
        status: "running",
        createdAtMs: 1,
        startedAtMs: 1,
        heartbeatAtMs: 1_000,
        configJson: JSON.stringify({ auth: { triggeredBy: "user:owner" } }),
      });
      for (const [frameNo, createdAtMs, hash] of [[0, 100, "h0"], [1, 200, "h1"]] as const) {
        await adapter.insertFrame({
          runId: "run-live",
          frameNo,
          createdAtMs,
          xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: { frame: frameNo } }),
          xmlHash: hash,
          mountedTaskIdsJson: "[]",
          taskIndexJson: "[]",
          note: `f${frameNo}`,
        });
      }

      // now == heartbeat → fresh → the run looks live → rewind rejected.
      await expect(
        jumpToFrame({
          adapter,
          runId: "run-live",
          frameNo: 0,
          confirm: true,
          caller: "user:owner",
          nowMs: () => 1_000,
          ...makeNoVcsHooks(),
        }),
      ).rejects.toMatchObject({ code: "RunOwnerAlive" });

      // force:true bypasses the guard (operator has confirmed the engine is stopped).
      const forced = await jumpToFrame({
        adapter,
        runId: "run-live",
        frameNo: 0,
        confirm: true,
        force: true,
        caller: "user:owner",
        nowMs: () => 1_000,
        ...makeNoVcsHooks(),
      });
      expect(forced.ok).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});

describe("jumpToFrame seams and rollback", () => {
  test("runs step hooks, broadcasts the event, resumes the loop, and skips missing output tables", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-seams");
      // A to-be-deleted node whose output table does not exist exercises the
      // "no such table" continue branch of the output truncation.
      await adapter.insertNode({
        runId: "run-seams", nodeId: "task:three", iteration: 0, state: "finished",
        lastAttempt: 1, updatedAtMs: 285, outputTable: "out_missing", label: "three",
      });
      await adapter.insertAttempt({
        runId: "run-seams", nodeId: "task:three", iteration: 0, attempt: 1, state: "finished",
        startedAtMs: 280, finishedAtMs: 290, jjPointer: "ptr-three", jjCwd: null,
      });

      const steps: Array<{ stage: string; step: string }> = [];
      const events: unknown[] = [];
      let resumed = false;
      let reconcilerCaptured = false;
      let reconcilerRebuilt = false;

      const result = await jumpToFrame({
        adapter,
        runId: "run-seams",
        frameNo: 1,
        confirm: true,
        caller: "user:owner",
        ...makeNoVcsHooks(),
        hooks: {
          beforeStep: async (step: string) => { steps.push({ stage: "before", step }); },
          afterStep: async (step: string) => { steps.push({ stage: "after", step }); },
        },
        emitEvent: (event: unknown) => { events.push(event); },
        pauseRunLoop: async () => {},
        resumeRunLoop: async () => { resumed = true; },
        captureReconcilerState: async () => { reconcilerCaptured = true; return { snap: 1 }; },
        rebuildReconcilerState: async (_xml: string) => { reconcilerRebuilt = true; },
      } as never);

      expect(result.ok).toBe(true);
      expect(events).toHaveLength(1);
      expect(resumed).toBe(true);
      expect(reconcilerCaptured).toBe(true);
      expect(reconcilerRebuilt).toBe(true);
      expect(steps.some((s) => s.stage === "after" && s.step === "resume-event-loop")).toBe(true);
      expect(steps.some((s) => s.stage === "before" && s.step === "truncate-outputs")).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  test("a failed event broadcast is logged and non-fatal (non-Error rejection)", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-emitfail");
      const logs: Array<{ level: string; message: string; fields: Record<string, unknown> }> = [];

      const result = await jumpToFrame({
        adapter,
        runId: "run-emitfail",
        frameNo: 1,
        confirm: true,
        caller: "user:owner",
        ...makeNoVcsHooks(),
        // Throw a non-Error so formatError must coerce it via String().
        emitEvent: () => { throw "emit exploded"; },
        onLog: async (level: string, message: string, fields: Record<string, unknown>) => {
          logs.push({ level, message, fields });
        },
      } as never);

      expect(result.ok).toBe(true);
      const emitLogEntry = logs.find((l) => l.message.includes("emit broadcast failed"));
      expect(emitLogEntry).toBeDefined();
      expect(String(emitLogEntry?.fields.error)).toContain("emit exploded");
    } finally {
      sqlite.close();
    }
  });

  test("a post-commit resume failure still resolves as a committed success", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-postcommit");
      const logs: Array<{ level: string; message: string }> = [];

      const result = await jumpToFrame({
        adapter,
        runId: "run-postcommit",
        frameNo: 1,
        confirm: true,
        caller: "user:owner",
        ...makeNoVcsHooks(),
        pauseRunLoop: async () => {},
        resumeRunLoop: async () => { throw new Error("resume boom"); },
        onLog: async (level: string, message: string) => { logs.push({ level, message }); },
      } as never);

      // The durable jump committed, so a resume failure after commit is tolerated.
      expect(result.ok).toBe(true);
      expect(result.newFrameNo).toBe(1);
      expect(logs.some((l) => l.message.includes("resume after commit failed"))).toBe(true);
      expect(logs.some((l) => l.message.includes("post-commit step failed"))).toBe(true);
      // The frame truncation is durable.
      const frames = await adapter.listFrames("run-postcommit", 100);
      expect(frames.every((frame) => frame.frameNo <= 1)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  test("a pre-commit failure rolls back and flags the run when the rollback is partial", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-rollback");
      const logs: Array<{ level: string; message: string }> = [];

      await expect(
        jumpToFrame({
          adapter,
          runId: "run-rollback",
          frameNo: 1,
          confirm: true,
          caller: "user:owner",
          // No pre-jump pointer: the sandbox rollback cannot be restored.
          getCurrentPointerImpl: async () => null,
          revertToPointerImpl: async () => ({ success: true }),
          captureReconcilerState: async () => ({ snap: 1 }),
          // Both rollback steps fail, forcing the "needs attention" partial path.
          restoreReconcilerState: async () => { throw new Error("restore boom"); },
          pauseRunLoop: async () => {},
          resumeRunLoop: async () => { throw new Error("resume boom"); },
          // Fail the durable transaction before it commits.
          hooks: {
            beforeStep: async (step: string) => {
              if (step === "truncate-frames") throw new Error("hook boom");
            },
          },
          onLog: async (level: string, message: string) => { logs.push({ level, message }); },
        } as never),
      ).rejects.toMatchObject({ code: "RewindFailed" });

      // The run was flagged for attention and nothing durable was truncated.
      const run = await adapter.getRun("run-rollback");
      expect(["needs_attention", "failed"]).toContain(run?.status);
      const frames = await adapter.listFrames("run-rollback", 100);
      expect(frames.map((f) => f.frameNo).sort()).toEqual([0, 1, 2]);
      expect(logs.some((l) => l.message.includes("rollback partial"))).toBe(true);
      const audits = await listRewindAuditRows(adapter, { runId: "run-rollback" });
      expect(audits.at(-1)?.result).toBe("partial");
    } finally {
      sqlite.close();
    }
  });

  test("a terminal audit-update failure is logged but does not undo a committed jump", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-auditfail");
      // A trigger that vetoes UPDATEs to the audit table makes the terminal
      // audit update (in the finally) a real DB fault after a committed jump.
      // The durable jump already committed, so it must still resolve as a
      // success while the audit-write failure is caught and logged.
      sqlite.exec(`
        CREATE TRIGGER block_audit_update BEFORE UPDATE ON _smithers_time_travel_audit
        BEGIN
          SELECT RAISE(ABORT, 'audit update blocked');
        END;
      `);
      const logs: Array<{ level: string; message: string; fields: Record<string, unknown> }> = [];

      const result = await jumpToFrame({
        adapter,
        runId: "run-auditfail",
        frameNo: 1,
        confirm: true,
        caller: "user:owner",
        ...makeNoVcsHooks(),
        onLog: async (level: string, message: string, fields: Record<string, unknown>) => {
          logs.push({ level, message, fields });
        },
      } as never);

      expect(result.ok).toBe(true);
      // The durable jump committed (frame 2 truncated) even though the audit
      // update was vetoed and left the row at "in_progress".
      const frames = await adapter.listFrames("run-auditfail", 100);
      expect(frames.every((frame) => frame.frameNo <= 1)).toBe(true);
      const auditFailLog = logs.find((l) => l.message.includes("audit write failed"));
      expect(auditFailLog).toBeDefined();
      expect(auditFailLog?.level).toBe("error");
      const audits = await listRewindAuditRows(adapter, { runId: "run-auditfail" });
      expect(audits.at(-1)?.result).toBe("in_progress");
    } finally {
      sqlite.close();
    }
  });
});
