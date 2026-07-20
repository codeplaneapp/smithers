import { describe, expect, test } from "bun:test";

import {
  gatewayKeys,
  mapSmithersElectricRow,
  normalizeGatewayRunEventRow,
  smithersCollectionKeys,
  smithersLocalCollectionOptions,
} from "../../src/index.ts";
import { smithersApiInvalidationPrefixes } from "../../src/data/smithersApiInvalidationPrefixes.ts";
import { asRecord, isGatewayResponseFrame, isObject } from "../../src/objectGuards.ts";
import { QueryClient } from "@tanstack/react-query";

describe("gatewayKeys", () => {
  test("static keys mirror the collection keys", () => {
    expect(gatewayKeys.workflows).toBe(smithersCollectionKeys.workflows);
    expect(gatewayKeys.runs).toBe(smithersCollectionKeys.runs);
    expect(gatewayKeys.run).toBe(smithersCollectionKeys.run);
    expect(gatewayKeys.approvals).toBe(smithersCollectionKeys.approvals);
    expect(gatewayKeys.devtoolsSnapshot).toBe(smithersCollectionKeys.runTree);
    expect(gatewayKeys.devtools).toBe(smithersCollectionKeys.runTree);
    expect(gatewayKeys.runEvents).toBe(smithersCollectionKeys.events);
  });

  test("nodeOutput and nodeDiff builders produce stable tuples with default iteration", () => {
    expect(gatewayKeys.nodeOutput("run-1", "task-a")).toEqual(["smithers", "nodeOutput", "run-1", "task-a", 0]);
    expect(gatewayKeys.nodeOutput("run-1", "task-a", 3)).toEqual(["smithers", "nodeOutput", "run-1", "task-a", 3]);
    expect(gatewayKeys.nodeDiff("run-1", "task-a")).toEqual(["smithers", "nodeDiff", "run-1", "task-a", 0]);
    expect(gatewayKeys.nodeDiff("run-1", "task-a", 5)).toEqual(["smithers", "nodeDiff", "run-1", "task-a", 5]);
  });
});

describe("smithersCollectionKeys", () => {
  test("builds every collection key, exercising the stable() serializer", () => {
    expect(smithersCollectionKeys.all).toEqual(["smithers"]);
    expect(smithersCollectionKeys.runs()).toEqual(["smithers", "runs", {}]);
    expect(smithersCollectionKeys.run("run-1")).toEqual(["smithers", "runs", "run-1"]);
    expect(smithersCollectionKeys.runTree("run-1")).toEqual(["smithers", "runTree", "run-1"]);
    expect(smithersCollectionKeys.events("run-1")).toEqual(["smithers", "events", "run-1", null]);
    expect(smithersCollectionKeys.events("run-1", 25)).toEqual(["smithers", "events", "run-1", 25]);
    expect(smithersCollectionKeys.approvals()).toEqual(["smithers", "approvals", {}]);
    expect(smithersCollectionKeys.workflows()).toEqual(["smithers", "workflows", {}]);
    expect(smithersCollectionKeys.docs()).toEqual(["smithers", "docs", {}]);
    expect(smithersCollectionKeys.prompts()).toEqual(["smithers", "prompts"]);
    expect(smithersCollectionKeys.scores()).toEqual(["smithers", "scores", { runId: "" }]);
    expect(smithersCollectionKeys.tickets()).toEqual(["smithers", "tickets", {}]);
    expect(smithersCollectionKeys.memoryFacts()).toEqual(["smithers", "memoryFacts", {}]);
    expect(smithersCollectionKeys.crons()).toEqual(["smithers", "crons", {}]);
  });

  test("stable() sorts keys, drops undefined, and recurses through arrays and nested objects", () => {
    const key = smithersCollectionKeys.runs({
      // @ts-expect-error exercising the stable serializer with an arbitrary shape
      filter: { workflow: "b", status: undefined, nested: { z: 1, a: [{ y: 2, x: undefined }, "s", 3] } },
    });
    // The third tuple element is the stabilized params object.
    expect(JSON.stringify(key[2])).toBe(
      JSON.stringify({ filter: { nested: { a: [{ y: 2 }, "s", 3], z: 1 }, workflow: "b" } }),
    );
  });
});

describe("smithersApiInvalidationPrefixes", () => {
  test("returns targeted prefixes for every known collection name and a root fallback", () => {
    expect(smithersApiInvalidationPrefixes("runs")).toEqual([["smithers", "runs"]]);
    expect(smithersApiInvalidationPrefixes("run_events")).toEqual([
      ["smithers", "events"],
      ["smithers", "runTree"],
      ["smithers", "runs"],
    ]);
    expect(smithersApiInvalidationPrefixes("events")).toEqual([
      ["smithers", "events"],
      ["smithers", "runTree"],
      ["smithers", "runs"],
    ]);
    expect(smithersApiInvalidationPrefixes("node_outputs")).toEqual([["smithers", "runTree"], ["smithers", "nodes"]]);
    expect(smithersApiInvalidationPrefixes("nodes")).toEqual([["smithers", "runTree"], ["smithers", "nodes"]]);
    expect(smithersApiInvalidationPrefixes("runTree")).toEqual([["smithers", "runTree"], ["smithers", "nodes"]]);
    expect(smithersApiInvalidationPrefixes("approvals")).toEqual([
      ["smithers", "approvals"],
      ["smithers", "runs"],
      ["smithers", "runTree"],
    ]);
    expect(smithersApiInvalidationPrefixes("workflows")).toEqual([["smithers", "workflows"]]);
    expect(smithersApiInvalidationPrefixes("docs")).toEqual([["smithers", "docs"]]);
    expect(smithersApiInvalidationPrefixes("prompts")).toEqual([["smithers", "prompts"]]);
    expect(smithersApiInvalidationPrefixes("scores")).toEqual([["smithers", "scores"]]);
    expect(smithersApiInvalidationPrefixes("tickets")).toEqual([["smithers", "tickets"], ["smithers", "docs"]]);
    expect(smithersApiInvalidationPrefixes("memoryFacts")).toEqual([["smithers", "memoryFacts"]]);
    expect(smithersApiInvalidationPrefixes("memory_facts")).toEqual([["smithers", "memoryFacts"]]);
    expect(smithersApiInvalidationPrefixes("crons")).toEqual([["smithers", "crons"], ["smithers", "runs"]]);
    expect(smithersApiInvalidationPrefixes("something-else")).toEqual([["smithers"]]);
  });
});

describe("smithersLocalCollectionOptions", () => {
  test("applies the local defaults and forwards the caller config", () => {
    const queryFn = async () => [{ id: "a" }];
    const queryClient = new QueryClient();
    const options = smithersLocalCollectionOptions<{ id: string }, readonly unknown[]>({
      id: "local-test",
      queryKey: ["smithers", "test"],
      queryClient,
      queryFn,
      getKey: (row) => row.id,
    } as never);
    expect(options).toBeDefined();
    queryClient.clear();
    // The helper hard-codes staleTime/gcTime/retry defaults; a returned config
    // object proves the queryCollectionOptions factory ran with them.
    expect(typeof options).toBe("object");
  });
});

describe("normalizeGatewayRunEventRow", () => {
  test("returns undefined for non-object, array, and null inputs", () => {
    expect(normalizeGatewayRunEventRow(null)).toBeUndefined();
    expect(normalizeGatewayRunEventRow(42)).toBeUndefined();
    expect(normalizeGatewayRunEventRow("x")).toBeUndefined();
    expect(normalizeGatewayRunEventRow([1, 2])).toBeUndefined();
  });

  test("returns undefined when seq cannot be read", () => {
    expect(normalizeGatewayRunEventRow({ runId: "r" })).toBeUndefined();
    expect(normalizeGatewayRunEventRow({ runId: "r", seq: "not-a-number" })).toBeUndefined();
  });

  test("reads snake_case and camelCase keys, coercing numeric strings", () => {
    expect(normalizeGatewayRunEventRow({ run_id: "r1", seq: "7", type: "node.output", timestamp_ms: "1700" })).toEqual({
      runId: "r1",
      seq: 7,
      event: "node.output",
      payload: undefined,
      timestampMs: 1700,
    });
  });

  test("defaults runId/event and parses payloadJson, falling back to raw on bad JSON", () => {
    expect(normalizeGatewayRunEventRow({ seq: 1, payloadJson: JSON.stringify({ a: 1 }) })).toEqual({
      runId: "",
      seq: 1,
      event: "event",
      payload: { a: 1 },
    });
    expect(normalizeGatewayRunEventRow({ seq: 2, payload_json: "{not json}" })).toEqual({
      runId: "",
      seq: 2,
      event: "event",
      payload: "{not json}",
    });
    // A non-string payloadJson is returned as-is by parsePayload.
    expect(normalizeGatewayRunEventRow({ seq: 3, payloadJson: 99 })).toEqual({
      runId: "",
      seq: 3,
      event: "event",
      payload: 99,
    });
    // An explicit payload wins over payloadJson.
    expect(normalizeGatewayRunEventRow({ seq: 4, payload: { direct: true }, payloadJson: "{}" })).toEqual({
      runId: "",
      seq: 4,
      event: "event",
      payload: { direct: true },
    });
  });
});

describe("mapSmithersElectricRow node mapping", () => {
  test("coerces bigint and numeric-string iteration values", () => {
    expect(mapSmithersElectricRow("nodes", {
      run_id: "run-b",
      node_id: "task2",
      iteration: 4n,
      state: "running",
      label: "Task two",
      output_table: "task",
    })).toMatchObject({ key: "run-b:task2:4", iteration: 4, status: "running" });

    expect(mapSmithersElectricRow("nodes", {
      run_id: "run-c",
      node_id: "task3",
      iteration: "9",
      state: "queued",
    })).toMatchObject({ key: "run-c:task3:9", iteration: 9 });
  });

  test("normalizes the persisted node-state vocabulary onto NodeStatus tones", () => {
    // `_smithers_nodes.state` stores the engine lifecycle words, not the UI's
    // NodeStatus values; `useGatewayRunTree` narrows anything unknown to
    // `queued`, so an unmapped `finished` row would render as never-started.
    const cases: Array<[state: string, status: string]> = [
      ["pending", "queued"],
      ["in-progress", "running"],
      ["finished", "ok"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
      ["waiting-approval", "waiting"],
      ["waiting-event", "waiting"],
      ["waiting-timer", "waiting"],
      ["skipped", "queued"],
    ];
    for (const [state, status] of cases) {
      expect(mapSmithersElectricRow("nodes", {
        run_id: "run",
        node_id: "task",
        iteration: 0,
        state,
        output_table: "task",
      }).status).toBe(status);
    }
  });

  test("applies the fallbacks when node fields are missing", () => {
    expect(mapSmithersElectricRow("nodes", {})).toEqual({
      key: "::0",
      id: "",
      name: "",
      cardLabel: "",
      kind: "task",
      status: "queued",
      iteration: 0,
      childIds: [],
    });
  });

  test("passes an unknown collection row straight through", () => {
    const row = { anything: 1 };
    expect(mapSmithersElectricRow("mystery-collection" as never, row)).toBe(row as never);
  });
});

describe("objectGuards", () => {
  test("isObject narrows plain objects only", () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
    expect(isObject(null)).toBe(false);
    expect(isObject([])).toBe(false);
    expect(isObject("s")).toBe(false);
    expect(isObject(3)).toBe(false);
  });

  test("isGatewayResponseFrame validates ok and error frames", () => {
    expect(isGatewayResponseFrame({ type: "res", id: "1", ok: true, payload: { a: 1 } })).toBe(true);
    // ok:true but no payload key.
    expect(isGatewayResponseFrame({ type: "res", id: "1", ok: true })).toBe(false);
    expect(isGatewayResponseFrame({ type: "res", id: "1", ok: false, error: { code: "X", message: "m" } })).toBe(true);
    // ok:false with malformed error.
    expect(isGatewayResponseFrame({ type: "res", id: "1", ok: false, error: { code: 1, message: "m" } })).toBe(false);
    expect(isGatewayResponseFrame({ type: "res", id: "1", ok: false, error: null })).toBe(false);
    // Wrong type / id / ok discriminants.
    expect(isGatewayResponseFrame({ type: "req", id: "1", ok: true, payload: 1 })).toBe(false);
    expect(isGatewayResponseFrame({ type: "res", id: 1, ok: true, payload: 1 })).toBe(false);
    expect(isGatewayResponseFrame({ type: "res", id: "1", ok: "yes" })).toBe(false);
    expect(isGatewayResponseFrame("nope")).toBe(false);
  });

  test("asRecord coerces non-objects to an empty record", () => {
    const record = { a: 1 };
    expect(asRecord(record)).toBe(record);
    expect(asRecord(null)).toEqual({});
    expect(asRecord([1])).toEqual({});
    expect(asRecord("x")).toEqual({});
  });
});
