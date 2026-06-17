import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import React from "react";
import { z } from "zod";
import { createSmithers } from "../src/create.js";
import { prepareOutputSchemas } from "../src/prepareOutputSchemas.js";
import {
  createExternalSmithers,
  hostNodeToReact,
  serializeCtx,
} from "../src/external/create-external-smithers.js";

let tempDirs = [];

function makeDbPath(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return join(dir, "smithers.db");
}

function closeApi(api) {
  try {
    api.db?.$client?.close?.();
  } catch {}
  try {
    api.cleanup?.();
  } catch {}
}

afterEach(() => {
  delete process.env.SMITHERS_HOT;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("prepareOutputSchemas", () => {
  test("creates stable alias outputs for duplicate schema objects", () => {
    const shared = z.object({ value: z.string() });
    const unique = z.object({ ok: z.boolean() });
    const prepared = prepareOutputSchemas({
      input: z.object({ prompt: z.string() }),
      first: shared,
      second: shared,
      result: unique,
    });

    expect(prepared.outputs.input).toBeDefined();
    expect(prepared.outputs.first).not.toBe(shared);
    expect(prepared.outputs.second).not.toBe(shared);
    expect(prepared.outputs.first).not.toBe(prepared.outputs.second);
    expect(prepared.outputs.result).toBe(unique);
    expect(prepared.ambiguousZodSchemas.has(shared)).toBe(true);
    expect(prepared.zodToKeyName.get(prepared.outputs.first)).toBe("first");
    expect(prepared.zodToKeyName.get(prepared.outputs.second)).toBe("second");
    expect(prepared.zodToKeyName.get(unique)).toBe("result");
    expect(prepared.zodToKeyName.has(shared)).toBe(false);
  });
});

describe("createSmithers", () => {
  test("creates schema-backed API wrappers and merges workflow alert policy", () => {
    const shared = z.object({ value: z.string() });
    const api = createSmithers(
      {
        input: z.object({ prompt: z.string().optional() }),
        first: shared,
        second: shared,
        result: z.object({ ok: z.boolean() }),
      },
      {
        dbPath: makeDbPath("smithers-create-"),
        readableName: "Readable",
        description: "Description",
        alertPolicy: {
          defaults: { severity: "warning", labels: { team: "core" } },
          rules: { slow: { labels: { route: "ops" } } },
          reactions: { pager: { kind: "webhook", url: "https://example.test" } },
        },
      },
    );

    try {
      expect(Object.keys(api.tables).sort()).toEqual(["first", "result", "second"]);
      expect(api.outputs.first).not.toBe(shared);
      expect(api.outputs.second).not.toBe(shared);
      expect(api.ambiguousZodSchemas).toBeUndefined();

      const workflow = api.smithers(
        () => React.createElement(api.Workflow, { name: "workflow" }, "child"),
        {
          alertPolicy: {
            defaults: { labels: { priority: "high" } },
            rules: {
              slow: { severity: "critical", labels: { route: "dev" } },
              failed: { severity: "page" },
            },
            reactions: { slack: { kind: "webhook", url: "https://slack.test" } },
          },
        },
      );

      expect(workflow.readableName).toBe("Readable");
      expect(workflow.description).toBe("Description");
      expect([...workflow.schemaRegistry.keys()].sort()).toEqual([
        "first",
        "result",
        "second",
      ]);
      expect(workflow.ambiguousZodSchemas.has(shared)).toBe(true);
      expect(workflow.zodToKeyName.get(api.outputs.first)).toBe("first");
      expect(workflow.zodToKeyName.get(api.outputs.second)).toBe("second");
      expect(workflow.opts.alertPolicy).toMatchObject({
        defaults: {
          severity: "warning",
          labels: { team: "core", priority: "high" },
        },
        rules: {
          slow: { severity: "critical", labels: { route: "dev" } },
          failed: { severity: "page" },
        },
        reactions: {
          pager: { kind: "webhook", url: "https://example.test" },
          slack: { kind: "webhook", url: "https://slack.test" },
        },
      });

      const ctx = {
        runId: "run",
        iteration: 0,
        iterations: {},
        input: { prompt: "hello" },
      };
      const built = workflow.build(ctx);
      expect(built.props.value).toBe(ctx);

      expect(api.Workflow({ name: "direct", children: "x" }).props.children).toBe("x");
      expect(api.Task({ id: "task", children: "x" }).props.smithersContext).toBeDefined();
      expect(api.Approval({ id: "gate", children: "x" }).props.smithersContext).toBeDefined();
      expect(api.Signal({ id: "sig", children: "x" }).props.smithersContext).toBeDefined();
      const sandbox = api.Sandbox({ id: "box", children: "x" });
      expect(sandbox.props.workflow.schemaRegistry).toBe(workflow.schemaRegistry);
      expect(sandbox.props.smithersContext).toBeDefined();
    } finally {
      closeApi(api);
    }
  });

  test("reuses hot APIs and rejects hot schema changes", () => {
    process.env.SMITHERS_HOT = "1";
    const dbPath = makeDbPath("smithers-hot-");
    const schema = { result: z.object({ value: z.string() }) };
    const first = createSmithers(schema, { dbPath });

    try {
      const second = createSmithers(
        { result: z.object({ value: z.string() }) },
        {
          dbPath,
          alertPolicy: { defaults: { labels: { module: "second" } } },
        },
      );
      expect(second).toBe(first);

      const workflow = second.smithers(() =>
        React.createElement(second.Workflow, { name: "hot" }),
      );
      expect(workflow.opts.alertPolicy.defaults.labels.module).toBe("second");

      expect(() =>
        createSmithers({ result: z.object({ value: z.number() }) }, { dbPath }),
      ).toThrow("Schema change detected");
    } finally {
      closeApi(first);
    }
  });

  test("adds the default input payload column to existing input tables", () => {
    const dbPath = makeDbPath("smithers-input-upgrade-");
    const sqlite = new Database(dbPath);
    sqlite.exec(`CREATE TABLE input (run_id TEXT PRIMARY KEY)`);
    sqlite.close();

    const api = createSmithers(
      { result: z.object({ value: z.string() }) },
      { dbPath },
    );

    try {
      const columns = api.db.$client.query(`PRAGMA table_info("input")`).all();
      expect(columns.map((column) => column.name)).toContain("payload");
    } finally {
      closeApi(api);
    }
  });

  test("registered database exit close hook is idempotent and catches close failures", () => {
    const before = process.listeners("exit");
    const api = createSmithers(
      { result: z.object({ value: z.string() }) },
      { dbPath: makeDbPath("smithers-close-hook-") },
    );
    const closeHook = process.listeners("exit").find((listener) => !before.includes(listener));
    expect(closeHook).toBeFunction();
    try {
      expect(() => closeHook?.(0)).not.toThrow();
      expect(() => closeHook?.(0)).not.toThrow();
    } finally {
      if (closeHook) {
        process.off("exit", closeHook);
      }
      closeApi(api);
    }

    const beforeThrowing = process.listeners("exit");
    const throwingApi = createSmithers(
      { result: z.object({ value: z.string() }) },
      { dbPath: makeDbPath("smithers-close-hook-throw-") },
    );
    const throwingHook = process.listeners("exit").find((listener) => !beforeThrowing.includes(listener));
    const sqlite = throwingApi.db.$client;
    const originalClose = sqlite.close.bind(sqlite);
    let throwOnce = true;
    sqlite.close = () => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("close failed");
      }
      return originalClose();
    };
    try {
      expect(() => throwingHook?.(0)).not.toThrow();
    } finally {
      if (throwingHook) {
        process.off("exit", throwingHook);
      }
      sqlite.close = originalClose;
      originalClose();
    }
  });
});

describe("createExternalSmithers", () => {
  test("serializes context and converts host nodes to React elements", () => {
    const outputs = () => {};
    outputs.ready = [{ value: 1 }];
    outputs.ignored = { value: 2 };

    expect(
      serializeCtx({
        runId: "run",
        iteration: 2,
        iterations: { loop: 3 },
        input: { prompt: "go" },
        outputs,
      }),
    ).toEqual({
      runId: "run",
      iteration: 2,
      iterations: { loop: 3 },
      input: { prompt: "go" },
      outputs: { ready: [{ value: 1 }] },
    });

    const agent = { id: "agent" };
    const element = hostNodeToReact(
      {
        kind: "element",
        tag: "Task",
        rawProps: { id: "task", agent: "coder" },
        children: [{ kind: "text", text: "hello" }],
      },
      { coder: agent },
    );
    expect(element.type).toBe("Task");
    expect(element.props.agent).toBe(agent);
    expect(element.props.children).toBe("hello");
    expect(hostNodeToReact({ kind: "text", text: "plain" }, {})).toBe("plain");
    try {
      hostNodeToReact(
        {
          kind: "element",
          tag: "Task",
          rawProps: { id: "missing", agent: "unknown" },
          children: [],
        },
        {},
      );
      throw new Error("Expected UNKNOWN_AGENT");
    } catch (error) {
      expect(error.code).toBe("UNKNOWN_AGENT");
    }
  });

  test("creates an external workflow with tables and schema lookup metadata", () => {
    const shared = z.object({ value: z.string() });
    const seen = [];
    const workflow = createExternalSmithers({
      dbPath: makeDbPath("smithers-external-"),
      schemas: {
        input: z.object({ prompt: z.string().optional() }),
        first: shared,
        second: shared,
        result: z.object({ ok: z.boolean() }),
      },
      agents: { coder: { id: "coder" } },
      buildFn: (ctx) => {
        seen.push(ctx);
        return {
          kind: "element",
          tag: "Task",
          rawProps: { id: "task", agent: "coder" },
          children: [{ kind: "text", text: ctx.input.prompt }],
        };
      },
    });

    try {
      expect(Object.keys(workflow.tables).sort()).toEqual([
        "first",
        "result",
        "second",
      ]);
      expect([...workflow.schemaRegistry.keys()].sort()).toEqual([
        "first",
        "result",
        "second",
      ]);
      expect(workflow.ambiguousZodSchemas.has(shared)).toBe(true);
      expect([...workflow.zodToKeyName.values()].sort()).toEqual([
        "first",
        "result",
        "second",
      ]);

      const element = workflow.build({
        runId: "run",
        iteration: 0,
        iterations: {},
        input: { prompt: "external" },
      });
      expect(element.type).toBe("Task");
      expect(element.props.agent.id).toBe("coder");
      expect(element.props.children).toBe("external");
      expect(seen[0]).toMatchObject({
        runId: "run",
        input: { prompt: "external" },
      });
    } finally {
      closeApi(workflow);
    }
  });
});
