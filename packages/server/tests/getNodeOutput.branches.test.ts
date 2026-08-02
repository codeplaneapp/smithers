import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { zodToTable } from "@smthrs/db/zodToTable";
import { getNodeOutputRoute } from "../src/gatewayRoutes/getNodeOutput.js";

function nodeRow(outputTable: string, state = "finished") {
  return {
    runId: "run_1",
    nodeId: "task:main:0",
    iteration: 0,
    state,
    lastAttempt: 1,
    updatedAtMs: Date.now(),
    outputTable,
    label: "Task",
  };
}

function adapterFor(outputTable: string, opts?: { state?: string; attempts?: any[] }) {
  return {
    async listNodeIterations() {
      return [nodeRow(outputTable, opts?.state ?? "finished")];
    },
    async listAttempts() {
      return opts?.attempts ?? [];
    },
  };
}

function invoke(
  workflow: any,
  opts?: {
    selectOutputRowImpl?: any;
    iteration?: unknown;
    adapter?: any;
    outputTable?: string;
    state?: string;
    attempts?: any[];
  },
) {
  const outputTable = opts?.outputTable ?? "result";
  return getNodeOutputRoute({
    runId: "run_1",
    nodeId: "task:main:0",
    iteration: opts?.iteration ?? 0,
    async resolveRun() {
      return {
        workflow,
        adapter: opts?.adapter ?? adapterFor(outputTable, { state: opts?.state, attempts: opts?.attempts }),
      } as any;
    },
    selectOutputRowImpl: opts?.selectOutputRowImpl,
  });
}

describe("getNodeOutputRoute resolveOutputDefinition branches", () => {
  test("resolves via schemaRegistry.values() when the keyed lookup misses", async () => {
    const table = zodToTable("real_output_table", z.object({ value: z.string() }));
    const registry = new Map<string, any>([
      ["no_table_entry", {}], // entry?.table falsy -> continue
      ["bad_table_entry", { table: {} }], // getTableName throws -> catch
      ["different_key", { table }], // getTableName === outputTable -> hit
    ]);
    const response = await invoke(
      { db: {}, schemaRegistry: registry },
      { outputTable: "real_output_table", selectOutputRowImpl: async () => undefined, state: "pending" },
    );
    expect(response.status).toBe("pending");
    expect(response.schema).not.toBeNull();
  });

  test("falls through schemaRegistry (no match) to the db candidates", async () => {
    // schemaRegistry exists with .get and .values but neither finds the table,
    // so the loop completes and control falls to the db._.fullSchema candidates.
    const unrelated = zodToTable("unrelated_table", z.object({ a: z.string() }));
    const table = zodToTable("target_table", z.object({ value: z.string() }));
    const workflow = {
      db: { _: { fullSchema: { target_table: table } } },
      schemaRegistry: new Map<string, any>([["unrelated_table", { table: unrelated }]]),
    };
    const response = await invoke(workflow, {
      outputTable: "target_table",
      selectOutputRowImpl: async () => undefined,
      state: "pending",
    });
    expect(response.status).toBe("pending");
  });

  test("resolves via db._.fullSchema direct key", async () => {
    const table = zodToTable("fs_table", z.object({ value: z.string() }));
    const workflow = { db: { _: { fullSchema: { fs_table: table } } } };
    const response = await invoke(workflow, {
      outputTable: "fs_table",
      selectOutputRowImpl: async () => undefined,
      state: "pending",
    });
    expect(response.status).toBe("pending");
  });

  test("resolves via db.schema Object.values getTableName match (with a bad entry)", async () => {
    const table = zodToTable("dv_table", z.object({ value: z.string() }));
    const workflow = { db: { schema: { junk: {}, someKey: table } } };
    const response = await invoke(workflow, {
      outputTable: "dv_table",
      selectOutputRowImpl: async () => undefined,
      state: "pending",
    });
    expect(response.status).toBe("pending");
  });

  test("unregistered output table yields NodeHasNoOutput", async () => {
    const workflow = { db: {} };
    await expect(
      invoke(workflow, { outputTable: "ghost_table", selectOutputRowImpl: async () => undefined }),
    ).rejects.toMatchObject({ code: "NodeHasNoOutput" });
  });

  test("db.schema whose tables do not match completes the scan and yields NodeHasNoOutput", async () => {
    // The Object.values scan runs to completion without a getTableName match,
    // exercising the loop-completion fall-through before returning null.
    const other = zodToTable("other_name", z.object({ a: z.string() }));
    const workflow = { db: { schema: { other } } };
    await expect(
      invoke(workflow, { outputTable: "result", selectOutputRowImpl: async () => undefined }),
    ).rejects.toMatchObject({ code: "NodeHasNoOutput" });
  });
});

describe("getNodeOutputRoute row + error branches", () => {
  function registryWorkflow(name = "result") {
    const table = zodToTable(name, z.object({ value: z.string() }));
    return { db: {}, schemaRegistry: new Map([[name, { table, zodSchema: z.object({ value: z.string() }) }]]) };
  }

  test("non-object row yields MalformedOutputRow", async () => {
    await expect(invoke(registryWorkflow(), { selectOutputRowImpl: async () => 42 })).rejects.toMatchObject({
      code: "MalformedOutputRow",
    });
  });

  test("payload-only row is unwrapped to its payload", async () => {
    const response = await invoke(registryWorkflow(), {
      selectOutputRowImpl: async () => ({
        runId: "run_1",
        nodeId: "task:main:0",
        iteration: 0,
        payload: { deep: { ok: true } },
      }),
    });
    expect(response.status).toBe("produced");
    expect(response.row).toEqual({ deep: { ok: true } });
  });

  test("row containing a BigInt (JSON.stringify throws) yields MalformedOutputRow", async () => {
    await expect(
      invoke(registryWorkflow(), {
        selectOutputRowImpl: async () => ({ value: "x", big: 10n }),
      }),
    ).rejects.toMatchObject({ code: "MalformedOutputRow" });
  });

  test("row whose toJSON returns undefined yields MalformedOutputRow", async () => {
    // JSON.stringify returns undefined (not a string) when the value's toJSON
    // yields undefined, exercising the non-string guard in byteLengthOfJson.
    await expect(
      invoke(registryWorkflow(), {
        selectOutputRowImpl: async () => ({ value: "x", toJSON: () => undefined }),
      }),
    ).rejects.toMatchObject({ code: "MalformedOutputRow" });
  });

  test("non-malformed selectOutputRow error is re-thrown and logged as ServerError", async () => {
    await expect(
      invoke(registryWorkflow(), {
        selectOutputRowImpl: async () => {
          throw new Error("connection reset");
        },
      }),
    ).rejects.toThrow("connection reset");
  });

  test("failed node with unparseable heartbeat payload yields null partial", async () => {
    const response = await invoke(registryWorkflow(), {
      selectOutputRowImpl: async () => undefined,
      state: "failed",
      attempts: [{ attempt: 1, state: "failed", errorJson: '{"m":1}', heartbeatDataJson: "{not json" }],
    });
    expect(response.status).toBe("failed");
    expect(response.partial).toBeNull();
  });
});

describe("getNodeOutputRoute iteration coercion branches", () => {
  test("empty-string iteration is InvalidIteration", async () => {
    await expect(invoke({ db: {} }, { iteration: "" })).rejects.toMatchObject({ code: "InvalidIteration" });
  });

  test("non-integer iteration is InvalidIteration", async () => {
    await expect(invoke({ db: {} }, { iteration: 1.5 })).rejects.toMatchObject({ code: "InvalidIteration" });
    await expect(invoke({ db: {} }, { iteration: "abc" })).rejects.toMatchObject({ code: "InvalidIteration" });
  });
});
