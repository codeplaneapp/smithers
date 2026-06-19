import { createCollection } from "@tanstack/db";
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createElectricCollection,
  type ElectricCollectionDef,
} from "../../src/sync/createElectricCollection.ts";
import {
  electricCollectionDefs,
  mapMemoryFactRow,
} from "../../src/sync/electricCollectionDefs.ts";
import type { GatewayMemoryFactRow } from "../../src/sync/GatewayMemoryFactRow.ts";

/**
 * Drives `createElectricCollection` against a FAKE `@electric-sql/client`
 * ShapeStream that replays the exact wire format the cloud-electric PoC observed
 * (`poc/cloud-electric/README.md`): int8 `*_ms` columns as decimal STRINGS,
 * `value_json` as a JSON string, snake_case columns, and `{ value, headers:{
 * operation } }` change messages terminated by an `up-to-date` control. This is
 * the package-level proof that an Electric shape → the same `GatewayMemoryFactRow`
 * collection the gateway path produces, with no consumer changes.
 */

type FakeMessage =
  | { value: Record<string, unknown>; old_value?: Record<string, unknown>; headers: { operation: "insert" | "update" | "delete" } }
  | { headers: { control: "up-to-date" | "must-refetch" } };

/** A controllable stand-in for the Electric ShapeStream the code lazy-imports. */
type FakeStreamControl = {
  /** The shape params the code requested (table/where). */
  lastParams: Record<string, unknown> | undefined;
  /** Push a batch of messages to all subscribers (one Electric `subscribe` cb call). */
  push: (messages: FakeMessage[]) => void;
};

let activeControl: FakeStreamControl | null = null;

class FakeShapeStream {
  static last: FakeShapeStream | null = null;
  lastParams: Record<string, unknown> | undefined;
  private callbacks: Array<(messages: FakeMessage[]) => void> = [];
  constructor(options: { url: string; params?: Record<string, unknown> }) {
    this.lastParams = options.params;
    FakeShapeStream.last = this;
    activeControl = {
      lastParams: options.params,
      push: (messages) => {
        for (const cb of this.callbacks) cb(messages);
      },
    };
  }
  subscribe(callback: (messages: FakeMessage[]) => void): () => void {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter((cb) => cb !== callback);
    };
  }
}

// Replace the lazily-imported Electric client with the fake before any test runs.
mock.module("@electric-sql/client", () => ({ ShapeStream: FakeShapeStream }));

afterEach(() => {
  activeControl = null;
  FakeShapeStream.last = null;
});

async function waitFor(assertion: () => boolean) {
  for (let i = 0; i < 200; i += 1) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(assertion()).toBe(true);
}

// Mirrors the PoC's observed row.value exactly (README "Row shape").
function rawRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    namespace: "global",
    key: "poc/cloud-electric/proof",
    value_json: '{"note":"cloud-electric PoC"}',
    schema_sig: null,
    created_at_ms: "1781851164043",
    updated_at_ms: "1781851164043",
    ttl_ms: null,
    ...overrides,
  };
}

function memoryDef(): ElectricCollectionDef<GatewayMemoryFactRow, string> {
  return electricCollectionDefs.memoryFacts();
}

describe("mapMemoryFactRow", () => {
  test("decodes the Electric wire format into a GatewayMemoryFactRow", () => {
    const row = mapMemoryFactRow(rawRow({ ttl_ms: "3600000", schema_sig: "sig-1" }));
    expect(row).toEqual({
      namespace: "global",
      key: "poc/cloud-electric/proof",
      valueJson: '{"note":"cloud-electric PoC"}',
      schemaSig: "sig-1",
      // int8 STRINGS parsed to numbers (defensive — real wire is bigint, below)
      createdAtMs: 1781851164043,
      updatedAtMs: 1781851164043,
      ttlMs: 3600000,
    });
  });

  // REGRESSION (codex P2 finding 2): the real `@electric-sql/client` parser maps
  // Postgres int8 → bigint BEFORE our subscriber (defaultParser.int8 = BigInt).
  // The mapper MUST coerce bigint → a real ms number, not silently fall to 0
  // (which rendered every fact as epoch-1970 in the UI).
  test("coerces int8 columns delivered as BIGINT to a real ms number", () => {
    const row = mapMemoryFactRow(
      rawRow({
        created_at_ms: 1781851164043n,
        updated_at_ms: 1781851164999n,
        ttl_ms: 3600000n,
      }),
    );
    expect(row?.createdAtMs).toBe(1781851164043);
    expect(row?.updatedAtMs).toBe(1781851164999);
    expect(row?.ttlMs).toBe(3600000);
    expect(typeof row?.createdAtMs).toBe("number");
    // NOT epoch-1970 — the bug symptom was these all collapsing to 0.
    expect(row?.createdAtMs).toBeGreaterThan(0);
    expect(row?.updatedAtMs).toBeGreaterThan(0);
  });

  // The Electric parser is the canonical source of the bigint: parse a real
  // int8 cell exactly as the client does and confirm asMs survives it. This
  // pins the fix to the ACTUAL parser behavior, not our assumption of it.
  test("survives the value the real @electric-sql/client int8 parser produces", () => {
    // defaultParser.int8 = (v) => BigInt(v) — reproduce it on the raw HTTP cell.
    const fromParser = BigInt("1781851164043");
    expect(typeof fromParser).toBe("bigint");
    const row = mapMemoryFactRow(rawRow({ created_at_ms: fromParser, updated_at_ms: fromParser }));
    expect(row?.createdAtMs).toBe(1781851164043);
    expect(row?.updatedAtMs).toBe(1781851164043);
  });

  test("null int8 / schema columns map to null", () => {
    const row = mapMemoryFactRow(rawRow());
    expect(row?.ttlMs).toBeNull();
    expect(row?.schemaSig).toBeNull();
  });

  test("drops a row missing a PK part", () => {
    expect(mapMemoryFactRow(rawRow({ key: undefined }))).toBeUndefined();
    expect(mapMemoryFactRow(rawRow({ namespace: 123 }))).toBeUndefined();
  });
});

describe("createElectricCollection", () => {
  test("loads the initial shape snapshot into the collection", async () => {
    const collection = createCollection<GatewayMemoryFactRow, string>(
      createElectricCollection(memoryDef(), { shapeUrl: "http://localhost:3000/v1/shape" }),
    );
    const preload = collection.preload();
    await waitFor(() => activeControl !== null);

    // Snapshot: a change message + the up-to-date control.
    activeControl!.push([
      { value: rawRow(), headers: { operation: "insert" } },
      { headers: { control: "up-to-date" } },
    ]);
    await preload;

    expect(collection.status).toBe("ready");
    const row = collection.get("global:poc/cloud-electric/proof");
    expect(row?.namespace).toBe("global");
    expect(row?.createdAtMs).toBe(1781851164043);
    expect(typeof row?.createdAtMs).toBe("number");
  });

  test("requests the table shape (and a PARAMETERIZED namespace where when filtered)", async () => {
    const collection = createCollection<GatewayMemoryFactRow, string>(
      createElectricCollection(electricCollectionDefs.memoryFacts({ namespace: "ci" }), {
        shapeUrl: "http://localhost:3000/v1/shape",
      }),
    );
    void collection.preload();
    await waitFor(() => activeControl !== null);
    // The namespace is bound POSITIONALLY ($1), never interpolated into the SQL.
    expect(activeControl!.lastParams).toEqual({
      table: "_smithers_memory_facts",
      where: "namespace = $1",
      params: { "1": "ci" },
    });
  });

  // REGRESSION (codex P2 finding 3): a namespace containing a single quote must
  // be carried as a bound parameter, NOT spliced into the predicate string (which
  // would break/alter the SQL). The where string stays constant; the value rides
  // in `params`.
  test("never interpolates a quote-bearing namespace into the where predicate", async () => {
    const evil = "ci'; DROP TABLE _smithers_memory_facts;--";
    const collection = createCollection<GatewayMemoryFactRow, string>(
      createElectricCollection(electricCollectionDefs.memoryFacts({ namespace: evil }), {
        shapeUrl: "http://localhost:3000/v1/shape",
      }),
    );
    void collection.preload();
    await waitFor(() => activeControl !== null);
    const params = activeControl!.lastParams!;
    expect(params.where).toBe("namespace = $1");
    expect((params.params as Record<string, string>)["1"]).toBe(evil);
    // The raw value never appears inside the SQL string.
    expect(String(params.where)).not.toContain("DROP TABLE");
    expect(String(params.where)).not.toContain("'");
  });

  test("applies a live insert, update, then delete from the shape tail", async () => {
    const collection = createCollection<GatewayMemoryFactRow, string>(
      createElectricCollection(memoryDef(), { shapeUrl: "http://localhost:3000/v1/shape" }),
    );
    const preload = collection.preload();
    await waitFor(() => activeControl !== null);
    // Empty snapshot.
    activeControl!.push([{ headers: { control: "up-to-date" } }]);
    await preload;
    expect(collection.size).toBe(0);

    // Live insert.
    activeControl!.push([
      { value: rawRow({ key: "live/a", value_json: '"first"' }), headers: { operation: "insert" } },
      { headers: { control: "up-to-date" } },
    ]);
    await waitFor(() => collection.size === 1);
    expect(collection.get("global:live/a")?.valueJson).toBe('"first"');

    // Live update (same PK, new value).
    activeControl!.push([
      {
        value: rawRow({ key: "live/a", value_json: '"second"', updated_at_ms: "1781851164999" }),
        headers: { operation: "update" },
      },
      { headers: { control: "up-to-date" } },
    ]);
    await waitFor(() => collection.get("global:live/a")?.valueJson === '"second"');
    expect(collection.get("global:live/a")?.updatedAtMs).toBe(1781851164999);

    // Live delete.
    activeControl!.push([
      { value: rawRow({ key: "live/a" }), headers: { operation: "delete" } },
      { headers: { control: "up-to-date" } },
    ]);
    await waitFor(() => collection.size === 0);
  });

  // REGRESSION (codex P2 finding 1): the INITIAL snapshot must DELETE keys the
  // collection holds but the snapshot omits. Live (non-snapshot) batches must NOT
  // reconcile — they delete only via explicit delete messages.
  test("initial snapshot reconciles — drops a key the snapshot omits, then live batches do not", async () => {
    const collection = createCollection<GatewayMemoryFactRow, string>(
      createElectricCollection(memoryDef(), { shapeUrl: "http://localhost:3000/v1/shape" }),
    );
    const preload = collection.preload();
    await waitFor(() => activeControl !== null);

    // First snapshot establishes two rows (simulating two cached/hydrated rows).
    activeControl!.push([
      { value: rawRow({ key: "stale/gone" }), headers: { operation: "insert" } },
      { value: rawRow({ key: "kept/here" }), headers: { operation: "insert" } },
      { headers: { control: "up-to-date" } },
    ]);
    await preload;
    expect(collection.size).toBe(2);

    // A LIVE batch (after the initial snapshot) inserts one row WITHOUT carrying
    // the other current keys — it must NOT reconcile them away.
    activeControl!.push([
      { value: rawRow({ key: "live/added" }), headers: { operation: "insert" } },
      { headers: { control: "up-to-date" } },
    ]);
    await waitFor(() => collection.size === 3);
    expect(collection.has("global:stale/gone")).toBe(true);
    expect(collection.has("global:kept/here")).toBe(true);
    expect(collection.has("global:live/added")).toBe(true);
  });

  // The persistence scenario from finding 1: a row deleted in Postgres while the
  // app was closed is hydrated from the SQLite cache, then a `must-refetch` (or
  // re-subscribe) snapshot that omits it must reconcile it OUT — not leave it
  // stale forever. `must-refetch` re-arms the same reconcile the initial snapshot
  // uses, so we drive the persisted-stale-key removal through it.
  test("must-refetch snapshot reconciles a cache-hydrated key absent from Postgres", async () => {
    const collection = createCollection<GatewayMemoryFactRow, string>(
      createElectricCollection(memoryDef(), { shapeUrl: "http://localhost:3000/v1/shape" }),
    );
    const preload = collection.preload();
    await waitFor(() => activeControl !== null);

    // Initial snapshot has two rows; one of them ("deleted-while-offline") will
    // be gone from Postgres by the time the shape re-snapshots.
    activeControl!.push([
      { value: rawRow({ key: "survives" }), headers: { operation: "insert" } },
      { value: rawRow({ key: "deleted-while-offline" }), headers: { operation: "insert" } },
      { headers: { control: "up-to-date" } },
    ]);
    await preload;
    expect(collection.size).toBe(2);
    expect(collection.has("global:deleted-while-offline")).toBe(true);

    // Shape rotation: must-refetch, then a fresh snapshot that no longer carries
    // the deleted row (Postgres truth). Reconcile must remove it.
    activeControl!.push([
      { headers: { control: "must-refetch" } },
      { value: rawRow({ key: "survives" }), headers: { operation: "insert" } },
      { headers: { control: "up-to-date" } },
    ]);
    await waitFor(() => collection.size === 1);
    expect(collection.has("global:survives")).toBe(true);
    expect(collection.has("global:deleted-while-offline")).toBe(false);
  });
});
