import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createDocWatcher } from "../src/createDocWatcher.js";
import { startDocFileSync } from "../src/startDocFileSync.js";
import { syncDocsFromDisk } from "../src/syncDocsFromDisk.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

function fakeWatcher() {
  let onSettle = () => {};
  let closed = false;
  return {
    create({ onSettle: cb }) {
      onSettle = cb;
      return {
        close() {
          closed = true;
        },
        watching: true,
      };
    },
    settle(paths) {
      onSettle(paths);
    },
    isClosed() {
      return closed;
    },
  };
}

describe("docs file sync", () => {
  test("local markdown edits upsert docs rows and deletes write tombstones", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "smithers-doc-sync-"));
    const { adapter, sqlite } = createTestDb();
    const watcher = fakeWatcher();
    try {
      await fs.mkdir(path.join(cwd, ".smithers", "tickets"), { recursive: true });
      await fs.writeFile(path.join(cwd, ".smithers", "tickets", "demo.md"), "# Demo\n", "utf8");
      const sync = await startDocFileSync({
        enabled: true,
        cwd,
        adapter,
        nowMs: () => 10,
        createWatcher: watcher.create.bind(watcher),
        syncOnStart: false,
      });
      watcher.settle(["tickets/demo.md"]);
      await sync.flush([]);
      const doc = await adapter.getDoc("tickets/demo.md");
      expect(doc).toMatchObject({
        path: "tickets/demo.md",
        kind: "ticket",
        content: "# Demo\n",
        deletedAtMs: null,
      });

      await fs.rm(path.join(cwd, ".smithers", "tickets", "demo.md"));
      watcher.settle(["tickets/demo.md"]);
      await sync.flush([]);
      const deleted = await adapter.getDoc("tickets/demo.md", { includeDeleted: true });
      expect(deleted?.deletedAtMs).toBe(10);
      expect(await adapter.listDocs()).toHaveLength(0);
      await sync.stop();
      expect(watcher.isClosed()).toBe(true);
    } finally {
      sqlite.close();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("large bursts shed the oldest pending paths and surface the drop", () => {
    const settled = [];
    const drops = [];
    let trigger = (_path) => {};
    const watcher = createDocWatcher({
      cwd: "/wt",
      onSettle: (paths) => settled.push(paths),
      maxPendingPaths: 4,
      onDrop: (info) => drops.push(info),
      watch(_cwd, onChange) {
        trigger = onChange;
        return { close() {} };
      },
      // Defer the debounce flush so a whole burst accumulates before settling.
      setTimeoutFn() {
        return 0;
      },
      clearTimeoutFn() {},
    });
    for (let i = 0; i < 10; i += 1) {
      trigger(`.smithers/tickets/t${i}.md`);
    }
    // Six of the ten distinct paths are shed (cap 4); the drop is reported,
    // not silently swallowed.
    expect(watcher.droppedCount()).toBe(6);
    expect(drops).toHaveLength(6);
    expect(drops[0]).toMatchObject({ path: "tickets/t0.md", droppedTotal: 1 });
    watcher.flush();
    // The newest four survive; the oldest were the ones shed.
    expect(settled).toEqual([["tickets/t6.md", "tickets/t7.md", "tickets/t8.md", "tickets/t9.md"]]);
    watcher.close();
  });

  test("a slow consumer serializes settles without losing or interleaving writes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "smithers-doc-slow-"));
    const { adapter: realAdapter, sqlite } = createTestDb();
    const watcher = fakeWatcher();
    let active = 0;
    let maxActive = 0;
    const slowAdapter = {
      upsertDocRow: async (row) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        try {
          return await realAdapter.upsertDocRow(row);
        } finally {
          active -= 1;
        }
      },
    };
    try {
      await fs.mkdir(path.join(cwd, ".smithers", "tickets"), { recursive: true });
      for (const name of ["a", "b", "c"]) {
        await fs.writeFile(path.join(cwd, ".smithers", "tickets", `${name}.md`), `# ${name}\n`, "utf8");
      }
      const sync = await startDocFileSync({
        enabled: true,
        cwd,
        adapter: slowAdapter,
        nowMs: () => 42,
        createWatcher: watcher.create.bind(watcher),
        syncOnStart: false,
      });
      // Fire three settles back-to-back while the consumer is slow.
      watcher.settle(["tickets/a.md"]);
      watcher.settle(["tickets/b.md"]);
      watcher.settle(["tickets/c.md"]);
      await sync.flush([]);
      // The chain is a bounded buffer of one in-flight sync: writes never overlap.
      expect(maxActive).toBe(1);
      // No settle is lost: every file is durably upserted.
      expect(await realAdapter.listDocs()).toHaveLength(3);
      await sync.stop();
    } finally {
      sqlite.close();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("discovery scan finds markdown under doc roots and skips everything else", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "smithers-doc-discover-"));
    const rows = [];
    const adapter = { upsertDocRow: async (row) => rows.push(row) };
    try {
      await fs.mkdir(path.join(cwd, ".smithers", "tickets"), { recursive: true });
      await fs.mkdir(path.join(cwd, ".smithers", "plans", "deep"), { recursive: true });
      await fs.mkdir(path.join(cwd, ".smithers", "notdocs"), { recursive: true });
      await fs.mkdir(path.join(cwd, ".smithers", "tickets", ".git"), { recursive: true });
      await fs.writeFile(path.join(cwd, ".smithers", "tickets", "a.md"), "# a\n");
      await fs.writeFile(path.join(cwd, ".smithers", "plans", "deep", "b.md"), "# b\n");
      await fs.writeFile(path.join(cwd, ".smithers", "tickets", "notes.txt"), "not a doc");
      await fs.writeFile(path.join(cwd, ".smithers", "notdocs", "c.md"), "# outside doc roots");
      await fs.writeFile(path.join(cwd, ".smithers", "tickets", ".git", "hidden.md"), "# vcs internals");

      const result = await syncDocsFromDisk({ cwd, adapter, nowMs: () => 7 });

      expect(result).toEqual({ upserted: 2, tombstoned: 0, skipped: 0, dropped: 0 });
      expect(rows.map((row) => row.path).sort()).toEqual(["plans/deep/b.md", "tickets/a.md"]);
      expect(rows.find((row) => row.path === "plans/deep/b.md")?.kind).toBe("plan");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("discovery scan sheds paths over maxPaths and reports the drop", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "smithers-doc-cap-"));
    const rows = [];
    const adapter = { upsertDocRow: async (row) => rows.push(row) };
    try {
      await fs.mkdir(path.join(cwd, ".smithers", "tickets"), { recursive: true });
      for (const name of ["a", "b", "c", "d"]) {
        await fs.writeFile(path.join(cwd, ".smithers", "tickets", `${name}.md`), `# ${name}\n`);
      }

      const result = await syncDocsFromDisk({ cwd, adapter, nowMs: () => 7, maxPaths: 2 });

      // Discovery accepts one over the cap so the shed is detectable
      // rather than a silent truncation.
      expect(result.upserted).toBe(2);
      expect(result.dropped).toBe(1);
      expect(rows).toHaveLength(2);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("explicit paths are normalized: traversal, non-markdown, and unknown roots are skipped", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "smithers-doc-norm-"));
    const rows = [];
    const adapter = { upsertDocRow: async (row) => rows.push(row) };
    try {
      await fs.mkdir(path.join(cwd, ".smithers", "tickets"), { recursive: true });
      await fs.writeFile(path.join(cwd, ".smithers", "tickets", "ok.md"), "# ok\n");

      const result = await syncDocsFromDisk({
        cwd,
        adapter,
        nowMs: () => 7,
        paths: [
          "tickets/../../../etc/passwd.md", // traversal segment
          "tickets/ok.txt", // not markdown
          "unknown/x.md", // not a doc root
          "tickets", // no file segment
          "tickets/ok.md",
        ],
      });

      expect(result).toEqual({ upserted: 1, tombstoned: 0, skipped: 4, dropped: 0 });
      expect(rows.map((row) => row.path)).toEqual(["tickets/ok.md"]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("explicit path bursts over maxPaths shed the overflow and count it", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "smithers-doc-burst-"));
    const rows = [];
    const adapter = { upsertDocRow: async (row) => rows.push(row) };
    try {
      await fs.mkdir(path.join(cwd, ".smithers", "tickets"), { recursive: true });
      const paths = [];
      for (const name of ["a", "b", "c", "d", "e"]) {
        await fs.writeFile(path.join(cwd, ".smithers", "tickets", `${name}.md`), `# ${name}\n`);
        paths.push(`tickets/${name}.md`);
      }

      const result = await syncDocsFromDisk({ cwd, adapter, nowMs: () => 7, paths, maxPaths: 3 });

      expect(result).toEqual({ upserted: 3, tombstoned: 0, skipped: 0, dropped: 2 });
      expect(rows.map((row) => row.path)).toEqual(["tickets/a.md", "tickets/b.md", "tickets/c.md"]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("watcher rejects markdown outside doc roots and non-markdown inside them", () => {
    const settled = [];
    let trigger = (_path) => {};
    const watcher = createDocWatcher({
      cwd: "/wt",
      onSettle: (paths) => settled.push(paths),
      debounceMs: 0,
      watch(_cwd, onChange) {
        trigger = onChange;
        return { close() {} };
      },
      setTimeoutFn(fn) {
        fn();
        return 0;
      },
      clearTimeoutFn() {},
    });
    trigger(".smithers/other/x.md"); // not a doc root
    trigger(".smithers/tickets/readme.txt"); // not markdown
    trigger(".smithers/plans/p.md");
    watcher.close();
    expect(settled).toEqual([["plans/p.md"]]);
  });

  test("default fs.watch backend starts watching and close is idempotent", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "smithers-doc-fswatch-"));
    try {
      const watcher = createDocWatcher({ cwd, onSettle: () => {} });
      expect(watcher.watching).toBe(true);
      expect(watcher.droppedCount()).toBe(0);
      watcher.close();
      // A second close must be a no-op, not a crash on the closed handle.
      watcher.close();
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("disabled sync returns the inert noop handle", async () => {
    const disabled = await startDocFileSync({ enabled: false, cwd: "/wt", adapter: {} });
    expect(disabled.active).toBe(false);
    expect(await disabled.flush([])).toEqual({ upserted: 0, tombstoned: 0, skipped: 0, dropped: 0 });
    await disabled.stop();

    // An adapter without upsertDocRow is equally inert even when enabled.
    const noAdapter = await startDocFileSync({ enabled: true, cwd: "/wt", adapter: {} });
    expect(noAdapter.active).toBe(false);
  });

  test("watcher drops propagate through the sync wiring without crashing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "smithers-doc-drop-"));
    const adapter = { upsertDocRow: async () => {} };
    let captured;
    try {
      const sync = await startDocFileSync({
        enabled: true,
        cwd,
        adapter,
        syncOnStart: false,
        createWatcher(opts) {
          captured = opts;
          return { close() {}, flush() {}, watching: true };
        },
      });
      // The drop handler is the engine's structured-log emitter; a shed
      // path must be reportable without throwing.
      captured.onDrop({ path: "tickets/lost.md", droppedTotal: 1, pendingSize: 3 });
      await sync.stop();
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("watcher excludes worktree contents and VCS internals", () => {
    const settled = [];
    let trigger = (_path) => {};
    const watcher = createDocWatcher({
      cwd: "/wt",
      onSettle: (paths) => settled.push(paths),
      debounceMs: 0,
      watch(_cwd, onChange) {
        trigger = onChange;
        return { close() {} };
      },
      setTimeoutFn(fn) {
        fn();
        return 0;
      },
      clearTimeoutFn() {},
    });
    trigger("src/not-synced.md");
    trigger(".jj/repo/store.md");
    trigger(".smithers/tickets/demo.md");
    watcher.close();
    expect(settled).toEqual([["tickets/demo.md"]]);
  });
});
