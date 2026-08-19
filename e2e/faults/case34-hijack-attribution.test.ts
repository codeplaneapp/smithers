/**
 * Case 34 (flows migration, spec 1.4): a hijack is an attributed `RunControl`
 * verb. flows' gap analysis §4 lists hijack as missing and prescribes it as an
 * alternative `RunControl` implementation; the smithers evidence it asks for is
 * this case plus case 33.
 *
 * What is asserted: the hand-off request records who took the run and why,
 * alongside the target it hands to, and the durable hijack request the engine's
 * hijack watcher polls is written. The engine-side observation of that request
 * is exercised through the shipping run row, not a stand-in.
 *
 * REAL product path (no mocks): a real on-disk SQLite store through
 * `ensureSmithersTables` + `SmithersDb`, and the shipping `RunControl`.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createRunControl } from "@smthrs/engine/control/createRunControl";
import { readRunControlJournal } from "@smthrs/engine/control/readRunControlJournal";

const RUN_ID = "run-case34";

type Store = { sqlite: Database; adapter: SmithersDb; dir: string };

let store: Store;

function openStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "smithers-case34-"));
  const sqlite = new Database(join(dir, "smithers.db"));
  sqlite.exec("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db), dir };
}

async function seedLiveRun(adapter: SmithersDb): Promise<void> {
  const now = Date.now();
  await Effect.runPromise(
    adapter.insertRun({
      runId: RUN_ID,
      workflowName: "case34-workflow",
      status: "running",
      createdAtMs: now,
      startedAtMs: now,
      heartbeatAtMs: now,
      runtimeOwnerId: "pid:5150",
    }),
  );
}

beforeEach(() => {
  store = openStore();
});

afterEach(() => {
  try {
    store.sqlite.close();
  } catch {}
  rmSync(store.dir, { recursive: true, force: true });
});

describe("case34: hijack carries attribution", () => {
  test("the hijack verb journals who took the run, why, and what they took it to", async () => {
    await seedLiveRun(store.adapter);

    const outcome = await createRunControl({ adapter: store.adapter }).hijack(RUN_ID, {
      actor: "cli:will",
      reason: "agent stuck on the migration node",
      transport: "cli",
      target: "claude-code",
    });

    expect(outcome.accepted).toBe(true);

    // The durable half: the engine's hijack watcher polls these two columns.
    const run = await Effect.runPromise(store.adapter.getRun(RUN_ID));
    expect(run?.hijackRequestedAtMs).toBeGreaterThan(0);
    expect(run?.hijackTarget).toBe("claude-code");
    // A hijack does not cancel or pause the run; it hands its session over.
    expect(run?.cancelRequestedAtMs ?? null).toBeNull();
    expect(run?.status).toBe("running");

    const journal = await readRunControlJournal(store.adapter, RUN_ID, { verb: "hijack" });
    expect(journal.map((entry) => entry.phase)).toEqual(["requested", "applied"]);
    expect(journal[0]).toMatchObject({
      verb: "hijack",
      actor: "cli:will",
      reason: "agent stuck on the migration node",
      target: "claude-code",
    });
  });

  test("a targetless hijack is still attributed", async () => {
    await seedLiveRun(store.adapter);
    await createRunControl({ adapter: store.adapter }).hijack(RUN_ID, {
      actor: "rpc:gateway",
      reason: "operator takeover from the monitor",
      transport: "rpc",
    });

    const run = await Effect.runPromise(store.adapter.getRun(RUN_ID));
    expect(run?.hijackRequestedAtMs).toBeGreaterThan(0);
    expect(run?.hijackTarget ?? null).toBeNull();

    const journal = await readRunControlJournal(store.adapter, RUN_ID, { verb: "hijack" });
    expect(journal[0]).toMatchObject({ actor: "rpc:gateway", reason: "operator takeover from the monitor" });
    expect(journal[0].target ?? null).toBeNull();
  });

  test("two takeovers of the same run are both on the record, newest last", async () => {
    await seedLiveRun(store.adapter);
    const control = createRunControl({ adapter: store.adapter });
    await control.hijack(RUN_ID, { actor: "cli:first", reason: "first look", target: "codex" });
    await control.hijack(RUN_ID, { actor: "cli:second", reason: "second look", target: "claude-code" });

    const requested = (await readRunControlJournal(store.adapter, RUN_ID, { verb: "hijack" })).filter(
      (entry) => entry.phase === "requested",
    );
    expect(requested.map((entry) => entry.actor)).toEqual(["cli:first", "cli:second"]);
    // The run row keeps only the live request; the journal keeps the history.
    const run = await Effect.runPromise(store.adapter.getRun(RUN_ID));
    expect(run?.hijackTarget).toBe("claude-code");
  });

  test("hijacking a run that does not exist is refused, and the attempt is journaled", async () => {
    const outcome = await createRunControl({ adapter: store.adapter }).hijack("no-such-run", {
      actor: "cli:will",
      reason: "typo",
    });
    expect(outcome).toMatchObject({ accepted: false, refusedBecause: "run-not-found" });
    const journal = await readRunControlJournal(store.adapter, "no-such-run", { verb: "hijack" });
    expect(journal.at(-1)).toMatchObject({ accepted: false, actor: "cli:will" });
  });
});
