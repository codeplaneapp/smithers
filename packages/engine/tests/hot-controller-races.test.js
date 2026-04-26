import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HotWorkflowController } from "../src/hot/HotWorkflowController.js";

function makeTempDir() {
    return mkdtempSync(join(tmpdir(), "smithers-hot-races-"));
}

describe("HotWorkflowController race conditions", () => {
    /** @type {Array<() => unknown>} */
    const cleanups = [];
    afterEach(async () => {
        for (const fn of cleanups) {
            try {
                await fn();
            } catch {}
        }
        cleanups.length = 0;
    });

    test("concurrent reload() calls each get a unique generation number", async () => {
        const dir = makeTempDir();
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const entryPath = join(dir, "workflow.ts");
        writeFileSync(entryPath, "export default { build: () => null };");
        const ctrl = new HotWorkflowController(entryPath, {
            outDir: join(dir, ".hmr"),
        });
        cleanups.push(() => ctrl.close());
        await ctrl.init();

        // Fire 5 reloads concurrently — each must end up with a distinct
        // generation. After they all settle, ctrl.gen must equal 5.
        const events = await Promise.all([
            ctrl.reload(["a.ts"]),
            ctrl.reload(["b.ts"]),
            ctrl.reload(["c.ts"]),
            ctrl.reload(["d.ts"]),
            ctrl.reload(["e.ts"]),
        ]);
        const generations = events.map((e) => e.generation).sort((a, b) => a - b);
        expect(generations).toEqual([1, 2, 3, 4, 5]);
        expect(ctrl.gen).toBe(5);
    });

    test("rapid sequential reloads strictly increment generation", async () => {
        const dir = makeTempDir();
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const entryPath = join(dir, "workflow.ts");
        writeFileSync(entryPath, "export default { build: () => null };");
        const ctrl = new HotWorkflowController(entryPath, {
            outDir: join(dir, ".hmr"),
        });
        cleanups.push(() => ctrl.close());
        await ctrl.init();

        for (let i = 1; i <= 10; i += 1) {
            const event = await ctrl.reload([`change${i}.ts`]);
            expect(event.generation).toBe(i);
            expect(ctrl.gen).toBe(i);
        }
    });

    test("reload failure does not block subsequent reload from succeeding", async () => {
        const dir = makeTempDir();
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const entryPath = join(dir, "workflow.ts");
        // Start with an invalid module that fails reload (no default export).
        writeFileSync(entryPath, "export const notDefault = 42;");
        const ctrl = new HotWorkflowController(entryPath, {
            outDir: join(dir, ".hmr"),
        });
        cleanups.push(() => ctrl.close());
        await ctrl.init();

        const failedEvent = await ctrl.reload(["bad.ts"]);
        expect(failedEvent.type).toBe("failed");
        expect(failedEvent.generation).toBe(1);

        // Fix the module and reload again — generation must keep incrementing
        // even though the previous load was bad.
        writeFileSync(entryPath, "export default { build: () => null };");
        const okEvent = await ctrl.reload(["good.ts"]);
        expect(okEvent.type).toBe("reloaded");
        expect(okEvent.generation).toBe(2);
        expect(ctrl.gen).toBe(2);
    });

    test("close() during in-flight reload completes without throwing", async () => {
        const dir = makeTempDir();
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const entryPath = join(dir, "workflow.ts");
        writeFileSync(entryPath, "export default { build: () => null };");
        const ctrl = new HotWorkflowController(entryPath, {
            outDir: join(dir, ".hmr"),
        });
        await ctrl.init();

        // Start a reload, then close immediately. Both promises must settle
        // without throwing — close() should be safe to call mid-reload.
        const reloadPromise = ctrl.reload(["x.ts"]);
        const closePromise = ctrl.close();

        // close() should resolve cleanly.
        await closePromise;
        // The reload may either succeed or fail, but it must settle.
        const result = await reloadPromise;
        expect(["reloaded", "failed", "unsafe"]).toContain(result.type);
    });

    test("generations sequence is monotonic across mixed success and failure", async () => {
        const dir = makeTempDir();
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const entryPath = join(dir, "workflow.ts");
        writeFileSync(entryPath, "export default { build: () => null };");
        const ctrl = new HotWorkflowController(entryPath, {
            outDir: join(dir, ".hmr"),
        });
        cleanups.push(() => ctrl.close());
        await ctrl.init();

        const collected = [];
        // 1: success
        collected.push(await ctrl.reload(["a.ts"]));
        // 2: fail (bad module)
        writeFileSync(entryPath, "throw new Error('boom');");
        collected.push(await ctrl.reload(["b.ts"]));
        // 3: fail (missing default)
        writeFileSync(entryPath, "export const x = 1;");
        collected.push(await ctrl.reload(["c.ts"]));
        // 4: success
        writeFileSync(entryPath, "export default { build: () => null };");
        collected.push(await ctrl.reload(["d.ts"]));

        expect(collected.map((e) => e.generation)).toEqual([1, 2, 3, 4]);
        expect(collected[0].type).toBe("reloaded");
        expect(collected[1].type).toBe("failed");
        expect(collected[2].type).toBe("failed");
        expect(collected[3].type).toBe("reloaded");
    });
});
