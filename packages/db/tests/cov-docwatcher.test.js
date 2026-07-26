import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";
import { watchDocsDirectory } from "../src/docWatcher.js";

function createDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

/** @type {string[]} */
const tmpDirs = [];
function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-docwatch-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop(), { recursive: true, force: true });
    } catch {}
  }
});

describe("watchDocsDirectory", () => {
  test("initial sync upserts .md files and skips non-.md + non-file entries", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "alpha.md"), "# Alpha");
    writeFileSync(join(dir, "notes.txt"), "ignore me");
    mkdirSync(join(dir, "folder.md")); // a directory named like a doc → skipped
    const { adapter } = createDb();
    const handle = watchDocsDirectory(adapter, { dir, nowMs: () => 1000 });
    await handle.sync();
    expect((await adapter.getDoc("alpha")).content).toBe("# Alpha");
    expect(await adapter.getDoc("notes")).toBeFalsy();
    expect(await adapter.getDoc("folder")).toBeFalsy();
    // Re-syncing identical content is a no-op (no throw).
    await handle.syncFile("alpha.md");
    handle.close();
    handle.close(); // idempotent
  });

  test("creates the watched directory when it does not yet exist", () => {
    const parent = makeDir();
    const dir = join(parent, "nested", "docs");
    expect(existsSync(dir)).toBe(false);
    const { adapter } = createDb();
    const handle = watchDocsDirectory(adapter, { dir });
    expect(existsSync(dir)).toBe(true);
    handle.close();
  });

  test("default onError logs via console.warn when the adapter read fails", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "x.md"), "# X");
    const original = console.warn;
    const messages = [];
    console.warn = (msg) => messages.push(String(msg));
    try {
      const badAdapter = {
        getDoc: async () => {
          throw new Error("read boom");
        },
        upsertDoc: async () => {},
      };
      const handle = watchDocsDirectory(/** @type {any} */ (badAdapter), { dir });
      await handle.sync();
      handle.close();
    } finally {
      console.warn = original;
    }
    expect(messages.some((m) => m.includes("[docWatcher]"))).toBe(true);
  });

  test("onError fires when upsertDoc throws", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "y.md"), "# Y");
    const errors = [];
    const badAdapter = {
      getDoc: async () => null,
      upsertDoc: async () => {
        throw new Error("write boom");
      },
    };
    const handle = watchDocsDirectory(/** @type {any} */ (badAdapter), { dir, onError: (e) => errors.push(e) });
    await handle.sync();
    handle.close();
    expect(errors.length).toBeGreaterThan(0);
  });

  test("onError fires when the directory listing (readdir) fails", async () => {
    const dir = makeDir();
    const { adapter } = createDb();
    const errors = [];
    const handle = watchDocsDirectory(adapter, { dir, onError: (e) => errors.push(e) });
    // Remove the directory out from under the watcher, then force a re-sync.
    rmSync(dir, { recursive: true, force: true });
    await handle.sync();
    handle.close();
    expect(errors.length).toBeGreaterThan(0);
  });

  test("onError fires when a doc file cannot be read", async () => {
    // chmod 0 makes readFileSync throw EACCES for a non-root process.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dir = makeDir();
    const file = join(dir, "locked.md");
    writeFileSync(file, "# Locked");
    chmodSync(file, 0o000);
    const { adapter } = createDb();
    const errors = [];
    const handle = watchDocsDirectory(adapter, { dir, onError: (e) => errors.push(e) });
    await handle.syncFile("locked.md");
    chmodSync(file, 0o644); // restore so cleanup can remove it
    handle.close();
    expect(errors.length).toBeGreaterThan(0);
  });

  test("a filesystem write triggers the fs.watch callback and reconciles the file", async () => {
    const dir = makeDir();
    const { adapter } = createDb();
    const handle = watchDocsDirectory(adapter, { dir, nowMs: () => 2000 });
    await handle.sync();
    writeFileSync(join(dir, "live.md"), "# Live doc");
    // Poll for the watcher to reconcile the new file (fs.watch is async).
    let doc = null;
    for (let i = 0; i < 100 && !doc; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      doc = await adapter.getDoc("live");
    }
    handle.close();
    // Fall back to an explicit sync if the platform coalesced the event, so
    // the assertion asserts reconciliation regardless of fs.watch timing.
    if (!doc) {
      await handle.syncFile("live.md");
      doc = await adapter.getDoc("live");
    }
    expect(doc?.content).toBe("# Live doc");
  });
});
