import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createBrowserRuntime } from "../src/browser-runtime.js";
import { RuntimeCapabilityError } from "../src/RuntimeCapabilityError.js";

describe("createBrowserRuntime", () => {
  test("returns a fully spec-conformant adapter with no wrapping required", () => {
    const runtime = createBrowserRuntime();
    expect(runtime.name).toBe("browser");
    expect(typeof runtime.clock.now).toBe("function");
    expect(typeof runtime.clock.monotonicNow).toBe("function");
    expect(typeof runtime.clock.sleep).toBe("function");
    expect(typeof runtime.uuid).toBe("function");
    expect(typeof runtime.executeTask).toBe("function");
    expect(typeof runtime.storage.loadRun).toBe("function");
    expect(typeof runtime.storage.saveRun).toBe("function");
    expect(typeof runtime.storage.loadOutputs).toBe("function");
    expect(typeof runtime.storage.saveOutputs).toBe("function");
    expect(typeof runtime.filesystem.readFile).toBe("function");
    expect(typeof runtime.subprocess.spawn).toBe("function");
    expect(typeof runtime.worktree.resolve).toBe("function");
    expect(typeof runtime.sandbox.run).toBe("function");
  });

  test("uuid() returns distinct RFC4122-shaped identifiers", () => {
    const runtime = createBrowserRuntime();
    const a = runtime.uuid();
    const b = runtime.uuid();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("clock.now/monotonicNow use real Date/performance timing", async () => {
    const runtime = createBrowserRuntime();
    const before = runtime.clock.now();
    const beforeMono = runtime.clock.monotonicNow();
    await runtime.clock.sleep(5);
    expect(runtime.clock.now()).toBeGreaterThanOrEqual(before);
    expect(runtime.clock.monotonicNow()).toBeGreaterThanOrEqual(beforeMono);
  });

  test("clock.sleep is abortable", async () => {
    const runtime = createBrowserRuntime();
    const controller = new AbortController();
    const sleeping = runtime.clock.sleep(10_000, controller.signal);
    controller.abort();
    await expect(sleeping).rejects.toMatchObject({ name: "AbortError" });
  });

  test("storage round-trips runs and outputs as void-returning promises (Map-backed, not leaking Map objects)", async () => {
    const runtime = createBrowserRuntime();
    expect(await runtime.storage.saveRun("run-1", { runId: "run-1", status: "running" })).toBeUndefined();
    expect(await runtime.storage.saveOutputs("run-1", { t: [{ nodeId: "a", iteration: 0 }] })).toBeUndefined();
    expect(await runtime.storage.loadRun("run-1")).toEqual({ runId: "run-1", status: "running" });
    expect(await runtime.storage.loadOutputs("run-1")).toEqual({ t: [{ nodeId: "a", iteration: 0 }] });
    expect(await runtime.storage.loadRun("missing")).toBeUndefined();
  });

  test("executeTask runs compute tasks", async () => {
    const runtime = createBrowserRuntime();
    const out = await runtime.executeTask({ computeFn: () => "computed" }, {});
    expect(out).toBe("computed");
  });

  test("executeTask returns the static payload for static tasks", async () => {
    const runtime = createBrowserRuntime();
    const out = await runtime.executeTask({ staticPayload: { ok: true } }, {});
    expect(out).toEqual({ ok: true });
  });

  test("executeTask calls AgentLike.generate for agent tasks and validates outputSchema", async () => {
    const runtime = createBrowserRuntime();
    const schema = z.object({ summary: z.string() });
    const agent = {
      generate: async ({ prompt }) => ({ summary: `handled:${prompt}` }),
    };
    const out = await runtime.executeTask({ agent, prompt: "hello", outputSchema: schema }, {});
    expect(out).toEqual({ summary: "handled:hello" });
  });

  test("executeTask throws when agent output fails outputSchema validation", async () => {
    const runtime = createBrowserRuntime();
    const schema = z.object({ summary: z.string() });
    const agent = { generate: async () => ({ wrong: true }) };
    await expect(runtime.executeTask({ agent, prompt: "hello", outputSchema: schema }, {})).rejects.toThrow();
  });

  test("filesystem/subprocess/sandbox/worktree fail closed with typed RuntimeCapabilityError", async () => {
    const runtime = createBrowserRuntime();
    await expect(runtime.filesystem.readFile("/tmp/x")).rejects.toBeInstanceOf(RuntimeCapabilityError);
    await expect(runtime.subprocess.spawn("ls", [])).rejects.toBeInstanceOf(RuntimeCapabilityError);
    await expect(runtime.sandbox.run({})).rejects.toBeInstanceOf(RuntimeCapabilityError);
    expect(() => runtime.worktree.resolve("./lane")).toThrow(RuntimeCapabilityError);
    try {
      runtime.worktree.resolve("./lane");
      throw new Error("expected throw");
    } catch (error) {
      expect(error.runtime).toBe("browser");
      expect(error.capability).toBe("worktree");
      expect(error.operation).toBe("resolve");
    }
  });

  test("documented overrides (clock/storage/uuid/executeTask) are honored", async () => {
    const customClock = {
      now: () => 42,
      monotonicNow: () => 4242,
      sleep: async () => {},
    };
    const customUuid = () => "fixed-id";
    const customExecuteTask = async () => "custom-output";
    const runs = new Map();
    const outputs = new Map();
    const customStorage = {
      loadRun: async (runId) => runs.get(runId),
      saveRun: async (runId, run) => {
        runs.set(runId, run);
      },
      loadOutputs: async (runId) => outputs.get(runId),
      saveOutputs: async (runId, snapshot) => {
        outputs.set(runId, snapshot);
      },
    };
    const runtime = createBrowserRuntime({
      clock: customClock,
      uuid: customUuid,
      executeTask: customExecuteTask,
      storage: customStorage,
    });
    expect(runtime.clock.now()).toBe(42);
    expect(runtime.clock.monotonicNow()).toBe(4242);
    expect(runtime.uuid()).toBe("fixed-id");
    expect(await runtime.executeTask({}, {})).toBe("custom-output");
    await runtime.storage.saveRun("r", { runId: "r", status: "running" });
    expect(runs.get("r")).toEqual({ runId: "r", status: "running" });
  });
});
