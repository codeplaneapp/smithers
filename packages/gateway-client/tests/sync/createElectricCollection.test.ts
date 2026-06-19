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
  | { headers: { control: "up-to-date" } };

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
      // int8 STRINGS parsed to numbers
      createdAtMs: 1781851164043,
      updatedAtMs: 1781851164043,
      ttlMs: 3600000,
    });
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

  test("requests the table shape (and a namespace where-clause when filtered)", async () => {
    const collection = createCollection<GatewayMemoryFactRow, string>(
      createElectricCollection(electricCollectionDefs.memoryFacts({ namespace: "ci" }), {
        shapeUrl: "http://localhost:3000/v1/shape",
      }),
    );
    void collection.preload();
    await waitFor(() => activeControl !== null);
    expect(activeControl!.lastParams).toEqual({
      table: "_smithers_memory_facts",
      where: "namespace = 'ci'",
    });
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
});
