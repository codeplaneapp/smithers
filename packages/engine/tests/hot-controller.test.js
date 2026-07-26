import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { HotWorkflowController, __hotWorkflowControllerInternals } from "../src/hot/HotWorkflowController.js";
function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "smithers-hot-ctrl-"));
}
function useNoopWatcher(ctrl) {
  ctrl.watcher = {
    waitEffect: () => Effect.succeed([]),
    startEffect: () => Effect.void,
    close: () => {},
  };
  return ctrl;
}
describe("HotWorkflowController", () => {
  const cleanups = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        await fn?.();
      } catch {}
    }
  });
  test("initializes with generation 0", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(entryPath, "export default { build: () => null };");
    const ctrl = new HotWorkflowController(entryPath, {
      outDir: join(dir, ".hmr"),
    });
    useNoopWatcher(ctrl);
    cleanups.push(() => ctrl.close());
    expect(ctrl.gen).toBe(0);
    await ctrl.init();
    expect(ctrl.gen).toBe(0);
  });
  test("creates output directory on init", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const outDir = join(dir, ".hmr");
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(entryPath, "export default { build: () => null };");
    const ctrl = new HotWorkflowController(entryPath, { outDir });
    useNoopWatcher(ctrl);
    cleanups.push(() => ctrl.close());
    expect(existsSync(outDir)).toBe(false);
    await ctrl.init();
    expect(existsSync(outDir)).toBe(true);
  });
  test("wait delegates through the watcher effect", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(entryPath, "export default { build: () => null };");
    const ctrl = new HotWorkflowController(entryPath, {
      outDir: join(dir, ".hmr"),
    });
    ctrl.watcher = {
      waitEffect: () => Effect.succeed(["workflow.ts"]),
      startEffect: () => Effect.void,
      close: () => {},
    };
    cleanups.push(() => ctrl.close());
    await expect(ctrl.wait()).resolves.toEqual(["workflow.ts"]);
  });
  test("reload increments generation", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(entryPath, "export default { build: () => null };");
    const ctrl = new HotWorkflowController(entryPath, {
      outDir: join(dir, ".hmr"),
    });
    useNoopWatcher(ctrl);
    cleanups.push(() => ctrl.close());
    await ctrl.init();
    const event = await ctrl.reload(["workflow.ts"]);
    expect(ctrl.gen).toBe(1);
    expect(event.generation).toBe(1);
  });
  test("reload returns failed when module has no default export", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(entryPath, "export const notDefault = 42;");
    const ctrl = new HotWorkflowController(entryPath, {
      outDir: join(dir, ".hmr"),
    });
    useNoopWatcher(ctrl);
    cleanups.push(() => ctrl.close());
    await ctrl.init();
    const event = await ctrl.reload(["workflow.ts"]);
    expect(event.type).toBe("failed");
    expect(event.generation).toBe(1);
  });
  test("reload returns failed when overlay source cannot be read", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const missingRoot = join(dir, "missing-root");
    const entryPath = join(missingRoot, "workflow.ts");
    const ctrl = new HotWorkflowController(entryPath, {
      rootDir: missingRoot,
      outDir: join(dir, ".hmr"),
    });
    useNoopWatcher(ctrl);
    cleanups.push(() => ctrl.close());
    const event = await ctrl.reload(["workflow.ts"]);
    expect(event.type).toBe("failed");
    expect(event.generation).toBe(1);
    if (event.type === "failed") {
      expect(event.error.code).toBe("HOT_OVERLAY_FAILED");
    }
  });
  test("reload returns failed when default lacks build function", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(entryPath, "export default { name: 'test' };");
    const ctrl = new HotWorkflowController(entryPath, {
      outDir: join(dir, ".hmr"),
    });
    useNoopWatcher(ctrl);
    cleanups.push(() => ctrl.close());
    await ctrl.init();
    const event = await ctrl.reload(["workflow.ts"]);
    expect(event.type).toBe("failed");
    if (event.type === "failed") {
      expect(event.error.message).toContain("build function");
    }
  });
  test("close removes output directory", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const outDir = join(dir, ".hmr");
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(entryPath, "export default { build: () => null };");
    const ctrl = new HotWorkflowController(entryPath, { outDir });
    useNoopWatcher(ctrl);
    await ctrl.init();
    expect(existsSync(outDir)).toBe(true);
    await ctrl.close();
    expect(existsSync(outDir)).toBe(false);
  });
  test("close is idempotent", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(entryPath, "export default { build: () => null };");
    const ctrl = new HotWorkflowController(entryPath, {
      outDir: join(dir, ".hmr"),
    });
    useNoopWatcher(ctrl);
    await ctrl.init();
    await ctrl.close();
    await ctrl.close(); // should not throw
  });
  test("defaults outDir to .smithers/hmr under entry directory", () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(entryPath, "ok");
    const ctrl = new HotWorkflowController(entryPath);
    useNoopWatcher(ctrl);
    cleanups.push(() => ctrl.close());
    // The controller should have been created without errors
    expect(ctrl.gen).toBe(0);
  });
  test("multiple reloads increment generation each time", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(entryPath, "export default { build: () => null };");
    const ctrl = new HotWorkflowController(entryPath, {
      outDir: join(dir, ".hmr"),
    });
    useNoopWatcher(ctrl);
    cleanups.push(() => ctrl.close());
    await ctrl.init();
    await ctrl.reload(["a.ts"]);
    expect(ctrl.gen).toBe(1);
    await ctrl.reload(["b.ts"]);
    expect(ctrl.gen).toBe(2);
    await ctrl.reload(["c.ts"]);
    expect(ctrl.gen).toBe(3);
  });
});
describe("HotWorkflowController internals", () => {
  test("classifies schema reload errors as unsafe", () => {
    const event = __hotWorkflowControllerInternals.makeHotReloadFailureEvent(
      new Error("Schema change detected: input shape changed"),
      {
        entryPath: "/tmp/workflow.ts",
        generation: 7,
        changedFiles: ["workflow.ts"],
      },
    );
    expect(event).toEqual({
      type: "unsafe",
      generation: 7,
      changedFiles: ["workflow.ts"],
      reason: "Schema change detected: input shape changed",
    });
  });
  test("classifies non-error reload failures as failed", () => {
    const event = __hotWorkflowControllerInternals.makeHotReloadFailureEvent("boom", {
      entryPath: "/tmp/workflow.ts",
      generation: 8,
      changedFiles: ["helper.ts"],
    });
    expect(event).toEqual({
      type: "failed",
      generation: 8,
      changedFiles: ["helper.ts"],
      error: "boom",
    });
  });
});
