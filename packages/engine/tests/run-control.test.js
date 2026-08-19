/**
 * RunControl over a real on-disk SQLite store.
 *
 * Spec 1.4 and flows' §4: a control verb has to journal an attributed event —
 * actor and reason — and then flip durable state. These assertions read the
 * journal back out of `_smithers_events` through the ordinary adapter, so what
 * is proven is what survived to storage.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { SmithersDb } from "@smthrs/db/adapter";
import { createRunControl } from "@smthrs/engine/control/createRunControl";
import { readRunControlJournal } from "@smthrs/engine/control/readRunControlJournal";
import { normalizeRunControlAttribution } from "@smthrs/engine/control/runControlAttribution";

const RUN_ID = "run-control-1";

let store;

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-run-control-"));
  const sqlite = new Database(join(dir, "store.sqlite"));
  sqlite.exec("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return {
    dir,
    sqlite,
    adapter: new SmithersDb(db),
    cleanup() {
      try {
        sqlite.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seedRun(adapter, patch = {}) {
  await Effect.runPromise(
    adapter.insertRun({
      runId: RUN_ID,
      workflowName: "control-workflow",
      status: "running",
      createdAtMs: Date.now(),
      startedAtMs: Date.now(),
      heartbeatAtMs: Date.now(),
      runtimeOwnerId: "pid:1234",
      ...patch,
    }),
  );
}

beforeEach(() => {
  store = openStore();
});

afterEach(() => {
  store.cleanup();
});

describe("attribution normalization", () => {
  test("actor and reason are always present, and always bounded", () => {
    expect(normalizeRunControlAttribution(undefined)).toEqual({
      actor: "unattributed",
      reason: "unattributed",
    });
    const long = normalizeRunControlAttribution({ actor: "a".repeat(5_000), reason: "b".repeat(5_000) });
    expect(long.actor.length).toBe(1024);
    expect(long.reason.length).toBe(1024);
  });

  test("an unknown transport is dropped rather than journaled", () => {
    expect(normalizeRunControlAttribution({ actor: "x", reason: "y", transport: "carrier-pigeon" }).transport).toBe(
      undefined,
    );
    expect(normalizeRunControlAttribution({ actor: "x", reason: "y", transport: "rpc" }).transport).toBe("rpc");
  });
});

describe("pause", () => {
  test("journals who paused and why, then requests the durable pause", async () => {
    await seedRun(store.adapter);
    const control = createRunControl({ adapter: store.adapter });
    const outcome = await control.pause(RUN_ID, {
      actor: "cli:will",
      reason: "smithers pause run-control-1",
      transport: "cli",
    });

    expect(outcome.accepted).toBe(true);
    expect(outcome.status).toBe("pause-requested");

    const run = await Effect.runPromise(store.adapter.getRun(RUN_ID));
    expect(run.pauseRequestedAtMs).toBeGreaterThan(0);

    const journal = await readRunControlJournal(store.adapter, RUN_ID, { verb: "pause" });
    expect(journal.map((entry) => entry.phase)).toEqual(["requested", "applied"]);
    for (const entry of journal) {
      expect(entry.actor).toBe("cli:will");
      expect(entry.reason).toBe("smithers pause run-control-1");
      expect(entry.verb).toBe("pause");
    }
    expect(journal[1].accepted).toBe(true);
    // The request is journaled before the flip, so the attribution survives a
    // crash between the two.
    expect(journal[0].seq).toBeLessThan(journal[1].seq);
  });

  test("an already-paused run is accepted idempotently", async () => {
    await seedRun(store.adapter, { status: "paused", heartbeatAtMs: null, runtimeOwnerId: null });
    const outcome = await createRunControl({ adapter: store.adapter }).pause(RUN_ID, {
      actor: "cli:will",
      reason: "again",
    });
    expect(outcome).toMatchObject({ accepted: true, status: "paused" });
  });

  test("a run that is not running is refused, and the refusal is journaled", async () => {
    await seedRun(store.adapter, { status: "waiting-timer", heartbeatAtMs: null, runtimeOwnerId: null });
    const outcome = await createRunControl({ adapter: store.adapter }).pause(RUN_ID, {
      actor: "cli:will",
      reason: "park it harder",
    });
    expect(outcome).toMatchObject({ accepted: false, refusedBecause: "run-not-active", status: "waiting-timer" });
    const journal = await readRunControlJournal(store.adapter, RUN_ID, { verb: "pause" });
    expect(journal.at(-1)).toMatchObject({ phase: "applied", accepted: false, actor: "cli:will" });
  });

  test("a missing run is refused rather than silently accepted", async () => {
    const outcome = await createRunControl({ adapter: store.adapter }).pause("no-such-run", {
      actor: "cli:will",
      reason: "typo",
    });
    expect(outcome).toMatchObject({ accepted: false, refusedBecause: "run-not-found" });
  });
});

describe("cancel", () => {
  test("journals attribution and writes the durable cancel request", async () => {
    await seedRun(store.adapter);
    const outcome = await createRunControl({ adapter: store.adapter }).cancel(RUN_ID, {
      actor: "rpc:gateway",
      reason: "operator stopped the deploy",
      transport: "rpc",
      requestId: "req-9",
    });
    expect(outcome.accepted).toBe(true);

    const run = await Effect.runPromise(store.adapter.getRun(RUN_ID));
    expect(run.cancelRequestedAtMs).toBeGreaterThan(0);

    const journal = await readRunControlJournal(store.adapter, RUN_ID, { verb: "cancel" });
    expect(journal[0]).toMatchObject({
      phase: "requested",
      verb: "cancel",
      actor: "rpc:gateway",
      reason: "operator stopped the deploy",
    });
  });

  test("a second cancel is refused: the durable request is claimed once", async () => {
    await seedRun(store.adapter);
    const control = createRunControl({ adapter: store.adapter });
    await control.cancel(RUN_ID, { actor: "cli:a", reason: "first" });
    const second = await control.cancel(RUN_ID, { actor: "cli:b", reason: "second" });
    expect(second.accepted).toBe(false);
    // Both attempts are still on the record — who tried matters even when the
    // verb was a no-op.
    const actors = (await readRunControlJournal(store.adapter, RUN_ID, { verb: "cancel" })).map((entry) => entry.actor);
    expect(actors).toContain("cli:a");
    expect(actors).toContain("cli:b");
  });
});

describe("hijack", () => {
  test("journals the actor, the reason, and the target it hands off to", async () => {
    await seedRun(store.adapter);
    const outcome = await createRunControl({ adapter: store.adapter }).hijack(RUN_ID, {
      actor: "cli:will",
      reason: "taking over the failing node",
      target: "claude-code",
    });
    expect(outcome.accepted).toBe(true);

    const run = await Effect.runPromise(store.adapter.getRun(RUN_ID));
    expect(run.hijackRequestedAtMs).toBeGreaterThan(0);
    expect(run.hijackTarget).toBe("claude-code");

    const journal = await readRunControlJournal(store.adapter, RUN_ID, { verb: "hijack" });
    expect(journal[0]).toMatchObject({
      verb: "hijack",
      actor: "cli:will",
      reason: "taking over the failing node",
      target: "claude-code",
    });
  });
});

describe("steer", () => {
  test("journals the verb around the caller's enqueue", async () => {
    await seedRun(store.adapter);
    let enqueued = false;
    const outcome = await createRunControl({ adapter: store.adapter }).steer(
      RUN_ID,
      { actor: "cli:will", reason: "redirect", nodeId: "worker", message: "try the other branch" },
      async () => {
        enqueued = true;
        return { accepted: true, status: "queued" };
      },
    );
    expect(enqueued).toBe(true);
    expect(outcome.accepted).toBe(true);
    const journal = await readRunControlJournal(store.adapter, RUN_ID, { verb: "steer" });
    expect(journal[0]).toMatchObject({ verb: "steer", actor: "cli:will", reason: "redirect" });
  });

  test("a failed enqueue is journaled as refused and then rethrown", async () => {
    await seedRun(store.adapter);
    const control = createRunControl({ adapter: store.adapter });
    await expect(
      control.steer(RUN_ID, { actor: "cli:will", reason: "redirect" }, async () => {
        throw new Error("no in-flight agent node");
      }),
    ).rejects.toThrow("no in-flight agent node");
    const journal = await readRunControlJournal(store.adapter, RUN_ID, { verb: "steer" });
    expect(journal.at(-1)).toMatchObject({
      phase: "applied",
      accepted: false,
      refusedBecause: "no in-flight agent node",
    });
  });
});

describe("journalRequest", () => {
  test("attributes a verb whose durable flip belongs to another call site", async () => {
    await seedRun(store.adapter);
    const { attribution } = await createRunControl({ adapter: store.adapter }).journalRequest("cancel", RUN_ID, {
      actor: "cli:will",
      reason: "smithers cancel run-control-1",
    });
    expect(attribution.actor).toBe("cli:will");
    const journal = await readRunControlJournal(store.adapter, RUN_ID);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ phase: "requested", verb: "cancel" });
  });
});
