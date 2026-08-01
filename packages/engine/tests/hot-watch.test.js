import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { WatchTree } from "../src/hot/watch.js";
function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "smithers-watch-"));
}
describe("WatchTree", () => {
  const cleanups = [];
  afterEach(async () => {
    for (const fn of cleanups) {
      try {
        await fn();
      } catch {}
    }
    cleanups.length = 0;
  });
  test("can be constructed and closed", () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tree = new WatchTree(dir);
    cleanups.push(() => tree.close());
    tree.close();
  });
  test("close resolves pending wait with empty array", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tree = new WatchTree(dir);
    await tree.start();
    // Start waiting (should hang until close or file change)
    const waitPromise = tree.wait();
    tree.close();
    const result = await waitPromise;
    expect(result).toEqual([]);
  });
  test("interrupting waitEffect removes only its resolver", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tree = new WatchTree(dir);
    const interrupted = Effect.runFork(tree.waitEffect());
    const remaining = Effect.runFork(tree.waitEffect());
    for (let i = 0; i < 10 && tree.waitResolves.size < 2; i += 1) {
      await Bun.sleep(0);
    }
    expect(tree.waitResolves.size).toBe(2);
    await Effect.runPromise(Fiber.interrupt(interrupted));
    expect(tree.waitResolves.size).toBe(1);
    tree.onFileChange(join(dir, "changed.ts"));
    tree.flush();
    expect(await Effect.runPromise(Fiber.join(remaining))).toEqual([join(dir, "changed.ts")]);
  });
  test("flush resolves all concurrent waiters", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tree = new WatchTree(dir);
    const first = Effect.runFork(tree.waitEffect());
    const second = Effect.runFork(tree.waitEffect());
    for (let i = 0; i < 10 && tree.waitResolves.size < 2; i += 1) {
      await Bun.sleep(0);
    }
    expect(tree.waitResolves.size).toBe(2);
    tree.onFileChange(join(dir, "changed.ts"));
    tree.flush();
    const expected = [join(dir, "changed.ts")];
    expect(await Effect.runPromise(Fiber.join(first))).toEqual(expected);
    expect(await Effect.runPromise(Fiber.join(second))).toEqual(expected);
  });
  test("detects file changes", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "initial.ts"), "export const x = 1;");
    const tree = new WatchTree(dir, { debounceMs: 50 });
    cleanups.push(() => tree.close());
    await tree.start();
    // Write a new file after starting
    setTimeout(() => {
      writeFileSync(join(dir, "changed.ts"), "export const y = 2;");
    }, 50);
    const changed = await tree.wait();
    expect(changed.length).toBeGreaterThan(0);
    tree.close();
  });
  test("respects debounce", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tree = new WatchTree(dir, { debounceMs: 200 });
    cleanups.push(() => tree.close());
    await tree.start();
    // Write multiple files rapidly
    setTimeout(() => {
      writeFileSync(join(dir, "a.ts"), "a");
      writeFileSync(join(dir, "b.ts"), "b");
    }, 50);
    const changed = await tree.wait();
    // Both changes should be batched together
    expect(changed.length).toBeGreaterThanOrEqual(1);
    tree.close();
  });
  test("ignores dotfiles", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tree = new WatchTree(dir, { debounceMs: 50 });
    cleanups.push(() => tree.close());
    await tree.start();
    // Write a dotfile - should not trigger change
    writeFileSync(join(dir, ".hidden"), "secret");
    // Then write a visible file to confirm we still detect real changes
    setTimeout(() => {
      writeFileSync(join(dir, "visible.ts"), "export const v = 1;");
    }, 100);
    const changed = await tree.wait();
    // The visible file should be detected, dotfile should not
    const hasHidden = changed.some((f) => f.includes(".hidden"));
    expect(hasHidden).toBe(false);
    expect(changed.length).toBeGreaterThan(0);
    tree.close();
  });
  test("accepts custom ignore list", () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tree = new WatchTree(dir, { ignore: ["dist", "build"] });
    cleanups.push(() => tree.close());
    // Should construct without error
    tree.close();
  });
  test("uses conservative polling with idle backoff", () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tree = new WatchTree(dir, { debounceMs: 50 });
    cleanups.push(() => tree.close());
    expect(tree.pollIntervalMs()).toBeGreaterThanOrEqual(1000);
    tree.resetPollBackoff();
    const first = tree.currentPollIntervalMs;
    tree.advancePollBackoff(false);
    expect(tree.currentPollIntervalMs).toBeGreaterThan(first);
    tree.advancePollBackoff(true);
    expect(tree.currentPollIntervalMs).toBe(first);
  });
});
