/**
 * Case 33 (flows migration, spec 1.4): `smithers pause` is a thin call onto
 * `RunControl`, and the pause it performs is attributed — the journal records
 * who asked and why, not just that a pause happened.
 *
 * This is the smithers-side evidence flows' gap analysis §4 asks for: "pause is
 * effectively available as park(reason) over the waiting taxonomy, but there is
 * no user-facing pause verb and, critically, no attribution".
 *
 * REAL product path (no mocks): a real on-disk SQLite store built with
 * `ensureSmithersTables`, driven through the shipping `@smthrs/db/adapter`
 * `SmithersDb`, and the shipping `RunControl` from `@smthrs/engine`. The
 * journal is read back with `listEventsByType` through
 * `readRunControlJournal`, so what is asserted is what survived to storage.
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

const RUN_ID = "run-case33";

type Store = { sqlite: Database; adapter: SmithersDb; dir: string };

let store: Store;

function openStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "smithers-case33-"));
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
      workflowName: "case33-workflow",
      status: "running",
      createdAtMs: now,
      startedAtMs: now,
      heartbeatAtMs: now,
      runtimeOwnerId: "pid:4242",
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

describe("case33: pause carries attribution", () => {
  test("the pause verb journals the actor and reason, then flips durable state", async () => {
    await seedLiveRun(store.adapter);

    const outcome = await createRunControl({ adapter: store.adapter }).pause(RUN_ID, {
      actor: "cli:will",
      reason: "draining the host before a deploy",
      transport: "cli",
      clientPid: 4243,
    });

    expect(outcome.accepted).toBe(true);
    expect(outcome.status).toBe("pause-requested");

    // The durable half: the engine's pause watcher polls this column.
    const run = await Effect.runPromise(store.adapter.getRun(RUN_ID));
    expect(run?.pauseRequestedAtMs).toBeGreaterThan(0);
    // A pause is not a cancel: the cancel request must stay clear.
    expect(run?.cancelRequestedAtMs ?? null).toBeNull();

    // The attributed half.
    const journal = await readRunControlJournal(store.adapter, RUN_ID, { verb: "pause" });
    expect(journal.map((entry) => entry.phase)).toEqual(["requested", "applied"]);
    expect(journal[0]).toMatchObject({
      verb: "pause",
      actor: "cli:will",
      reason: "draining the host before a deploy",
    });
    expect(journal[1]).toMatchObject({ accepted: true, status: "pause-requested" });
  });

  test("the request is journaled before the flip, so a crash between them keeps the attribution", async () => {
    await seedLiveRun(store.adapter);
    const control = createRunControl({ adapter: store.adapter });
    await control.pause(RUN_ID, { actor: "cli:will", reason: "first" });

    const journal = await readRunControlJournal(store.adapter, RUN_ID, { verb: "pause" });
    const requested = journal.find((entry) => entry.phase === "requested");
    const applied = journal.find((entry) => entry.phase === "applied");
    expect(requested!.seq).toBeLessThan(applied!.seq);
  });

  test("a refused pause is journaled too: who tried is on the record", async () => {
    const now = Date.now();
    await Effect.runPromise(
      store.adapter.insertRun({
        runId: RUN_ID,
        workflowName: "case33-workflow",
        status: "waiting-approval",
        createdAtMs: now,
        startedAtMs: now,
      }),
    );

    const outcome = await createRunControl({ adapter: store.adapter }).pause(RUN_ID, {
      actor: "cli:someone-else",
      reason: "tried to pause a parked run",
    });

    expect(outcome.accepted).toBe(false);
    expect(outcome.refusedBecause).toBe("run-not-active");
    const run = await Effect.runPromise(store.adapter.getRun(RUN_ID));
    expect(run?.pauseRequestedAtMs ?? null).toBeNull();

    const journal = await readRunControlJournal(store.adapter, RUN_ID, { verb: "pause" });
    expect(journal.at(-1)).toMatchObject({
      phase: "applied",
      accepted: false,
      actor: "cli:someone-else",
      reason: "tried to pause a parked run",
    });
  });

  test("an unattributed caller is recorded as unattributed rather than as nothing", async () => {
    await seedLiveRun(store.adapter);
    await createRunControl({ adapter: store.adapter }).pause(RUN_ID, {});
    const journal = await readRunControlJournal(store.adapter, RUN_ID, { verb: "pause" });
    expect(journal[0]).toMatchObject({ actor: "unattributed", reason: "unattributed" });
  });
});
