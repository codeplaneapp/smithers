// Real `bun:sqlite` round-trip for the native persistence adapter. No mocks: a
// real on-disk SQLite file is written by one adapter instance, then reopened by
// a second instance to prove durable rehydration across a "reload", the
// DELETE-on-schemaVersion-mismatch clear, per-collection isolation, and reset.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBunSqlitePersistenceAdapter } from "../../src/bunSqlitePersistenceAdapter.ts";

const tmpDirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "smithers-persist-"));
  tmpDirs.push(dir);
  return join(dir, "client.sqlite");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createBunSqlitePersistenceAdapter (real bun:sqlite)", () => {
  test("rehydrates persisted rows across a reopen (warm start)", async () => {
    const path = tmpDbPath();
    const writer = await createBunSqlitePersistenceAdapter({ path });
    await writer.saveRows({
      collectionId: "runs",
      schemaVersion: "0016",
      rows: [
        { key: "s:run-1", row: { runId: "run-1", status: "running" } },
        { key: "s:run-2", row: { runId: "run-2", status: "ok" } },
      ],
    });
    writer.close?.();

    // A fresh adapter on the same file = the reload. The rows must already be
    // present before any live frame arrives.
    const reopened = await createBunSqlitePersistenceAdapter({ path });
    const rows = await reopened.loadRows("runs", "0016");
    expect(rows).toEqual([
      { key: "s:run-1", row: { runId: "run-1", status: "running" } },
      { key: "s:run-2", row: { runId: "run-2", status: "ok" } },
    ]);
    reopened.close?.();
  });

  test("schemaVersion bump clears the local copy and accepts fresh rows", async () => {
    const path = tmpDbPath();
    const before = await createBunSqlitePersistenceAdapter({ path });
    await before.saveRows({
      collectionId: "runs",
      schemaVersion: "0016",
      rows: [{ key: "s:old", row: { runId: "old" } }],
    });
    before.close?.();

    const after = await createBunSqlitePersistenceAdapter({ path });
    // Loading at a bumped version wipes the stale copy (cold re-sync lever).
    expect(await after.loadRows("runs", "0017")).toEqual([]);
    await after.saveRows({
      collectionId: "runs",
      schemaVersion: "0017",
      rows: [{ key: "s:new", row: { runId: "new" } }],
    });
    expect(await after.loadRows("runs", "0017")).toEqual([{ key: "s:new", row: { runId: "new" } }]);
    after.close?.();
  });

  test("keeps collections isolated and reset clears everything", async () => {
    const path = tmpDbPath();
    const adapter = await createBunSqlitePersistenceAdapter({ path });
    await adapter.saveRows({ collectionId: "runs", schemaVersion: "0016", rows: [{ key: "s:r", row: { runId: "r" } }] });
    await adapter.saveRows({ collectionId: "approvals", schemaVersion: "0016", rows: [{ key: "s:a", row: { id: "a" } }] });
    expect(await adapter.loadRows("runs", "0016")).toHaveLength(1);
    expect(await adapter.loadRows("approvals", "0016")).toHaveLength(1);

    await adapter.reset?.();
    expect(await adapter.loadRows("runs", "0016")).toEqual([]);
    expect(await adapter.loadRows("approvals", "0016")).toEqual([]);
    adapter.close?.();
  });
});
