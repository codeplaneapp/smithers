import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { materializeGatewayDocs } from "../../src/sync/materializeGatewayDocs.ts";

describe("materializeGatewayDocs", () => {
  test("writes docs rows to .smithers and removes tombstones", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "smithers-doc-materialize-"));
    try {
      const result = await materializeGatewayDocs({
        rootDir: cwd,
        fs,
        rows: [
          {
            path: "tickets/demo.md",
            kind: "ticket",
            content: "# Demo\n",
            contentHash: "hash-a",
            updatedAtMs: 1,
            deletedAtMs: null,
          },
        ],
      });
      expect(result).toEqual({ written: 1, deleted: 0, skipped: 0, unchanged: 0 });
      expect(await fs.readFile(path.join(cwd, ".smithers", "tickets", "demo.md"), "utf8")).toBe("# Demo\n");

      const deleted = await materializeGatewayDocs({
        rootDir: cwd,
        fs,
        rows: [
          {
            path: "tickets/demo.md",
            kind: "ticket",
            content: "",
            contentHash: "empty",
            updatedAtMs: 2,
            deletedAtMs: 2,
          },
        ],
      });
      expect(deleted).toEqual({ written: 0, deleted: 1, skipped: 0, unchanged: 0 });
      let missing = false;
      try {
        await fs.readFile(path.join(cwd, ".smithers", "tickets", "demo.md"), "utf8");
      } catch {
        missing = true;
      }
      expect(missing).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("skips unsafe paths instead of materializing worktree or VCS internals", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "smithers-doc-materialize-"));
    try {
      const result = await materializeGatewayDocs({
        rootDir: cwd,
        fs,
        rows: [
          { path: "../outside.md", kind: "ticket", content: "", contentHash: "x", updatedAtMs: 1, deletedAtMs: null },
          { path: ".jj/store.md", kind: "ticket", content: "", contentHash: "x", updatedAtMs: 1, deletedAtMs: null },
          { path: "src/worktree.md", kind: "ticket", content: "", contentHash: "x", updatedAtMs: 1, deletedAtMs: null },
        ],
      });
      expect(result).toEqual({ written: 0, deleted: 0, skipped: 3, unchanged: 0 });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("leaves a byte-identical file untouched and overwrites a divergent one", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "smithers-doc-materialize-"));
    try {
      const row = {
        path: "plans/sync.md",
        kind: "plan",
        content: "# Plan\n",
        contentHash: "hash-plan",
        updatedAtMs: 1,
        deletedAtMs: null,
      } as const;
      // First materialize writes the file.
      expect(await materializeGatewayDocs({ rootDir: cwd, fs, rows: [row] }))
        .toEqual({ written: 1, deleted: 0, skipped: 0, unchanged: 0 });

      // Re-materializing the identical row is a no-op (read + compare skips it).
      expect(await materializeGatewayDocs({ rootDir: cwd, fs, rows: [row] }))
        .toEqual({ written: 0, deleted: 0, skipped: 0, unchanged: 1 });

      // A divergent row overwrites disk (last-write-wins from the synced row).
      const next = { ...row, content: "# Plan v2\n", contentHash: "hash-plan-2", updatedAtMs: 2 };
      expect(await materializeGatewayDocs({ rootDir: cwd, fs, rows: [next] }))
        .toEqual({ written: 1, deleted: 0, skipped: 0, unchanged: 0 });
      expect(await fs.readFile(path.join(cwd, ".smithers", "plans", "sync.md"), "utf8")).toBe("# Plan v2\n");

      // A tombstone for an already-absent file is a no-op, not a phantom delete.
      const tombstone = { ...row, content: "", contentHash: "empty", updatedAtMs: 3, deletedAtMs: 3 };
      await fs.rm(path.join(cwd, ".smithers", "plans", "sync.md"));
      expect(await materializeGatewayDocs({ rootDir: cwd, fs, rows: [tombstone] }))
        .toEqual({ written: 0, deleted: 0, skipped: 0, unchanged: 1 });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
