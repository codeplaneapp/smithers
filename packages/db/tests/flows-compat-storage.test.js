/**
 * The stage 1.1 flows storage path, exercised through `SmithersDb` against a real
 * on-disk SQLite workspace — the same file the flows `Journal`, `RunStore`, and
 * `AttemptStore` open their own connection to. Nothing here is mocked: every
 * assertion reads the durable rows back out.
 *
 * What is pinned:
 *
 * - sequences are allocated by the journal, inside the write transaction, and the
 *   legacy `_smithers_events` mirror carries the same sequence;
 * - a retried event write returns the sequence it returned the first time;
 * - rows the legacy path wrote are copied into the journal, keeping their
 *   sequence, before the next allocation;
 * - the attempt lifecycle is fenced on the run's owner, in both tables;
 * - `claimRunForResume` takes a dead or recycled-PID owner's run over, refuses a
 *   live one's, honours the `--steal-ownership` override, and reactivates a run
 *   that already reached a terminal status;
 * - the one-shot live-run migration is idempotent.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";
import { classifyRunDriverLiveness } from "../src/runDriverLiveness.js";
import { formatRuntimeOwnerId } from "../src/runtime-owner.js";
import { attemptStepKeyDigest, FLOWS_STORAGE_ENV_VAR, SMITHERS_ENGINE_ENV_VAR } from "../src/flows-compat/index.js";

const LOCAL_HOST = hostname().trim().replace(/\.+$/u, "").toLowerCase();

/** @type {Array<{ adapter: SmithersDb; close: () => void }>} */
let open = [];
/** @type {string | undefined} */
let previousFlag;
/**
 * The engine selector also requests flows storage, so an ambient
 * `SMITHERS_ENGINE=flows` — which the migration's own check runner exports —
 * would keep the gate on in the tests that assert the legacy path. Clear it for
 * the file and restore it afterwards so every case reads the flag it sets.
 *
 * @type {string | undefined}
 */
let previousEngine;

beforeEach(() => {
  previousFlag = process.env[FLOWS_STORAGE_ENV_VAR];
  previousEngine = process.env[SMITHERS_ENGINE_ENV_VAR];
  delete process.env[SMITHERS_ENGINE_ENV_VAR];
  process.env[FLOWS_STORAGE_ENV_VAR] = "1";
});

afterEach(async () => {
  for (const entry of open) {
    if (entry.adapter.flowsCompatPromise !== null) {
      await (await entry.adapter.flowsCompatPromise).close();
    }
    entry.close();
  }
  open = [];
  if (previousFlag === undefined) delete process.env[FLOWS_STORAGE_ENV_VAR];
  else process.env[FLOWS_STORAGE_ENV_VAR] = previousFlag;
  if (previousEngine === undefined) delete process.env[SMITHERS_ENGINE_ENV_VAR];
  else process.env[SMITHERS_ENGINE_ENV_VAR] = previousEngine;
});

/**
 * @param {string} [filename]
 * @returns {SmithersDb}
 */
function createAdapter(filename) {
  const path = filename ?? join(mkdtempSync(join(tmpdir(), "flows-compat-")), "smithers.db");
  const sqlite = new Database(path);
  sqlite.run("PRAGMA busy_timeout = 30000");
  sqlite.run("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  const adapter = new SmithersDb(db);
  open.push({ adapter, close: () => sqlite.close() });
  return adapter;
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{ status?: string; runtimeOwnerId?: string | null; heartbeatAtMs?: number | null }} [state]
 */
async function seedRun(adapter, runId, state = {}) {
  await adapter.insertRun({
    runId,
    workflowName: "wf",
    status: state.status ?? "running",
    createdAtMs: 1_000,
    startedAtMs: 1_000,
    runtimeOwnerId: state.runtimeOwnerId ?? null,
    heartbeatAtMs: state.heartbeatAtMs ?? null,
  });
}

/**
 * @param {SmithersDb} adapter
 * @param {string} query
 * @param {unknown[]} [params]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
function query(adapter, query_, params = []) {
  return /** @type {Promise<Array<Record<string, unknown>>>} */ (
    /** @type {any} */ (adapter.internalStorage).queryAllRaw(query_, params)
  );
}

describe("flows-backed event journal", () => {
  test("the journal allocates the sequence and the legacy mirror carries it", async () => {
    const adapter = createAdapter();
    expect(adapter.flowsStorage()).toEqual({ enabled: true, reason: "enabled" });
    await seedRun(adapter, "run-1");

    const seqs = [];
    for (let index = 0; index < 3; index += 1) {
      seqs.push(
        await adapter.insertEventWithNextSeq({
          runId: "run-1",
          timestampMs: 2_000 + index,
          type: "NodeStarted",
          payloadJson: JSON.stringify({ index }),
        }),
      );
    }
    expect(seqs).toEqual([0, 1, 2]);

    const journalRows = await query(
      adapter,
      "SELECT seq, event_type, source_id, payload_json, meta_json FROM flows_journal_events WHERE run_id = ? ORDER BY seq",
      ["run-1"],
    );
    expect(journalRows.map((row) => Number(row.seq))).toEqual([0, 1, 2]);
    expect(journalRows.every((row) => row.event_type === "NodeStarted")).toBe(true);
    expect(JSON.parse(String(journalRows[1].payload_json))).toEqual({ index: 1 });
    expect(JSON.parse(String(journalRows[1].meta_json))).toEqual({ smithers: { timestampMs: 2_001 } });

    const events = await adapter.listEvents("run-1", -1, 100);
    expect(events.map((row) => Number(row.seq))).toEqual([0, 1, 2]);
    expect(events.map((row) => Number(row.timestampMs))).toEqual([2_000, 2_001, 2_002]);
  });

  test("a retried identical write returns the original sequence", async () => {
    const adapter = createAdapter();
    await seedRun(adapter, "run-2");
    const row = { runId: "run-2", timestampMs: 5_000, type: "RunStatusChanged", payloadJson: '{"status":"running"}' };
    const first = await adapter.insertEventWithNextSeq(row);
    const second = await adapter.insertEventWithNextSeq(row);
    expect(second).toBe(first);
    const count = await query(adapter, "SELECT COUNT(*) AS c FROM flows_journal_events WHERE run_id = ?", ["run-2"]);
    expect(Number(count[0].c)).toBe(1);
  });

  test("concurrent writes get a gapless sequence, allocated inside the write transaction", async () => {
    const adapter = createAdapter();
    await seedRun(adapter, "run-concurrent");
    const total = 20;
    const seqs = await Promise.all(
      Array.from({ length: total }, (_, index) =>
        adapter.insertEventWithNextSeq({
          runId: "run-concurrent",
          timestampMs: 3_000 + index,
          type: "Concurrent",
          payloadJson: JSON.stringify({ index }),
        }),
      ),
    );
    expect([...seqs].sort((left, right) => left - right)).toEqual(Array.from({ length: total }, (_, i) => i));
    const journal = await query(
      adapter,
      "SELECT COUNT(*) AS c, COUNT(DISTINCT seq) AS distinct_seq FROM flows_journal_events WHERE run_id = ?",
      ["run-concurrent"],
    );
    expect(Number(journal[0].c)).toBe(total);
    expect(Number(journal[0].distinct_seq)).toBe(total);
    const mirrored = await query(adapter, "SELECT COUNT(*) AS c FROM _smithers_events WHERE run_id = ?", [
      "run-concurrent",
    ]);
    expect(Number(mirrored[0].c)).toBe(total);
  });

  test("a write inside an adapter transaction keeps the legacy path, and the next call catches the journal up", async () => {
    const adapter = createAdapter();
    await seedRun(adapter, "run-nested");
    // The documented boundary: this adapter holds the SQLite write lock for the
    // duration, so the flows connection must not be used inside it.
    const nestedSeq = await adapter.withTransaction(
      "nested event",
      Effect.gen(function* () {
        expect(adapter.flowsStorageDelegates()).toBe(false);
        return yield* adapter.insertEventWithNextSeq({
          runId: "run-nested",
          timestampMs: 10,
          type: "NestedWrite",
          payloadJson: "{}",
        });
      }),
    );
    expect(nestedSeq).toBe(0);
    // Nothing has delegated yet, so the flows stores were never even opened.
    const flowsTables = await query(adapter, "SELECT name FROM sqlite_master WHERE name = 'flows_journal_events'", []);
    expect(flowsTables).toHaveLength(0);

    expect(
      await adapter.insertEventWithNextSeq({
        runId: "run-nested",
        timestampMs: 20,
        type: "DelegatedWrite",
        payloadJson: "{}",
      }),
    ).toBe(1);
    const journal = await query(
      adapter,
      "SELECT seq, event_type FROM flows_journal_events WHERE run_id = ? ORDER BY seq",
      ["run-nested"],
    );
    expect(journal.map((row) => [Number(row.seq), row.event_type])).toEqual([
      [0, "NestedWrite"],
      [1, "DelegatedWrite"],
    ]);
  });

  test("rows the legacy path wrote are copied into the journal, keeping their sequence", async () => {
    const adapter = createAdapter();
    await seedRun(adapter, "run-3");
    // What a call at non-zero transaction depth leaves behind: a legacy row the
    // journal has never seen.
    await query(
      adapter,
      "INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json) VALUES (?, ?, ?, ?, ?)",
      ["run-3", 0, 100, "LegacyWrite", '{"legacy":true}'],
    );

    const seq = await adapter.insertEventWithNextSeq({
      runId: "run-3",
      timestampMs: 200,
      type: "FlowsWrite",
      payloadJson: "{}",
    });
    expect(seq).toBe(1);

    const journalRows = await query(
      adapter,
      "SELECT seq, event_type, source_id FROM flows_journal_events WHERE run_id = ? ORDER BY seq",
      ["run-3"],
    );
    expect(journalRows.map((row) => [Number(row.seq), row.event_type, row.source_id])).toEqual([
      [0, "LegacyWrite", "smithers-legacy"],
      [1, "FlowsWrite", "smithers-adapter"],
    ]);
  });
});

describe("flows-backed attempt lifecycle", () => {
  const owner = formatRuntimeOwnerId(process.pid, LOCAL_HOST, "session-live");

  /**
   * @param {SmithersDb} adapter
   * @param {string} runId
   */
  async function seedAttempt(adapter, runId) {
    await seedRun(adapter, runId, { runtimeOwnerId: owner, heartbeatAtMs: 10_000 });
    await adapter.insertAttempt({
      runId,
      nodeId: "node-a",
      iteration: 0,
      attempt: 1,
      state: "in-progress",
      startedAtMs: 10_000,
    });
  }

  test("insertAttempt writes both the flows attempt and the legacy row", async () => {
    const adapter = createAdapter();
    await seedAttempt(adapter, "run-4");
    const flowsRows = await query(
      adapter,
      "SELECT step_key_digest, state, meta_json FROM flows_attempts WHERE run_id = ?",
      ["run-4"],
    );
    expect(flowsRows).toHaveLength(1);
    expect(flowsRows[0].step_key_digest).toBe(attemptStepKeyDigest("node-a", 0));
    expect(flowsRows[0].state).toBe("in-progress");
    expect(JSON.parse(String(flowsRows[0].meta_json)).nodeId).toBe("node-a");
    const legacy = await adapter.listAttempts("run-4", "node-a", 0);
    expect(legacy).toHaveLength(1);
    expect(legacy[0].state).toBe("in-progress");
  });

  test("the heartbeat is fenced on the run owner in both stores", async () => {
    const adapter = createAdapter();
    await seedAttempt(adapter, "run-5");
    expect(await adapter.heartbeatAttempt("run-5", "node-a", 0, 1, 11_000, null, owner)).toBe(true);
    const beat = await query(
      adapter,
      "SELECT heartbeat_at_ms FROM flows_attempts WHERE run_id = ? AND step_key_digest = ?",
      ["run-5", attemptStepKeyDigest("node-a", 0)],
    );
    expect(Number(beat[0].heartbeat_at_ms)).toBe(11_000);
    const run = await query(adapter, "SELECT heartbeat_at_ms FROM flows_runs WHERE run_id = ?", ["run-5"]);
    expect(Number(run[0].heartbeat_at_ms)).toBe(11_000);

    const stranger = formatRuntimeOwnerId(process.pid, LOCAL_HOST, "session-stranger");
    expect(await adapter.heartbeatAttempt("run-5", "node-a", 0, 1, 12_000, null, stranger)).toBe(false);
    const unchanged = await query(adapter, "SELECT heartbeat_at_ms FROM _smithers_runs WHERE run_id = ?", ["run-5"]);
    expect(Number(unchanged[0].heartbeat_at_ms)).toBe(11_000);
  });

  test("the terminal transition is a compare-and-set, and the loser sees false", async () => {
    const adapter = createAdapter();
    await seedAttempt(adapter, "run-6");
    expect(await adapter.claimAttemptCompletion("run-6", "node-a", 0, 1, owner, 13_000)).toBe(true);
    expect(await adapter.claimAttemptCompletion("run-6", "node-a", 0, 1, owner, 13_500)).toBe(false);
    const flowsRows = await query(
      adapter,
      "SELECT state, finished_at_ms FROM flows_attempts WHERE run_id = ? AND step_key_digest = ?",
      ["run-6", attemptStepKeyDigest("node-a", 0)],
    );
    expect(flowsRows[0].state).toBe("finished");
    expect(Number(flowsRows[0].finished_at_ms)).toBe(13_000);
    const legacy = await adapter.listAttempts("run-6", "node-a", 0);
    expect(legacy[0].state).toBe("finished");
    expect(Number(legacy[0].finishedAtMs)).toBe(13_000);
  });

  test("a failed terminal transition records the error and clears the resume pointers", async () => {
    const adapter = createAdapter();
    await seedRun(adapter, "run-7", { runtimeOwnerId: owner, heartbeatAtMs: 10_000 });
    await adapter.insertAttempt({
      runId: "run-7",
      nodeId: "node-b",
      iteration: 0,
      attempt: 1,
      state: "in-progress",
      startedAtMs: 10_000,
      metaJson: JSON.stringify({ agentResume: "sess-1", other: "kept" }),
    });
    expect(
      await adapter.claimAttemptTerminal("run-7", "node-b", 0, 1, owner, "failed", 14_000, '{"code":"BOOM"}'),
    ).toBe(true);
    const legacy = await adapter.listAttempts("run-7", "node-b", 0);
    expect(legacy[0].state).toBe("failed");
    expect(JSON.parse(String(legacy[0].metaJson)).other).toBe("kept");
    expect(JSON.parse(String(legacy[0].metaJson)).agentResume).toBeUndefined();
    const flowsRows = await query(adapter, "SELECT state, error_json FROM flows_attempts WHERE run_id = ?", ["run-7"]);
    expect(flowsRows[0].state).toBe("failed");
    expect(JSON.parse(String(flowsRows[0].error_json))).toEqual({ code: "BOOM" });
  });
});

describe("flows-backed run claim", () => {
  test("takes over a run whose owner process is gone", async () => {
    const adapter = createAdapter();
    const dead = Bun.spawnSync({ cmd: ["true"] });
    const deadOwner = formatRuntimeOwnerId(dead.pid, LOCAL_HOST, "session-dead");
    await seedRun(adapter, "run-8", { runtimeOwnerId: deadOwner, heartbeatAtMs: 1_000 });
    const nowMs = 1_000 + 120_000;
    const claimOwnerId = formatRuntimeOwnerId(process.pid, LOCAL_HOST, "session-claimant");

    expect(
      await adapter.claimRunForResume({
        runId: "run-8",
        expectedRuntimeOwnerId: deadOwner,
        expectedHeartbeatAtMs: 1_000,
        staleBeforeMs: nowMs - 30_000,
        claimOwnerId,
        claimHeartbeatAtMs: nowMs,
      }),
    ).toBe(true);

    const smithersRun = await query(
      adapter,
      "SELECT runtime_owner_id, heartbeat_at_ms FROM _smithers_runs WHERE run_id = ?",
      ["run-8"],
    );
    expect(smithersRun[0].runtime_owner_id).toBe(claimOwnerId);
    const flowsRun = await query(
      adapter,
      "SELECT status, owner_pid, owner_nonce, heartbeat_at_ms FROM flows_runs WHERE run_id = ?",
      ["run-8"],
    );
    expect(flowsRun[0].status).toBe("running");
    expect(Number(flowsRun[0].owner_pid)).toBe(process.pid);
    expect(flowsRun[0].owner_nonce).toBe("session-claimant");
    expect(Number(flowsRun[0].heartbeat_at_ms)).toBe(nowMs);
  });

  test("takes over a run whose owner PID was recycled by an unrelated process", async () => {
    // This process is alive under the recorded PID, but it started long after
    // the heartbeat that PID supposedly wrote, so it cannot be the driver.
    // `classifyRunDriverLiveness` calls that dead, and ordinary crash recovery
    // depends on it: otherwise a crashed run whose PID the OS handed to
    // something else could never be resumed.
    const adapter = createAdapter();
    const recycledOwner = formatRuntimeOwnerId(process.pid, LOCAL_HOST, "session-recycled");
    await seedRun(adapter, "run-9a", { runtimeOwnerId: recycledOwner, heartbeatAtMs: 1_000 });
    expect(
      classifyRunDriverLiveness({ status: "running", runtimeOwnerId: recycledOwner, heartbeatAtMs: 1_000 }),
    ).toMatchObject({
      live: false,
      evidence: "owner-pid-recycled",
    });
    const nowMs = 1_000 + 120_000;
    const claimOwnerId = formatRuntimeOwnerId(process.pid, LOCAL_HOST, "session-claimant");

    expect(
      await adapter.claimRunForResume({
        runId: "run-9a",
        expectedRuntimeOwnerId: recycledOwner,
        expectedHeartbeatAtMs: 1_000,
        staleBeforeMs: nowMs - 30_000,
        claimOwnerId,
        claimHeartbeatAtMs: nowMs,
      }),
    ).toBe(true);
    const run = await query(adapter, "SELECT runtime_owner_id FROM _smithers_runs WHERE run_id = ?", ["run-9a"]);
    expect(run[0].runtime_owner_id).toBe(claimOwnerId);
    const flowsRun = await query(adapter, "SELECT owner_nonce, heartbeat_at_ms FROM flows_runs WHERE run_id = ?", [
      "run-9a",
    ]);
    expect(flowsRun[0].owner_nonce).toBe("session-claimant");
    expect(Number(flowsRun[0].heartbeat_at_ms)).toBe(nowMs);
  });

  test("refuses a run whose recorded owner is still alive on this host", async () => {
    const adapter = createAdapter();
    const liveOwner = formatRuntimeOwnerId(process.pid, LOCAL_HOST, "session-live");
    // A heartbeat written after this process started, so the PID is genuinely
    // this process rather than a recycled number.
    const liveHeartbeatAtMs = Date.now();
    await seedRun(adapter, "run-9", { runtimeOwnerId: liveOwner, heartbeatAtMs: liveHeartbeatAtMs });
    expect(
      classifyRunDriverLiveness({ status: "running", runtimeOwnerId: liveOwner, heartbeatAtMs: liveHeartbeatAtMs }),
    ).toMatchObject({ live: true, evidence: "owner-pid-alive" });
    expect(
      await adapter.claimRunForResume({
        runId: "run-9",
        expectedRuntimeOwnerId: liveOwner,
        expectedHeartbeatAtMs: liveHeartbeatAtMs,
        // Loose enough that the legacy staleness predicate alone would admit the
        // claim: what refuses it is the missing liveness evidence.
        staleBeforeMs: liveHeartbeatAtMs + 1,
        claimOwnerId: formatRuntimeOwnerId(process.pid, LOCAL_HOST, "session-claimant"),
        claimHeartbeatAtMs: liveHeartbeatAtMs + 60_000,
      }),
    ).toBe(false);
    const run = await query(adapter, "SELECT runtime_owner_id FROM _smithers_runs WHERE run_id = ?", ["run-9"]);
    expect(run[0].runtime_owner_id).toBe(liveOwner);
  });

  test("requireStale=false steals a live owner's run, as --steal-ownership asks", async () => {
    // `activateRunForResume` passes `requireStale: false` for `--force` and
    // `--steal-ownership`, which exist precisely to displace an owner the
    // liveness guard would otherwise protect. flows has no lease path for that,
    // so the legacy compare-and-set arbitrates and `flows_runs` is republished
    // from the row it wrote.
    const adapter = createAdapter();
    const liveOwner = formatRuntimeOwnerId(process.pid, LOCAL_HOST, "session-live-steal");
    const liveHeartbeatAtMs = Date.now();
    await seedRun(adapter, "run-9b", { runtimeOwnerId: liveOwner, heartbeatAtMs: liveHeartbeatAtMs });
    const claimOwnerId = formatRuntimeOwnerId(process.pid, LOCAL_HOST, "session-thief");
    const nowMs = liveHeartbeatAtMs + 5_000;

    expect(
      await adapter.claimRunForResume({
        runId: "run-9b",
        expectedRuntimeOwnerId: liveOwner,
        expectedHeartbeatAtMs: liveHeartbeatAtMs,
        // The heartbeat is fresh, so every staleness test — legacy and flows —
        // would refuse. `requireStale: false` is what carries the takeover.
        staleBeforeMs: nowMs - 30_000,
        claimOwnerId,
        claimHeartbeatAtMs: nowMs,
        requireStale: false,
      }),
    ).toBe(true);
    const run = await query(adapter, "SELECT runtime_owner_id, heartbeat_at_ms FROM _smithers_runs WHERE run_id = ?", [
      "run-9b",
    ]);
    expect(run[0].runtime_owner_id).toBe(claimOwnerId);
    expect(Number(run[0].heartbeat_at_ms)).toBe(nowMs);
    const flowsRun = await query(
      adapter,
      "SELECT status, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms FROM flows_runs WHERE run_id = ?",
      ["run-9b"],
    );
    expect(flowsRun[0].status).toBe("running");
    expect(flowsRun[0].owner_host_id).toBe(LOCAL_HOST);
    expect(Number(flowsRun[0].owner_pid)).toBe(process.pid);
    expect(flowsRun[0].owner_nonce).toBe("session-thief");
    expect(Number(flowsRun[0].heartbeat_at_ms)).toBe(nowMs);
  });

  test("requireStale=false still honours the expected snapshot", async () => {
    const adapter = createAdapter();
    const liveOwner = formatRuntimeOwnerId(process.pid, LOCAL_HOST, "session-live-guarded");
    const liveHeartbeatAtMs = Date.now();
    await seedRun(adapter, "run-9c", { runtimeOwnerId: liveOwner, heartbeatAtMs: liveHeartbeatAtMs });
    expect(
      await adapter.claimRunForResume({
        runId: "run-9c",
        expectedRuntimeOwnerId: liveOwner,
        expectedHeartbeatAtMs: liveHeartbeatAtMs - 1,
        staleBeforeMs: liveHeartbeatAtMs,
        claimOwnerId: formatRuntimeOwnerId(process.pid, LOCAL_HOST, "session-thief"),
        claimHeartbeatAtMs: liveHeartbeatAtMs + 5_000,
        requireStale: false,
      }),
    ).toBe(false);
    const run = await query(adapter, "SELECT runtime_owner_id FROM _smithers_runs WHERE run_id = ?", ["run-9c"]);
    expect(run[0].runtime_owner_id).toBe(liveOwner);
  });

  test("a claim whose expected snapshot is wrong changes nothing", async () => {
    const adapter = createAdapter();
    await seedRun(adapter, "run-10", { runtimeOwnerId: null, heartbeatAtMs: null });
    expect(
      await adapter.claimRunForResume({
        runId: "run-10",
        expectedRuntimeOwnerId: "pid:1@other-host:sess",
        expectedHeartbeatAtMs: 5,
        staleBeforeMs: 100_000,
        claimOwnerId: formatRuntimeOwnerId(process.pid, LOCAL_HOST, "session-claimant"),
        claimHeartbeatAtMs: 150_000,
      }),
    ).toBe(false);
    const run = await query(adapter, "SELECT runtime_owner_id FROM _smithers_runs WHERE run_id = ?", ["run-10"]);
    expect(run[0].runtime_owner_id).toBeNull();
    // The refused claim rolled its whole transaction back, migration included, so
    // the flows row is not there yet either. The next delegated call re-syncs it.
    const flowsRun = await query(adapter, "SELECT status FROM flows_runs WHERE run_id = ?", ["run-10"]);
    expect(flowsRun).toHaveLength(0);
  });

  test("claims an unowned run without needing liveness evidence", async () => {
    const adapter = createAdapter();
    await seedRun(adapter, "run-11", { runtimeOwnerId: null, heartbeatAtMs: null });
    const claimOwnerId = formatRuntimeOwnerId(process.pid, LOCAL_HOST, "session-claimant");
    expect(
      await adapter.claimRunForResume({
        runId: "run-11",
        expectedRuntimeOwnerId: null,
        expectedHeartbeatAtMs: null,
        staleBeforeMs: 100_000,
        claimOwnerId,
        claimHeartbeatAtMs: 150_000,
      }),
    ).toBe(true);
    const flowsRun = await query(adapter, "SELECT status, owner_nonce FROM flows_runs WHERE run_id = ?", ["run-11"]);
    expect(flowsRun[0].status).toBe("running");
    expect(flowsRun[0].owner_nonce).toBe("session-claimant");
  });

  // Replay, fork, and `retry-task` all resume a run that already reached an end
  // state. Those map onto the flows terminal statuses, which `claimAndOwn` does
  // not admit, so the legacy compare-and-set decides them and the flows row is
  // republished from what it wrote.
  for (const status of ["cancelled", "failed", "finished"]) {
    test(`reactivates a ${status} run through the legacy predicate`, async () => {
      const adapter = createAdapter();
      const runId = `terminal-${status}`;
      await seedRun(adapter, runId, { status, runtimeOwnerId: null, heartbeatAtMs: null });
      const claimOwnerId = formatRuntimeOwnerId(process.pid, LOCAL_HOST, `${status}-claimant`);
      expect(
        await adapter.claimRunForResume({
          runId,
          expectedStatus: status,
          expectedRuntimeOwnerId: null,
          expectedHeartbeatAtMs: null,
          staleBeforeMs: 100_000,
          claimOwnerId,
          claimHeartbeatAtMs: 150_000,
          requireStale: false,
        }),
      ).toBe(true);
      const legacy = await query(
        adapter,
        "SELECT runtime_owner_id, heartbeat_at_ms FROM _smithers_runs WHERE run_id = ?",
        [runId],
      );
      expect(legacy[0].runtime_owner_id).toBe(claimOwnerId);
      expect(Number(legacy[0].heartbeat_at_ms)).toBe(150_000);
      // The Smithers status has not moved yet — `updateClaimedRun` is what turns
      // the run back to `running` — so the flows row still carries a status with
      // no owner on it.
      const flowsRun = await query(adapter, "SELECT status, owner_nonce FROM flows_runs WHERE run_id = ?", [runId]);
      expect(flowsRun[0].owner_nonce).toBeNull();
    });
  }

  test("an owner id flows cannot fence still claims through the legacy predicate", async () => {
    const adapter = createAdapter();
    await seedRun(adapter, "supervised-run", { runtimeOwnerId: null, heartbeatAtMs: null });
    // What `smithers supervise` writes: an owner id that names no pid, so it has
    // no flows fencing token.
    const claimOwnerId = "supervisor:sweep-test";
    expect(
      await adapter.claimRunForResume({
        runId: "supervised-run",
        expectedRuntimeOwnerId: null,
        expectedHeartbeatAtMs: null,
        staleBeforeMs: 100_000,
        claimOwnerId,
        claimHeartbeatAtMs: 150_000,
      }),
    ).toBe(true);
    const legacy = await query(adapter, "SELECT runtime_owner_id FROM _smithers_runs WHERE run_id = ?", [
      "supervised-run",
    ]);
    expect(legacy[0].runtime_owner_id).toBe(claimOwnerId);
    // flows cannot name that owner, so its row stays owner-less rather than
    // claiming a fence it does not hold.
    const flowsRun = await query(adapter, "SELECT status, owner_nonce FROM flows_runs WHERE run_id = ?", [
      "supervised-run",
    ]);
    expect(flowsRun[0].status).toBe("suspended");
    expect(flowsRun[0].owner_nonce).toBeNull();
  });

  test("a terminal run whose expected snapshot is wrong is still refused", async () => {
    const adapter = createAdapter();
    await seedRun(adapter, "terminal-guarded", { status: "cancelled", runtimeOwnerId: null, heartbeatAtMs: null });
    expect(
      await adapter.claimRunForResume({
        runId: "terminal-guarded",
        expectedStatus: "cancelled",
        expectedRuntimeOwnerId: formatRuntimeOwnerId(process.pid, LOCAL_HOST, "someone-else"),
        expectedHeartbeatAtMs: null,
        staleBeforeMs: 100_000,
        claimOwnerId: formatRuntimeOwnerId(process.pid, LOCAL_HOST, "claimant"),
        claimHeartbeatAtMs: 150_000,
        requireStale: false,
      }),
    ).toBe(false);
    const legacy = await query(adapter, "SELECT runtime_owner_id FROM _smithers_runs WHERE run_id = ?", [
      "terminal-guarded",
    ]);
    expect(legacy[0].runtime_owner_id).toBeNull();
  });
});

describe("one-shot migration for live runs", () => {
  test("copies live runs, their events, and their attempts, and is idempotent", async () => {
    const adapter = createAdapter();
    await seedRun(adapter, "live-run", { runtimeOwnerId: null, heartbeatAtMs: null });
    await seedRun(adapter, "done-run", { status: "finished" });
    for (const seq of [0, 1, 2]) {
      await query(
        adapter,
        "INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json) VALUES (?, ?, ?, ?, ?)",
        ["live-run", seq, 100 + seq, "LegacyEvent", JSON.stringify({ seq })],
      );
    }
    await query(
      adapter,
      "INSERT INTO _smithers_attempts (run_id, node_id, iteration, attempt, state, started_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      ["live-run", "node-x", 0, 1, "in-progress", 100],
    );

    const first = await adapter.migrateLiveRunsIntoFlows();
    expect(first).toEqual({ runs: 1, events: 3, attempts: 1 });

    const journalRows = await query(
      adapter,
      "SELECT seq, event_type, source_seq FROM flows_journal_events WHERE run_id = ? ORDER BY seq",
      ["live-run"],
    );
    expect(journalRows.map((row) => Number(row.seq))).toEqual([0, 1, 2]);
    expect(journalRows.map((row) => Number(row.source_seq))).toEqual([0, 1, 2]);
    const migratedRuns = await query(adapter, "SELECT run_id FROM flows_runs ORDER BY run_id", []);
    expect(migratedRuns.map((row) => row.run_id)).toEqual(["live-run"]);

    const second = await adapter.migrateLiveRunsIntoFlows();
    expect(second).toEqual({ runs: 1, events: 0, attempts: 1 });

    // The next allocation continues above the migrated history rather than
    // colliding with it.
    expect(
      await adapter.insertEventWithNextSeq({
        runId: "live-run",
        timestampMs: 500,
        type: "AfterMigration",
        payloadJson: "{}",
      }),
    ).toBe(3);
  });
});

describe("run rows flows models more strictly than Smithers", () => {
  test("an owned run with no heartbeat still migrates, standing its start time in", async () => {
    const adapter = createAdapter();
    const owner = formatRuntimeOwnerId(process.pid, LOCAL_HOST, "session-no-beat");
    await seedRun(adapter, "run-no-heartbeat", { runtimeOwnerId: owner, heartbeatAtMs: null });
    expect(
      await adapter.insertEventWithNextSeq({
        runId: "run-no-heartbeat",
        timestampMs: 1,
        type: "Started",
        payloadJson: "{}",
      }),
    ).toBe(0);
    const flowsRun = await query(
      adapter,
      "SELECT status, owner_nonce, heartbeat_at_ms FROM flows_runs WHERE run_id = ?",
      ["run-no-heartbeat"],
    );
    expect(flowsRun[0].status).toBe("running");
    expect(flowsRun[0].owner_nonce).toBe("session-no-beat");
    expect(Number(flowsRun[0].heartbeat_at_ms)).toBe(1_000);
  });
});

describe("one flows context per database file", () => {
  test("two adapters over one file share the stores, and the last close releases them", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "flows-compat-shared-")), "smithers.db");
    const first = createAdapter(path);
    const second = createAdapter(path);
    await seedRun(first, "shared-run");
    expect(
      await first.insertEventWithNextSeq({ runId: "shared-run", timestampMs: 1, type: "A", payloadJson: "{}" }),
    ).toBe(0);
    expect(
      await second.insertEventWithNextSeq({ runId: "shared-run", timestampMs: 2, type: "B", payloadJson: "{}" }),
    ).toBe(1);
    const compatFirst = await first.flowsCompat();
    const compatSecond = await second.flowsCompat();
    expect(compatFirst.stores.filename).toBe(compatSecond.stores.filename);

    // Releasing one handle leaves the other usable: the context is reference
    // counted, not owned by whichever adapter opened it.
    await compatFirst.close();
    expect(
      await second.insertEventWithNextSeq({ runId: "shared-run", timestampMs: 3, type: "C", payloadJson: "{}" }),
    ).toBe(2);
  });
});

describe("workspaces that keep the legacy path", () => {
  test("an in-memory database never loads the flows stores", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    open.push({ adapter, close: () => sqlite.close() });
    expect(adapter.flowsStorage()).toEqual({ enabled: false, reason: "in-memory-database" });
    await seedRun(adapter, "memory-run");
    expect(
      await adapter.insertEventWithNextSeq({
        runId: "memory-run",
        timestampMs: 1,
        type: "LegacyOnly",
        payloadJson: "{}",
      }),
    ).toBe(0);
    expect(adapter.flowsCompatPromise).toBeNull();
  });

  test("the flag off keeps the legacy path on a file-backed workspace", async () => {
    delete process.env[FLOWS_STORAGE_ENV_VAR];
    const adapter = createAdapter();
    expect(adapter.flowsStorage()).toEqual({ enabled: false, reason: "not-requested" });
    await seedRun(adapter, "legacy-run");
    expect(
      await adapter.insertEventWithNextSeq({
        runId: "legacy-run",
        timestampMs: 1,
        type: "LegacyOnly",
        payloadJson: "{}",
      }),
    ).toBe(0);
    const tables = await query(adapter, "SELECT name FROM sqlite_master WHERE name LIKE 'flows_%'", []);
    expect(tables).toHaveLength(0);
  });
});
