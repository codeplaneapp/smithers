/**
 * jumpToFrame (rewind) coverage on the PostgreSQL/PGlite backend.
 *
 * Regression guard for the bun:sqlite hard-wiring: rewind used to resolve the
 * bun:sqlite client directly (`adapter.db.session.client`) and threw an opaque
 * `TypeError: Could not resolve Bun SQLite client from adapter.` on any Postgres
 * or PGlite adapter. Every rewind mutation now runs through the adapter's
 * dialect-agnostic internalStorage, so the whole path (frame reads, frame/
 * attempt/output truncation, node reset, and the TimeTravelJumped event insert)
 * works on Postgres too.
 *
 * Boots a persistent Postgres/PGlite descriptor (via the engine builder, the
 * same harness as engine/tests/time-travel-postgres.test.js) so the engine and
 * the rewind API share one connection. Set SMITHERS_TEST_PG_URL to run against a
 * real PostgreSQL; otherwise an embedded PGlite is booted (slow first run: WASM
 * compile). PGlite's socket server desyncs node-postgres on Windows CI, so this
 * skips there unless a real PG URL is supplied.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import React from "react";
import { Context, Effect, Schema } from "effect";
import { Workflow } from "@smthrs/components/components/index";
import { SmithersDb } from "@smthrs/db/adapter";
import { runWorkflow, Smithers, __builderInternals as I } from "@smthrs/engine";
import { jumpToFrame } from "../src/jumpToFrame.js";
import { listRewindAuditRows } from "../src/listRewindAuditRows.js";
import { recoverInProgressRewindAudits } from "../src/recoverInProgressRewindAudits.js";
import { writeRewindAuditRow } from "../src/writeRewindAuditRow.js";
import { captureSnapshot } from "../src/snapshot/index.js";
import {
  deleteAgentCheckpointAttemptsByKeys,
  persistAgentCheckpointRows,
} from "../src/snapshot/agentCheckpointPersistence.js";

setDefaultTimeout(180_000);

const PG_URL = process.env.SMITHERS_TEST_PG_URL;

const inputSchema = Schema.Struct({ variant: Schema.String });
const outputSchema = Schema.Struct({ value: Schema.Number });

/**
 * Boot a persistent Postgres/PGlite descriptor for the given builder handles
 * plus a SmithersDb over it. Returns the descriptor, adapter, and teardown.
 */
async function bootPg(handles: Array<object>) {
  const config = PG_URL ? { provider: "postgres" as const, connectionString: PG_URL } : { provider: "pglite" as const };
  const runtime = await I.createBuilderDbPostgres(config, handles);
  const adapter = new SmithersDb(runtime.db);
  return { db: runtime.db, adapter, close: runtime.close as () => Promise<void> };
}

function makeWorkflow(name: string, root: object, db: object, env: object, decodedInput: unknown) {
  return {
    db,
    build: (ctx: unknown) => React.createElement(Workflow, { name }, I.renderNode(root, ctx, decodedInput, env)),
    opts: {},
  };
}

function uniqueRunId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${process.pid}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

describe.skipIf(process.platform === "win32" && !PG_URL)("jumpToFrame rewind (postgres)", () => {
  test("bulk checkpoint restoration uses the PostgreSQL batch and content-lock path", async () => {
    const { adapter, close } = await bootPg([]);
    const runId = uniqueRunId("pg-checkpoint-bulk");
    const checkpointJson = JSON.stringify({ codec: "test.pg", version: 1, payload: { cursor: 1 } });
    const contentHash = createHash("sha256").update(checkpointJson).digest("hex");
    const attempt = {
      runId,
      nodeId: "agent",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 1,
      finishedAtMs: 2,
      heartbeatAtMs: null,
      heartbeatDataJson: null,
      errorJson: null,
      jjPointer: null,
      cached: false,
      metaJson: null,
      responseText: null,
      jjCwd: null,
    };
    const checkpoint = {
      runId,
      nodeId: "agent",
      iteration: 0,
      attempt: 1,
      sequence: 0,
      contentHash,
      codec: "test.pg",
      version: 1,
      agentId: null,
      purpose: "resume",
      createdAtMs: 2,
      checkpointJson,
      sizeBytes: Buffer.byteLength(checkpointJson),
      contentCreatedAtMs: 2,
    };
    try {
      await adapter.insertRun({ runId, workflowName: "pg-checkpoint-bulk", status: "finished", createdAtMs: 1 });
      await adapter.withTransaction(
        "postgres checkpoint batch restore",
        Effect.tryPromise(() =>
          persistAgentCheckpointRows(adapter, {
            runId,
            attempts: [attempt],
            checkpoints: [checkpoint],
            replaceCheckpointRefs: true,
          }),
        ),
      );
      expect(await adapter.listAgentCheckpointRefs(runId)).toMatchObject([{ contentHash, sequence: 0 }]);
      expect(await adapter.getAgentCheckpoint(contentHash)).toMatchObject({ checkpointJson });
      if (PG_URL) {
        const before = await adapter.internalStorage.queryOne(
          `SELECT ctid::text AS ctid, xmin::text AS xmin
             FROM _smithers_agent_checkpoint_contents
            WHERE content_hash = ?`,
          [contentHash],
        );
        await adapter.withTransaction(
          "postgres checkpoint repeat materialization",
          Effect.tryPromise(() =>
            persistAgentCheckpointRows(adapter, {
              runId,
              attempts: [attempt],
              checkpoints: [checkpoint],
              replaceCheckpointRefs: true,
            }),
          ),
        );
        const after = await adapter.internalStorage.queryOne(
          `SELECT ctid::text AS ctid, xmin::text AS xmin
             FROM _smithers_agent_checkpoint_contents
            WHERE content_hash = ?`,
          [contentHash],
        );
        expect(after).toEqual(before);
      }
      const snapshot = await captureSnapshot(adapter, runId, 0, {
        nodes: [
          {
            nodeId: "agent",
            iteration: 0,
            state: "finished",
            lastAttempt: 1,
            outputTable: "",
            label: null,
          },
        ],
        outputs: {},
        ralph: [],
        input: {},
      });
      const snapshotOutputs = JSON.parse(snapshot.outputsJson);
      expect(snapshotOutputs.__smithersAgentCheckpointProvenance.version).toBe(1);
      expect(
        snapshotOutputs.__smithersAgentCheckpointProvenance.attempts.map((tuple: unknown[]) => tuple.slice(0, 3)),
      ).toEqual([["agent", 0, 1]]);
      expect(
        snapshotOutputs.__smithersAgentCheckpointProvenance.checkpoints.map((tuple: unknown[]) => tuple.slice(0, 5)),
      ).toEqual([["agent", 0, 1, 0, contentHash]]);

      await adapter.withTransaction(
        "postgres checkpoint batch delete",
        Effect.tryPromise(() => deleteAgentCheckpointAttemptsByKeys(adapter, runId, [["agent", 0, 1]])),
      );
      expect(await adapter.listAttemptsForRun(runId)).toEqual([]);
      expect(await adapter.listAgentCheckpointRefs(runId)).toEqual([]);
    } finally {
      await close();
    }
  });

  test("claims stale audits with portable RETURNING and a live-lease predicate", async () => {
    const { adapter, close } = await bootPg([]);
    const now = 500_000;
    const runId = uniqueRunId("pg-rewind-recovery");
    try {
      await adapter.insertRun({
        runId,
        workflowName: "pg-rewind-recovery",
        status: "running",
        createdAtMs: 1,
      });
      const id = await writeRewindAuditRow(adapter, {
        runId,
        fromFrameNo: 5,
        toFrameNo: 2,
        caller: "user:pg-integration",
        timestampMs: now - 10_000,
        result: "in_progress",
        durationMs: null,
      });
      await adapter.internalStorage.execute(
        `INSERT INTO _smithers_rewind_leases (run_id, owner_token, expires_at_ms)
           VALUES (?, ?, ?)`,
        [runId, "pg-owner", now + 60_000],
      );

      expect(
        await recoverInProgressRewindAudits(adapter, {
          nowMs: () => now,
          staleAfterMs: 0,
        }),
      ).toEqual({ recovered: [] });
      expect((await listRewindAuditRows(adapter, { runId }))[0]?.result).toBe("in_progress");

      await adapter.internalStorage.execute(`UPDATE _smithers_rewind_leases SET expires_at_ms = ? WHERE run_id = ?`, [
        now,
        runId,
      ]);
      expect(
        await recoverInProgressRewindAudits(adapter, {
          nowMs: () => now,
          staleAfterMs: 0,
        }),
      ).toEqual({ recovered: [{ id: id as number, runId }] });
      expect((await listRewindAuditRows(adapter, { runId }))[0]).toMatchObject({
        result: "partial",
        durationMs: 10_000,
      });
      expect((await adapter.getRun(runId))?.status).toBe("failed");
    } finally {
      await close();
    }
  });

  test("rewinds a finished run to the earliest frame and resume re-executes tasks", async () => {
    let callsA = 0;
    let callsB = 0;
    let callsC = 0;

    const G = Smithers.workflow({ name: "pg-jump", input: inputSchema });
    const a = G.step("task:a", {
      output: outputSchema,
      run: () => {
        callsA += 1;
        return { value: callsA };
      },
    });
    const b = G.step("task:b", {
      output: outputSchema,
      run: () => {
        callsB += 1;
        return { value: callsB };
      },
    });
    const c = G.step("task:c", {
      output: outputSchema,
      run: () => {
        callsC += 1;
        return { value: callsC };
      },
    });
    const wf = G.from(G.sequence(a, b, c));
    const handles = I.collectHandles(wf.node);
    const { db, adapter, close } = await bootPg(handles);

    try {
      const runId = uniqueRunId("pg-jump");
      const firstRun = await Effect.runPromise(
        runWorkflow(makeWorkflow("pg-jump", wf.node, db, Context.empty(), { variant: "A" }), {
          input: { variant: "A" },
          runId,
        }),
      );
      expect(firstRun.status).toBe("finished");
      expect(callsA).toBe(1);
      expect(callsB).toBe(1);
      expect(callsC).toBe(1);

      // Drop jj pointers so the rewind exercises the DB/replay layer without a
      // real sandbox (VCS revert is covered by the unit tests).
      for (const attempt of await adapter.listAttemptsForRun(runId)) {
        await adapter.updateAttempt(runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
          jjPointer: null,
          jjCwd: null,
        });
      }

      const framesBefore = await adapter.listFrames(runId, 10_000);
      const earliestFrameNo = framesBefore.reduce(
        (min, frame) => Math.min(min, Number(frame.frameNo)),
        Number.POSITIVE_INFINITY,
      );
      const latestBefore = await adapter.getLastFrame(runId);
      expect(Number.isFinite(earliestFrameNo)).toBe(true);
      // A multi-step run must produce more than one frame, or the rewind would
      // short-circuit and never exercise the truncation transaction.
      expect(Number(latestBefore?.frameNo)).toBeGreaterThan(earliestFrameNo);

      // Before the fix this threw `TypeError: Could not resolve Bun SQLite
      // client from adapter.` on the Postgres adapter.
      const rewind = await jumpToFrame({
        adapter,
        runId,
        frameNo: earliestFrameNo,
        confirm: true,
        caller: "user:pg-integration",
      });

      expect(rewind.ok).toBe(true);
      expect(rewind.newFrameNo).toBe(earliestFrameNo);
      expect(rewind.deletedFrames).toBeGreaterThan(0);

      // Frames past the target were truncated, the run was flipped out of its
      // terminal status, and the TimeTravelJumped event was persisted through
      // the portable event-insert path.
      const latestAfter = await adapter.getLastFrame(runId);
      expect(Number(latestAfter?.frameNo)).toBe(earliestFrameNo);
      const runAfter = await adapter.getRun(runId);
      expect(runAfter?.status).toBe("running");
      const events = await adapter.internalStorage.queryAll(
        `SELECT type FROM _smithers_events WHERE run_id = ? AND type = 'TimeTravelJumped'`,
        [runId],
      );
      expect(events.length).toBeGreaterThan(0);

      // Resume from the rewound frame and re-drive the workflow to completion.
      const resumed = await Effect.runPromise(
        runWorkflow(makeWorkflow("pg-jump", wf.node, db, Context.empty(), { variant: "A" }), {
          input: { variant: "A" },
          runId,
          resume: true,
        }),
      );
      expect(resumed.status).toBe("finished");
      // Rewinding to the earliest frame re-executes every task at least once.
      expect(callsA).toBeGreaterThanOrEqual(2);
      expect(callsB).toBeGreaterThanOrEqual(2);
      expect(callsC).toBeGreaterThanOrEqual(2);
    } finally {
      await close();
    }
  });
});
