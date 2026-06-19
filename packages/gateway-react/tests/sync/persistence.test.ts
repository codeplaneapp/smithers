// Drives the REAL persistence layer over a REAL SQLite-WASM database (the
// `@sqlite.org/sqlite-wasm` Node build), with NO mock. The browser uses the same
// `PersistentCollectionStore` + `withPersistence` logic over an OPFS SAHPool VFS;
// only the VFS differs (in-memory here vs. durable OPFS in the browser), so this
// proves the cache read/write/serialize/schema-invalidation logic the reload path
// depends on. The cross-reload durability *itself* (OPFS survives a real browser
// reload) is proven by `tests/e2e-real/persist.spec.ts` in apps/multi.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof globalThis.document === "undefined") {
  GlobalRegistrator.register();
}

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, test } from "bun:test";
import { createCollection } from "@tanstack/react-db";
import {
  createGatewayCollection,
  gatewayCollectionDefs,
  syncKeyFingerprint,
  type SyncTransport,
} from "@smithers-orchestrator/gateway-client";
import { PersistentCollectionStore } from "../../src/sync/persistence/PersistentCollectionStore.ts";
import { openDbBackend, type SqliteWasmModule } from "../../src/sync/persistence/createSqliteWasmBackend.ts";
import { withPersistence } from "../../src/sync/persistence/withPersistence.ts";

async function realStore(schemaVersion = "v1") {
  const sqlite3 = (await sqlite3InitModule()) as unknown as SqliteWasmModule;
  const backend = openDbBackend(sqlite3, ":memory:");
  return { sqlite3, backend, store: PersistentCollectionStore.open(backend, schemaVersion) };
}

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("PersistentCollectionStore (real SQLite-WASM)", () => {
  test("write → read round-trips rows through a real SQLite DB", async () => {
    const { store } = await realStore();
    store.put("runs", "r1", JSON.stringify({ id: "r1", status: "running" }));
    store.put("runs", "r2", JSON.stringify({ id: "r2", status: "done" }));
    store.put("approvals", "a1", JSON.stringify({ id: "a1" }));

    const runs = store.read("runs");
    expect(runs).toHaveLength(2);
    expect(JSON.parse(runs[0]!.json)).toEqual({ id: "r1", status: "running" });
    expect(JSON.parse(runs[1]!.json)).toEqual({ id: "r2", status: "done" });
    // Collections are isolated by id.
    expect(store.read("approvals")).toHaveLength(1);
    expect(store.read("crons")).toHaveLength(0);
  });

  test("reopening the SAME backend sees the persisted rows (durability of the table)", async () => {
    const { backend, store } = await realStore("v1");
    store.replace("memoryFacts", [
      { key: "auth:token", json: JSON.stringify({ namespace: "auth", key: "token" }) },
    ]);
    // A FRESH store over the SAME underlying DB handle = a reload of the page
    // against the same OPFS file: the rows are still there, no re-seed.
    const reopened = PersistentCollectionStore.open(backend, "v1");
    const rows = reopened.read("memoryFacts");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.json)).toEqual({ namespace: "auth", key: "token" });
  });

  test("replace() reconciles to exactly the given rows (upsert + delete)", async () => {
    const { store } = await realStore();
    store.replace("tickets", [
      { key: "t1", json: JSON.stringify({ path: "t1", v: 1 }) },
      { key: "t2", json: JSON.stringify({ path: "t2", v: 1 }) },
    ]);
    // Drop t2, change t1, add t3.
    store.replace("tickets", [
      { key: "t1", json: JSON.stringify({ path: "t1", v: 2 }) },
      { key: "t3", json: JSON.stringify({ path: "t3", v: 1 }) },
    ]);
    const rows = store.read("tickets");
    expect(rows.map((r) => r.key)).toEqual(["t1", "t3"]);
    expect(JSON.parse(rows[0]!.json)).toEqual({ path: "t1", v: 2 });
  });

  test("a schemaVersion bump invalidates the cache on open", async () => {
    const { backend } = await realStore("v1");
    const v1 = PersistentCollectionStore.open(backend, "v1");
    v1.put("scores", "s1", JSON.stringify({ id: "s1" }));
    expect(v1.read("scores")).toHaveLength(1);

    // Reopen the SAME DB at a NEW schema version → cache dropped clean.
    const v2 = PersistentCollectionStore.open(backend, "v2");
    expect(v2.read("scores")).toHaveLength(0);

    // Same version again keeps whatever v2 wrote.
    v2.put("scores", "s2", JSON.stringify({ id: "s2" }));
    const v2again = PersistentCollectionStore.open(backend, "v2");
    expect(v2again.read("scores")).toHaveLength(1);
  });

  test("clearAll / clearCollection drop cached rows", async () => {
    const { store } = await realStore();
    store.put("runs", "r1", "{}");
    store.put("crons", "c1", "{}");
    store.clearCollection("runs");
    expect(store.read("runs")).toHaveLength(0);
    expect(store.read("crons")).toHaveLength(1);
    store.clearAll();
    expect(store.read("crons")).toHaveLength(0);
  });
});

describe("withPersistence (real collection + real SQLite-WASM)", () => {
  // A transport whose listRuns RPC resolves to a fixed live snapshot, and whose
  // stream is the no-op the pollable INVALIDATE_SCOPE path uses (it never yields).
  function makeTransport(rows: Array<{ id: string; status: string }>): SyncTransport {
    return {
      async rpc(method) {
        if (method === "listRuns") return rows;
        return [];
      },
      stream() {
        return {
          async *[Symbol.asyncIterator]() {
            // never yields; a never-ending idle stream
            await new Promise<void>(() => {});
          },
        };
      },
    };
  }

  test("a cold collection seeds the cache from the live snapshot", async () => {
    const { store } = await realStore();
    const def = gatewayCollectionDefs.runs({});
    const transport = makeTransport([
      { id: "r1", status: "running" },
      { id: "r2", status: "done" },
    ]);
    const config = createGatewayCollection({
      key: def.key,
      client: transport,
      getKey: (row: { id: string }) => row.id,
      method: "listRuns",
      startSync: false,
    });
    const collection = createCollection(withPersistence(config, store));
    collection.subscribeChanges(() => {}); // attach a subscriber → startSync
    await settle(20);
    // The live snapshot was written through to the cache.
    const cached = store.read(config.id!);
    expect(cached.map((r) => r.key).sort()).toEqual(["r1", "r2"]);
    void collection.cleanup();
  });

  test("a WARM collection hydrates from cache on first sync (no-flash reload)", async () => {
    const { store } = await realStore();
    const def = gatewayCollectionDefs.runs({});
    const collectionId = syncKeyFingerprint(def.key);
    // Pre-seed the cache as if a prior session had persisted these rows.
    store.replace(collectionId, [
      { key: "r1", json: JSON.stringify({ id: "r1", status: "running" }) },
      { key: "r2", json: JSON.stringify({ id: "r2", status: "queued" }) },
    ]);

    // A transport whose RPC NEVER resolves → proves the rows on screen came from
    // the cache, not the network (the reload-no-flash guarantee).
    const transport: SyncTransport = {
      rpc: () => new Promise(() => {}),
      stream: () => ({ async *[Symbol.asyncIterator]() { await new Promise<void>(() => {}); } }),
    };
    const config = createGatewayCollection({
      key: def.key,
      client: transport,
      getKey: (row: { id: string }) => row.id,
      method: "listRuns",
      startSync: false,
    });
    const collection = createCollection(withPersistence(config, store));
    collection.subscribeChanges(() => {});
    await settle(20);

    // Hydrated synchronously from cache even though the live RPC is still pending.
    expect([...collection.keys()].sort()).toEqual(["r1", "r2"]);
    const r1 = collection.get("r1") as { status: string } | undefined;
    expect(r1?.status).toBe("running");
    void collection.cleanup();
  });
});
