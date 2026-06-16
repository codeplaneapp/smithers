import type { PersistenceAdapter, PersistedRow, SavePersistedRowsRequest } from "./sync/PersistenceAdapter.ts";

/**
 * Web durable cache for the Phase 2 client-persistence milestone.
 *
 * This is an OPFS-backed JSON store, NOT SQLite. It is named for exactly what it
 * does so nothing claims a SQLite round-trip it does not perform: it serializes
 * the persisted collections into one JSON file under the Origin Private File
 * System and rewrites that file per coalesced save. It delivers the milestone's
 * headline web value — warm reload and offline reads — against the real OPFS
 * API with no fabricated data.
 *
 * Real SQLite-WASM/OPFS on the web is DEFERRED (design §5.4, risk §11.2):
 * `@tanstack/db@0.6.8` ships no SQLite persistence contract, and the OPFS SQLite
 * VFS needs a cross-origin-isolated worker harness that is out of scope for this
 * phase. The genuine SQLite adapter is `createBunSqlitePersistenceAdapter`
 * (real `bun:sqlite`), used by the native build and proven end-to-end in the
 * gateway-react persistence tests; both adapters implement the identical
 * `PersistenceAdapter` contract, including schemaVersion-clear semantics.
 */

type CreateOpfsJsonPersistenceAdapterOptions = {
  name?: string;
};

type StoredState = {
  schemaVersion?: string;
  collections: Record<string, PersistedRow<object>[]>;
};

type OpfsFileHandle = {
  getFile(): Promise<Blob>;
  createWritable(): Promise<{
    write(data: string): Promise<void>;
    close(): Promise<void>;
  }>;
};

type OpfsDirectory = {
  getFileHandle(name: string, options: { create: boolean }): Promise<OpfsFileHandle>;
  removeEntry?(name: string): Promise<void>;
};

function opfsDirectory(): Promise<OpfsDirectory> | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as unknown as { storage?: { getDirectory?: () => Promise<OpfsDirectory> } }).storage?.getDirectory?.();
}

async function readState(name: string): Promise<StoredState> {
  const directory = opfsDirectory();
  if (!directory) return { collections: {} };
  try {
    const root = await directory;
    const file = await root.getFileHandle(`${name}.json`, { create: true });
    const blob = await file.getFile();
    const text = await blob.text();
    return text ? (JSON.parse(text) as StoredState) : { collections: {} };
  } catch {
    return { collections: {} };
  }
}

async function writeState(name: string, state: StoredState): Promise<void> {
  const directory = opfsDirectory();
  if (!directory) return;
  const root = await directory;
  const file = await root.getFileHandle(`${name}.json`, { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(state));
  await writable.close();
}

export async function createOpfsJsonPersistenceAdapter(
  options: CreateOpfsJsonPersistenceAdapterOptions = {},
): Promise<PersistenceAdapter> {
  const name = options.name ?? "smithers-client-sync";

  let state = await readState(name);
  const ensureVersion = async (schemaVersion: string) => {
    if (!state.schemaVersion) {
      state = { ...state, schemaVersion };
      await writeState(name, state);
      return;
    }
    if (state.schemaVersion !== schemaVersion) {
      state = { schemaVersion, collections: {} };
      await writeState(name, state);
    }
  };

  return {
    async loadRows<TRow extends object>(collectionId: string, schemaVersion: string): Promise<readonly PersistedRow<TRow>[]> {
      await ensureVersion(schemaVersion);
      return (state.collections[collectionId] ?? []) as PersistedRow<TRow>[];
    },
    async saveRows<TRow extends object>(request: SavePersistedRowsRequest<TRow>): Promise<void> {
      await ensureVersion(request.schemaVersion);
      state.collections[request.collectionId] = request.rows.map((row) => ({ key: row.key, row: row.row }));
      await writeState(name, state);
    },
    async reset(): Promise<void> {
      state = { collections: {} };
      await writeState(name, state);
    },
  };
}
