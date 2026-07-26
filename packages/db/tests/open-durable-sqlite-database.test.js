import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDurableSqliteDatabase } from "../src/openDurableSqliteDatabase.js";

const paths = [];

afterEach(() => {
  for (const path of paths.splice(0)) {
    rmSync(path, { force: true });
    rmSync(`${path}-shm`, { force: true });
    rmSync(`${path}-wal`, { force: true });
  }
});

describe("openDurableSqliteDatabase", () => {
  test("opens a Drizzle connection with the durable sidecar pragmas", () => {
    const path = join(tmpdir(), `smithers-durable-${crypto.randomUUID()}.db`);
    paths.push(path);
    const opened = openDurableSqliteDatabase(path);
    try {
      expect(opened.db.$client.query("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      expect(opened.db.$client.query("PRAGMA busy_timeout").get()).toEqual({
        timeout: 30_000,
      });
      expect(opened.db.$client.query("PRAGMA synchronous").get()).toEqual({
        synchronous: 1,
      });
      expect(opened.db.$client.query("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
    } finally {
      opened.close();
    }
  });
});
