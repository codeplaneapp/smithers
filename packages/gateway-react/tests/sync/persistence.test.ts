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
import {
  openDbBackend,
  openOpfsSahPoolBackend,
  type SqliteWasmModule,
} from "../../src/sync/persistence/createSqliteWasmBackend.ts";
import { createGatewayPersistence } from "../../src/sync/persistence/createGatewayPersistence.ts";
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

  // FINDING 2 (P2): a corrupt cached row must clear the cache and leave NO open
  // sync transaction. The bug was: `begin()` then `JSON.parse()` per row — a bad
  // row threw AFTER `begin()`, so the catch cleared the cache while an
  // uncommitted transaction stayed attached to the collection, which can corrupt
  // later live-sync batching. The fix parses every row BEFORE `begin()`.
  test("a corrupt cached row clears the cache and leaves NO open transaction (live sync still works)", async () => {
    const { store } = await realStore();
    const def = gatewayCollectionDefs.runs({});
    const collectionId = syncKeyFingerprint(def.key);
    // Seed one valid row and one INVALID-JSON row directly into the cache.
    store.put(collectionId, "r1", JSON.stringify({ id: "r1", status: "running" }));
    store.put(collectionId, "rX", "{ this is not valid json");
    expect(store.read(collectionId)).toHaveLength(2);

    // Live transport delivers a fresh snapshot so we can prove sync still batches
    // correctly after the corrupt-cache hydrate path ran.
    const transport = makeTransport([{ id: "r2", status: "queued" }]);
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

    // THE core invariant: NO uncommitted sync transaction is left attached to the
    // collection. With the bug (begin() before the per-row parse), the corrupt
    // row threw AFTER begin(), so a `{ committed: false }` entry stayed on
    // `pendingSyncedTransactions` forever — and the live `commit()` (which reads
    // the LAST pending entry) then operated on the wrong transaction. TanStack
    // keeps uncommitted pending transactions on the stack across live commits, so
    // a leftover here is directly observable. The fix parses before begin(), so
    // the corrupt path opens no transaction → this stays empty/all-committed.
    const pending =
      (collection as unknown as {
        _state?: { pendingSyncedTransactions?: Array<{ committed: boolean }> };
      })._state?.pendingSyncedTransactions ?? [];
    const uncommitted = pending.filter((t) => !t.committed);
    expect(uncommitted).toHaveLength(0);

    // The corrupt cache was dropped on hydrate: the bad row `rX` AND the
    // valid-but-not-yet-hydrated `r1` are both gone, replaced only by what live
    // sync wrote through. The pre-existing cache keys did not survive.
    expect(store.read(collectionId).map((r) => r.key)).not.toContain("rX");
    expect(store.read(collectionId).map((r) => r.key)).not.toContain("r1");
    // No hydrated rows leaked into the collection; only the live snapshot is
    // present — proving live sync committed onto a CLEAN transaction stack.
    expect([...collection.keys()]).toEqual(["r2"]);
    const r2 = collection.get("r2") as { status: string } | undefined;
    expect(r2?.status).toBe("queued");
    // And the live snapshot was written through to the now-clean cache.
    expect(store.read(collectionId).map((r) => r.key)).toEqual(["r2"]);

    void collection.cleanup();
  });
});

describe("openOpfsSahPoolBackend (Finding 1: null-on-unavailable contract)", () => {
  // Helper: install/remove OPFS feature stubs so we reach the SAHPool install
  // path even under happy-dom (which ships no `navigator.storage` / OPFS).
  function withOpfsFeatures(run: () => Promise<void>): Promise<void> {
    const nav = globalThis.navigator as unknown as { storage?: unknown };
    const hadStorage = Object.prototype.hasOwnProperty.call(nav, "storage");
    const priorStorage = (nav as { storage?: unknown }).storage;
    const priorFfh = (globalThis as { FileSystemFileHandle?: unknown }).FileSystemFileHandle;
    Object.defineProperty(nav, "storage", {
      value: { getDirectory: () => Promise.resolve({}) },
      configurable: true,
    });
    function FakeFileHandle() {}
    (FakeFileHandle as unknown as { prototype: Record<string, unknown> }).prototype.createSyncAccessHandle =
      function () {};
    (globalThis as { FileSystemFileHandle?: unknown }).FileSystemFileHandle = FakeFileHandle;
    const restore = () => {
      if (hadStorage) {
        Object.defineProperty(nav, "storage", { value: priorStorage, configurable: true });
      } else {
        delete (nav as { storage?: unknown }).storage;
      }
      (globalThis as { FileSystemFileHandle?: unknown }).FileSystemFileHandle = priorFfh;
    };
    return run().finally(restore);
  }

  async function realModule(): Promise<SqliteWasmModule> {
    return (await sqlite3InitModule()) as unknown as SqliteWasmModule;
  }

  test("resolves null (does NOT reject) when installOpfsSAHPoolVfs REJECTS (locked pool / permission)", async () => {
    const real = await realModule();
    // A module whose feature flags pass but whose SAHPool install rejects — the
    // exact "OPFS present but pool locked by another tab / permission denied"
    // case. The contract: resolve null, never reject.
    const rejecting: SqliteWasmModule = {
      oo1: real.oo1,
      installOpfsSAHPoolVfs: () =>
        Promise.reject(new Error("OpfsSAHPool: pool is locked by another tab")),
    };
    await withOpfsFeatures(async () => {
      const backend = await openOpfsSahPoolBackend(rejecting);
      expect(backend).toBeNull();
    });
  });

  test("resolves null when opening the OpfsSAHPoolDb THROWS after a successful install", async () => {
    const real = await realModule();
    const throwingDb: SqliteWasmModule = {
      oo1: real.oo1,
      installOpfsSAHPoolVfs: () =>
        Promise.resolve({
          OpfsSAHPoolDb: class {
            constructor() {
              throw new Error("cannot open db over SAHPool VFS");
            }
          } as unknown as SqliteWasmModule["oo1"]["DB"],
        }),
    };
    await withOpfsFeatures(async () => {
      const backend = await openOpfsSahPoolBackend(throwingDb);
      expect(backend).toBeNull();
    });
  });

  test("resolves null when createSyncAccessHandle is absent (SAHPool requirement unmet)", async () => {
    const real = await realModule();
    // installOpfsSAHPoolVfs is present, but we DON'T install the FileSystemFileHandle
    // feature → the pre-flight feature probe must bail to null before any install.
    let installCalled = false;
    const moduleWithInstall: SqliteWasmModule = {
      oo1: real.oo1,
      installOpfsSAHPoolVfs: () => {
        installCalled = true;
        return Promise.reject(new Error("should not be called"));
      },
    };
    const nav = globalThis.navigator as unknown as { storage?: unknown };
    Object.defineProperty(nav, "storage", {
      value: { getDirectory: () => Promise.resolve({}) },
      configurable: true,
    });
    try {
      const backend = await openOpfsSahPoolBackend(moduleWithInstall);
      expect(backend).toBeNull();
      expect(installCalled).toBe(false);
    } finally {
      delete (nav as { storage?: unknown }).storage;
    }
  });

  test("createGatewayPersistence resolves null when the SAHPool backend is unavailable (live path continues)", async () => {
    const real = await realModule();
    const rejecting: SqliteWasmModule = {
      oo1: real.oo1,
      installOpfsSAHPoolVfs: () => Promise.reject(new Error("OPFS denied")),
    };
    await withOpfsFeatures(async () => {
      // No forcePlainDbFile → goes through the OPFS SAHPool path, which rejects.
      // createGatewayPersistence must therefore resolve null, not reject — so a
      // caller that opted into persistence still boots (live-only).
      const persistence = await createGatewayPersistence({
        sqlite3: rejecting,
        schemaVersion: "v1",
      });
      expect(persistence).toBeNull();
    });
  });
});
