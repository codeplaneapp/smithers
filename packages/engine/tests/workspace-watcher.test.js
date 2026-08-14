import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { createWorkspaceWatcher } from "../src/workspaceWatcher.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alwaysRelevant = async () => true;

/** A controllable fake watch backend: returns a `fire` to inject change events. */
function fakeWatch() {
  let onChange = () => {};
  let closed = false;
  const backend = (_cwd, cb) => {
    onChange = cb;
    return {
      close() {
        closed = true;
      },
    };
  };
  return {
    backend,
    fire: (relPath) => onChange(relPath),
    isClosed: () => closed,
  };
}

describe("createWorkspaceWatcher debounce + ignore (fake backend)", () => {
  test("coalesces a burst of changes into a single settle", async () => {
    const fake = fakeWatch();
    let settles = 0;
    const w = createWorkspaceWatcher({
      cwd: "/wt",
      onSettle: () => settles++,
      debounceMs: 20,
      watch: fake.backend,
      classify: alwaysRelevant,
    });
    expect(w.watching).toBe(true);
    fake.fire("a.txt");
    fake.fire("b.txt");
    fake.fire("c.txt");
    await sleep(50);
    expect(settles).toBe(1);
    w.close();
  });

  test("separate quiet periods produce separate settles", async () => {
    const fake = fakeWatch();
    let settles = 0;
    const w = createWorkspaceWatcher({
      cwd: "/wt",
      onSettle: () => settles++,
      debounceMs: 20,
      watch: fake.backend,
      classify: alwaysRelevant,
    });
    fake.fire("a.txt");
    await sleep(40);
    fake.fire("b.txt");
    await sleep(40);
    expect(settles).toBe(2);
    w.close();
  });

  test("ignores .jj and .git paths (no settle, no loop)", async () => {
    const fake = fakeWatch();
    let settles = 0;
    const w = createWorkspaceWatcher({
      cwd: "/wt",
      onSettle: () => settles++,
      debounceMs: 20,
      watch: fake.backend,
      classify: alwaysRelevant,
    });
    fake.fire(".jj/working_copy/checkout");
    fake.fire(".git/index");
    await sleep(40);
    expect(settles).toBe(0);
    w.close();
  });

  test("close stops further settles and closes the backend", async () => {
    const fake = fakeWatch();
    let settles = 0;
    const w = createWorkspaceWatcher({
      cwd: "/wt",
      onSettle: () => settles++,
      debounceMs: 20,
      watch: fake.backend,
      classify: alwaysRelevant,
    });
    fake.fire("a.txt");
    w.close();
    await sleep(40);
    expect(settles).toBe(0);
    expect(fake.isClosed()).toBe(true);
  });

  test("an unwatchable path degrades to a safe no-op watcher", () => {
    const w = createWorkspaceWatcher({
      cwd: "/wt",
      onSettle: () => {},
      watch: () => null,
    });
    expect(w.watching).toBe(false);
    expect(() => w.close()).not.toThrow();
  });

  test("an all-ignored batch suppresses settle", async () => {
    const fake = fakeWatch();
    const batches = [];
    let settles = 0;
    const w = createWorkspaceWatcher({
      cwd: "/wt",
      onSettle: () => settles++,
      debounceMs: 20,
      watch: fake.backend,
      classify: async (cwd, paths) => {
        batches.push([cwd, [...paths]]);
        return false;
      },
    });
    fake.fire("node_modules/pkg/a.js");
    fake.fire("node_modules/pkg/a.js");
    fake.fire("dist/app.js");
    await sleep(50);
    expect(batches).toEqual([["/wt", ["node_modules/pkg/a.js", "dist/app.js"]]]);
    expect(settles).toBe(0);
    w.close();
  });

  test("a mixed batch fires settle", async () => {
    const fake = fakeWatch();
    let settles = 0;
    const w = createWorkspaceWatcher({
      cwd: "/wt",
      onSettle: () => settles++,
      debounceMs: 20,
      watch: fake.backend,
      classify: async () => true,
    });
    fake.fire("node_modules/pkg/a.js");
    fake.fire("src/app.js");
    await sleep(50);
    expect(settles).toBe(1);
    w.close();
  });

  test("a classifier failure fires settle", async () => {
    const fake = fakeWatch();
    let settles = 0;
    const w = createWorkspaceWatcher({
      cwd: "/wt",
      onSettle: () => settles++,
      debounceMs: 20,
      watch: fake.backend,
      classify: async () => {
        throw new Error("git unavailable");
      },
    });
    fake.fire("src/app.js");
    await sleep(50);
    expect(settles).toBe(1);
    w.close();
  });

  test("pending-path cap overflow fires settle without classification", async () => {
    const fake = fakeWatch();
    let settles = 0;
    let classifications = 0;
    const w = createWorkspaceWatcher({
      cwd: "/wt",
      onSettle: () => settles++,
      debounceMs: 20,
      watch: fake.backend,
      classify: async () => {
        classifications++;
        return false;
      },
    });
    for (let i = 0; i <= 500; i++) fake.fire(`generated/file-${i}.js`);
    await sleep(50);
    expect(classifications).toBe(0);
    expect(settles).toBe(1);
    w.close();
  });
});

describe("createWorkspaceWatcher against the real filesystem", () => {
  test("a real file write produces a settle", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-watch-"));
    let settles = 0;
    const w = createWorkspaceWatcher({
      cwd: dir,
      onSettle: () => settles++,
      debounceMs: 50,
    });
    try {
      expect(w.watching).toBe(true);
      // fs.watch (FSEvents on macOS) needs a moment to arm, and delivery
      // latency spikes under load — a single early write can fall in the
      // arming gap and be lost forever. So keep producing fresh writes
      // with a quiet gap after each (long enough for the 50ms debounce to
      // settle) until a settle lands, within the test timeout budget.
      for (let i = 0; i < 16 && settles === 0; i++) {
        await fs.writeFile(path.join(dir, `work-${i}.txt`), "v1\n");
        await sleep(500);
      }
      expect(settles).toBeGreaterThanOrEqual(1);
    } finally {
      w.close();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15_000);
});
