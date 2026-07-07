import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { writeRewindAuditRow } from "@smithers-orchestrator/time-travel/writeRewindAuditRow";
import { listRewindAuditRows } from "@smithers-orchestrator/time-travel/listRewindAuditRows";
import { createServeApp } from "../src/serve.js";

/**
 * createServeApp kicks off a best-effort, fire-and-forget startup recovery of
 * crash-interrupted rewinds (recoverRewindAuditsAtStartup). Its two callbacks —
 * onRecovered (a rewind was repaired) and onError (recovery itself failed) —
 * only fire on those real conditions, so they need their own setup. Both must
 * be swallowed: startup must never be blocked by recovery.
 */

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

/**
 * @param {() => Promise<boolean> | boolean} predicate
 */
async function waitUntil(predicate, { timeoutMs = 2000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

describe("createServeApp startup rewind recovery", () => {
  let sqlite;

  afterEach(() => {
    if (sqlite) {
      sqlite.close();
      sqlite = null;
    }
  });

  test("onRecovered: repairs a crash-interrupted rewind left in_progress", async () => {
    const t = createTestDb();
    sqlite = t.sqlite;
    const runId = "run-recover-serve";
    await t.adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: 1,
    });
    // A rewind that a prior process left mid-flight (never completed → crash).
    await writeRewindAuditRow(t.adapter, {
      runId,
      fromFrameNo: 5,
      toFrameNo: 2,
      caller: "user:test",
      timestampMs: 1_000,
      result: "in_progress",
      durationMs: null,
    });

    // Creating the app triggers the fire-and-forget recovery. onRecovered fires
    // once recoverInProgressRewindAudits reports recovered.length > 0, which
    // flips the stale audit row from in_progress to partial and flags the run.
    createServeApp({ adapter: t.adapter, runId, abort: new AbortController(), metrics: false });

    const repaired = await waitUntil(async () => {
      const audits = await listRewindAuditRows(t.adapter, { runId });
      return audits.some((a) => a.result === "partial");
    });
    expect(repaired).toBe(true);
    const audits = await listRewindAuditRows(t.adapter, { runId });
    expect(audits.map((a) => a.result)).toContain("partial");
    const run = await t.adapter.getRun(runId);
    // The run was flagged for attention (needs_attention, or failed via the
    // fallback path); either way its error payload records the interrupted rewind.
    expect(["needs_attention", "failed"]).toContain(run.status);
    expect(run.errorJson).toContain("needsAttention");
  });

  test("onError: swallows a recovery failure so startup is never blocked", async () => {
    // A storage layer whose audit query throws drives recoverInProgressRewindAudits
    // into its catch → onError. The server must still come up and serve /health.
    let queried = false;
    const throwingAdapter = {
      internalStorage: {
        execute: () => {},
        queryAll: async () => {
          queried = true;
          throw new Error("recovery query boom");
        },
      },
    };
    const app = createServeApp({
      adapter: throwingAdapter,
      runId: "run-recover-error",
      abort: new AbortController(),
      metrics: false,
    });

    // The recovery ran (and threw) but was swallowed by onError.
    const ran = await waitUntil(() => queried);
    expect(ran).toBe(true);

    // Health still works: the startup-recovery failure did not block the server.
    const res = await app.request("http://localhost/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
