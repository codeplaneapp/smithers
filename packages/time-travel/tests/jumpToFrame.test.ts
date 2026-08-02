import { describe, expect, setDefaultTimeout, test } from "bun:test";

// Frame surgery over real stores runs just past bun's 5s default on the
// slower Windows CI runners (observed 5.0s); the work is real, not hung.
setDefaultTimeout(20_000);
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { SmithersDb } from "@smthrs/db/adapter";
import { Effect } from "effect";
import { JumpToFrameError, jumpToFrame } from "../src/jumpToFrame.js";
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
  client
    .query(`INSERT INTO out_a (run_id, node_id, iteration, value) VALUES (?, ?, ?, ?)`)
    .run(runId, "task:one", 0, 1);
  client
    .query(`INSERT INTO out_b (run_id, node_id, iteration, value) VALUES (?, ?, ?, ?)`)
    .run(runId, "task:two", 0, 2);

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

async function insertBlockingRewindEffect(adapter: SmithersDb, runId: string) {
  await Effect.runPromise(
    adapter.insertToolCall({
      runId,
      nodeId: "task:two",
      iteration: 0,
      attempt: 1,
      seq: 1,
      toolName: "unrevertible-rewind-effect",
      inputJson: "{}",
      outputJson: "{}",
      startedAtMs: 250,
      finishedAtMs: 260,
      status: "succeeded",
      errorJson: null,
      kind: "tool",
      sideEffect: true,
      idempotent: false,
      acceptsIdempotencyKey: false,
      hasRevert: false,
      idempotencyKey: null,
      revertStatus: null,
      revertedAtMs: null,
      revertErrorJson: null,
      forcedPastJson: null,
    }),
  );
}

function rewindRunState(run: Awaited<ReturnType<SmithersDb["getRun"]>>) {
  return {
    status: run?.status ?? null,
    finishedAtMs: run?.finishedAtMs ?? null,
    heartbeatAtMs: run?.heartbeatAtMs ?? null,
    runtimeOwnerId: run?.runtimeOwnerId ?? null,
    cancelRequestedAtMs: run?.cancelRequestedAtMs ?? null,
    hijackRequestedAtMs: run?.hijackRequestedAtMs ?? null,
    hijackTarget: run?.hijackTarget ?? null,
    errorJson: run?.errorJson ?? null,
  };
}

async function rewindTransition(status: "running" | "finished", forced: boolean) {
  const { adapter, sqlite } = setupDb();
  const runId = `${forced ? "forced" : "unforced"}-${status}-transition`;
  try {
    await seedRun(adapter, runId);
    await adapter.updateRun(runId, {
      status,
      finishedAtMs: status === "finished" ? 999 : null,
      heartbeatAtMs: 1,
      runtimeOwnerId: "stale-engine-owner",
      errorJson: JSON.stringify({ previous: true }),
    });
    if (forced) await insertBlockingRewindEffect(adapter, runId);
    await jumpToFrame({
      adapter,
      runId,
      frameNo: 1,
      confirm: true,
      force: forced,
      nowMs: () => 100_000,
      ...makeNoVcsHooks(),
    });
    return rewindRunState(await adapter.getRun(runId));
  } finally {
    sqlite.close();
  }
}

describe("jumpToFrame", () => {
  test("removes output from a parallel attempt spanning the target frame", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-spanning");
      await captureSnapshot(adapter, "run-spanning", 1, {
        nodes: [
          {
            runId: "run-spanning",
            nodeId: "task:one",
            iteration: 0,
            state: "finished",
            lastAttempt: 1,
            updatedAtMs: 160,
            outputTable: "out_a",
            label: "one",
          },
        ],
        outputs: { out_a: [{ nodeId: "task:one", iteration: 0, value: 1 }] },
        ralph: [],
        input: {},
        vcsPointer: null,
        workflowHash: null,
      } as never);
      const client = (adapter as any).db.session.client;
      client
        .query(`UPDATE _smithers_attempts SET started_at_ms = ?, finished_at_ms = ? WHERE run_id = ? AND node_id = ?`)
        .run(150, 250, "run-spanning", "task:two");
      await jumpToFrame({ adapter, runId: "run-spanning", frameNo: 1, confirm: true, ...makeNoVcsHooks() });
      expect(client.query(`SELECT * FROM out_b WHERE run_id = ?`).all("run-spanning")).toHaveLength(0);
      expect(await adapter.getNode("run-spanning", "task:two", 0)).toBeUndefined();
      expect((await adapter.listAttemptsForRun("run-spanning")).some((attempt) => attempt.nodeId === "task:two")).toBe(
        false,
      );
    } finally {
      sqlite.close();
    }
  });

  test("keeps a snapshot-finished node finished when it was retried after the rewind point", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-retry-survivor");
      await captureSnapshot(adapter, "run-retry-survivor", 1, {
        nodes: [
          {
            runId: "run-retry-survivor",
            nodeId: "task:one",
            iteration: 0,
            state: "finished",
            lastAttempt: 1,
            updatedAtMs: 160,
            outputTable: "out_a",
            label: "one",
          },
        ],
        outputs: { out_a: [{ nodeId: "task:one", iteration: 0, value: 1 }] },
        ralph: [],
        input: {},
        vcsPointer: null,
        workflowHash: null,
      } as never);
      // Retry AFTER the target frame (frame 1 createdAtMs=200): attempt 2 starts
      // at 250. The legacy heuristic reset any node with a post-target attempt to
      // pending, stomping the snapshot-restored finished state.
      await adapter.insertAttempt({
        runId: "run-retry-survivor",
        nodeId: "task:one",
        iteration: 0,
        attempt: 2,
        state: "finished",
        startedAtMs: 250,
        finishedAtMs: 270,
        jjPointer: "ptr-one-retry",
        jjCwd: "/tmp/sandbox-a",
      });
      const client = (adapter as any).db.session.client;
      client
        .query(`UPDATE _smithers_nodes SET last_attempt = ?, updated_at_ms = ? WHERE run_id = ? AND node_id = ?`)
        .run(2, 270, "run-retry-survivor", "task:one");
      await jumpToFrame({ adapter, runId: "run-retry-survivor", frameNo: 1, confirm: true, ...makeNoVcsHooks() });
      const node = await adapter.getNode("run-retry-survivor", "task:one", 0);
      expect(node?.state).toBe("finished");
      expect(node?.lastAttempt).toBe(1);
      expect(
        client.query(`SELECT value FROM out_a WHERE run_id = ? AND node_id = ?`).all("run-retry-survivor", "task:one"),
      ).toEqual([{ value: 1 }]);
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
        nodes: [
          {
            runId: "run-overwrite",
            nodeId: "task:one",
            iteration: 0,
            state: "finished",
            lastAttempt: 1,
            updatedAtMs: 160,
            outputTable: "out_a",
            label: "one",
          },
        ],
        outputs: { out_a: [{ nodeId: "task:one", iteration: 0, value: 1 }] },
        ralph: [],
        input: {},
        vcsPointer: null,
        workflowHash: null,
      });
      const client = adapter.db.session.client;
      client.query(`UPDATE out_a SET value = ? WHERE run_id = ? AND node_id = ?`).run(99, "run-overwrite", "task:one");
      await jumpToFrame({ adapter, runId: "run-overwrite", frameNo: 1, confirm: true, ...makeNoVcsHooks() });
      expect(
        client.query(`SELECT value FROM out_a WHERE run_id = ? AND node_id = ?`).get("run-overwrite", "task:one").value,
      ).toBe(1);
      expect(await adapter.getNode("run-overwrite", "task:two", 0)).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  test("preserves durable signals when restoring a legacy snapshot without a signal horizon", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-legacy-signals");
      sqlite
        .query(`INSERT INTO _smithers_snapshots (run_id, frame_no, nodes_json, outputs_json, ralph_json, input_json, vcs_pointer, workflow_hash, content_hash, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          "run-legacy-signals",
          1,
          JSON.stringify([
            {
              runId: "run-legacy-signals",
              nodeId: "task:one",
              iteration: 0,
              state: "finished",
              lastAttempt: 1,
              updatedAtMs: 160,
              outputTable: "out_a",
              label: "one",
            },
          ]),
          JSON.stringify({ out_a: [{ nodeId: "task:one", iteration: 0, value: 1 }] }),
          "[]",
          "{}",
          null,
          null,
          "legacy-signals",
          200,
        );
      await adapter.insertSignalWithNextSeq({
        runId: "run-legacy-signals",
        signalName: "before",
        correlationId: null,
        payloadJson: JSON.stringify({ value: 1 }),
        receivedAtMs: 1,
        receivedBy: "test",
      });
      await adapter.insertSignalWithNextSeq({
        runId: "run-legacy-signals",
        signalName: "after",
        correlationId: null,
        payloadJson: JSON.stringify({ value: 2 }),
        receivedAtMs: 2,
        receivedBy: "test",
      });
      const before = await adapter.listSignals("run-legacy-signals");
      expect(
        sqlite.query(`SELECT frame_no FROM _smithers_snapshots WHERE run_id = ?`).all("run-legacy-signals"),
      ).toEqual([{ frame_no: 1 }]);

      await jumpToFrame({ adapter, runId: "run-legacy-signals", frameNo: 1, confirm: true, ...makeNoVcsHooks() });

      expect(await adapter.listSignals("run-legacy-signals")).toEqual(before);
    } finally {
      sqlite.close();
    }
  });

  test("input boundaries: invalid runId, invalid frameNo, missing confirm", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await expect(jumpToFrame({ adapter, runId: "../etc/passwd", frameNo: 0, confirm: true })).rejects.toMatchObject({
        code: "InvalidRunId",
      });

      await expect(jumpToFrame({ adapter, runId: "run-ok", frameNo: -1, confirm: true })).rejects.toMatchObject({
        code: "InvalidFrameNo",
      });

      await expect(jumpToFrame({ adapter, runId: "run-ok", frameNo: 0, confirm: false })).rejects.toMatchObject({
        code: "ConfirmationRequired",
      });
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
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
      expect(audits[10]?.result).toBe("rejected");
    } finally {
      sqlite.close();
    }
  });

  test("rate limit: rejected retries do not extend the lockout past the window", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedRun(adapter, "run-rate-retry");
      const client = (adapter as any).db.session.client;
      const t0 = 10_000_000;
      const rateLimit = { maxPerWindow: 2, windowMs: 60_000 };
      for (let index = 0; index < 2; index += 1) {
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
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("run-rate-retry", 2, 1, "user:owner", t0, "success", 10);
      }

      // Two rejected retries inside the window; each writes an audit row.
      for (const offsetMs of [1_000, 59_000]) {
        await expect(
          jumpToFrame({
            adapter,
            runId: "run-rate-retry",
            frameNo: 1,
            confirm: true,
            caller: "user:owner",
            rateLimit,
            nowMs: () => t0 + offsetMs,
            ...makeNoVcsHooks(),
          }),
        ).rejects.toMatchObject({ code: "RateLimited" });
      }

      // Once the two real rewinds age out, the quota must drain even though the
      // rejection rows are still inside the trailing window.
      await expect(
        jumpToFrame({
          adapter,
          runId: "run-rate-retry",
          frameNo: 1,
          confirm: true,
          caller: "user:owner",
          rateLimit,
          nowMs: () => t0 + 61_000,
          ...makeNoVcsHooks(),
        }),
      ).resolves.toMatchObject({ ok: true });

      const audits = await listRewindAuditRows(adapter, { runId: "run-rate-retry" });
      expect(audits.map((row) => row.result)).toEqual(["success", "success", "rejected", "rejected", "success"]);
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
        (await adapter.listFrames("run-lease-lost", 100)).map((frame) => frame.frameNo).sort((a, b) => a - b),
      ).toEqual([0, 1, 2]);
    } finally {
      sqlite.close();
    }
  });

  test("lease steal during sandbox restoration skips stale-owner rollback", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      const runId = "run-lease-stolen-during-sandbox";
      await seedRun(adapter, runId);
      let currentPointer = "pre-pointer";
      const pointerWrites: string[] = [];

      await expect(
        jumpToFrame({
          adapter,
          runId,
          frameNo: 1,
          confirm: true,
          caller: "user:owner",
          getCurrentPointerImpl: async () => currentPointer,
          revertToPointerImpl: async (pointer: string) => {
            pointerWrites.push(pointer);
            currentPointer = pointer;
            return { success: true };
          },
          hooks: {
            afterStep: (step) => {
              if (step !== "revert-sandboxes") return;
              sqlite
                .query(
                  `UPDATE _smithers_rewind_leases
                      SET owner_token = ?, expires_at_ms = ?
                    WHERE run_id = ?`,
                )
                .run("replacement-owner", Date.now() + 60_000, runId);
              currentPointer = "replacement-owner-pointer";
              throw new Error("replacement owner took over after sandbox restore");
            },
          },
        } as never),
      ).rejects.toMatchObject({
        code: "Busy",
        details: { rollbackSkipped: true },
      });

      expect(pointerWrites).toEqual(["ptr-one"]);
      expect(currentPointer).toBe("replacement-owner-pointer");
      const audits = await listRewindAuditRows(adapter, { runId });
      expect(audits.at(-1)?.result).toBe("partial");
      const durableNotes = await adapter.listEventsByType(runId, "TimeTravelFinished");
      expect(durableNotes).toHaveLength(1);
      expect(JSON.parse(durableNotes[0].payloadJson)).toMatchObject({
        success: false,
        error: expect.stringContaining("rollback skipped because lease ownership was lost"),
      });
    } finally {
      sqlite.close();
    }
  });

  test("lease loss after one sandbox rollback skips every remaining sandbox and reconciler write", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      const runId = "run-lease-stolen-mid-rollback";
      await seedRun(adapter, runId);
      sqlite
        .query(`
        UPDATE _smithers_attempts
           SET jj_cwd = ?
         WHERE run_id = ? AND node_id = ?
      `)
        .run("/tmp/sandbox-b", runId, "task:two");
      await adapter.insertAttempt({
        runId,
        nodeId: "sandbox-b-base",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: 120,
        finishedAtMs: 130,
        jjPointer: "ptr-b-base",
        jjCwd: "/tmp/sandbox-b",
      });
      await adapter.insertAttempt({
        runId,
        nodeId: "task:one",
        iteration: 0,
        attempt: 2,
        state: "finished",
        startedAtMs: 240,
        finishedAtMs: 245,
        jjPointer: "ptr-one-retry",
        jjCwd: "/tmp/sandbox-a",
      });

      const rollbackWrites: Array<{ pointer: string; cwd?: string }> = [];
      let reconcilerRestored = false;
      await expect(
        jumpToFrame({
          adapter,
          runId,
          frameNo: 1,
          confirm: true,
          caller: "user:owner",
          getCurrentPointerImpl: async (cwd?: string) => `pre:${cwd}`,
          revertToPointerImpl: async (pointer: string, cwd?: string) => {
            if (pointer.startsWith("pre:")) {
              rollbackWrites.push({ pointer, cwd });
              if (rollbackWrites.length === 1) {
                sqlite
                  .query(`
                UPDATE _smithers_rewind_leases
                   SET owner_token = ?, expires_at_ms = ?
                 WHERE run_id = ?
              `)
                  .run("replacement-owner", Date.now() + 60_000, runId);
              }
            }
            return { success: true };
          },
          captureReconcilerState: async () => ({ before: true }),
          restoreReconcilerState: async () => {
            reconcilerRestored = true;
          },
          hooks: {
            afterStep: (step) => {
              if (step === "revert-sandboxes") {
                throw new Error("force rollback after both forward restores");
              }
            },
          },
        } as never),
      ).rejects.toMatchObject({
        code: "Busy",
        details: {
          rollbackSkipped: true,
          rollbackRestoredSandboxes: [expect.any(String)],
          rollbackSkippedSandboxes: [expect.any(String)],
          rollbackReconcilerSkipped: true,
        },
      });

      expect(rollbackWrites).toHaveLength(1);
      expect(reconcilerRestored).toBe(false);
      const durableNotes = await adapter.listEventsByType(runId, "TimeTravelFinished");
      expect(durableNotes).toHaveLength(1);
      expect(JSON.parse(durableNotes[0].payloadJson)).toMatchObject({
        success: false,
        rollbackRestoredSandboxes: [expect.any(String)],
        rollbackSkippedSandboxes: [expect.any(String)],
        rollbackReconcilerSkipped: true,
        error: expect.stringContaining("Restored sandboxes:"),
      });
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
      await expect(jumpToFrame({ adapter, runId: "bad/..", frameNo: 0, confirm: true })).rejects.toBeInstanceOf(
        JumpToFrameError,
      );
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
      for (const [frameNo, createdAtMs, hash] of [
        [0, 100, "h0"],
        [1, 200, "h1"],
      ] as const) {
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

  test("forced rewind of a running run matches unforced run-state transitions byte-for-byte", async () => {
    const [unforced, forced] = await Promise.all([
      rewindTransition("running", false),
      rewindTransition("running", true),
    ]);
    expect(JSON.stringify(forced)).toBe(JSON.stringify(unforced));
    expect(forced).toEqual({
      status: "running",
      finishedAtMs: null,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      cancelRequestedAtMs: null,
      hijackRequestedAtMs: null,
      hijackTarget: null,
      errorJson: null,
    });
  });

  test("forced rewind of a finished run matches unforced run-state transitions byte-for-byte", async () => {
    const [unforced, forced] = await Promise.all([
      rewindTransition("finished", false),
      rewindTransition("finished", true),
    ]);
    expect(JSON.stringify(forced)).toBe(JSON.stringify(unforced));
    expect(forced).toEqual({
      status: "running",
      finishedAtMs: null,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      cancelRequestedAtMs: null,
      hijackRequestedAtMs: null,
      hijackTarget: null,
      errorJson: null,
    });
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
        runId: "run-seams",
        nodeId: "task:three",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: 285,
        outputTable: "out_missing",
        label: "three",
      });
      await adapter.insertAttempt({
        runId: "run-seams",
        nodeId: "task:three",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: 280,
        finishedAtMs: 290,
        jjPointer: "ptr-three",
        jjCwd: null,
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
          beforeStep: async (step: string) => {
            steps.push({ stage: "before", step });
          },
          afterStep: async (step: string) => {
            steps.push({ stage: "after", step });
          },
        },
        emitEvent: (event: unknown) => {
          events.push(event);
        },
        pauseRunLoop: async () => {},
        resumeRunLoop: async () => {
          resumed = true;
        },
        captureReconcilerState: async () => {
          reconcilerCaptured = true;
          return { snap: 1 };
        },
        rebuildReconcilerState: async (_xml: string) => {
          reconcilerRebuilt = true;
        },
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
        emitEvent: () => {
          throw "emit exploded";
        },
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
        resumeRunLoop: async () => {
          throw new Error("resume boom");
        },
        onLog: async (level: string, message: string) => {
          logs.push({ level, message });
        },
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
          restoreReconcilerState: async () => {
            throw new Error("restore boom");
          },
          pauseRunLoop: async () => {},
          resumeRunLoop: async () => {
            throw new Error("resume boom");
          },
          // Fail the durable transaction before it commits.
          hooks: {
            beforeStep: async (step: string) => {
              if (step === "truncate-frames") throw new Error("hook boom");
            },
          },
          onLog: async (level: string, message: string) => {
            logs.push({ level, message });
          },
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
