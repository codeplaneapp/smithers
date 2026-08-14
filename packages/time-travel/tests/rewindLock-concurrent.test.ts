import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smthrs/db/ensure";

const workerPath = join(import.meta.dir, "fixtures", "rewind-lock-worker.js");
const tempDirs: string[] = [];

function createDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-rewind-lock-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "smithers.db");
  const sqlite = new Database(dbPath, { create: true });
  ensureSmithersTables(drizzle(sqlite));
  sqlite.close();
  return dbPath;
}

function spawnWorker(dbPath: string, runId: string, mode = "release", ttlMs = 60_000) {
  return Bun.spawn([process.execPath, workerPath, dbPath, runId, mode, String(ttlMs)], {
    cwd: import.meta.dir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function readFirstChunk(process: ReturnType<typeof spawnWorker>) {
  const reader = process.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return new TextDecoder().decode(value).trim();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe("rewindLock cross-process contention", () => {
  test("second process receives Busy and release admits the next process", async () => {
    const dbPath = createDbPath();
    const first = spawnWorker(dbPath, "run-contention");
    expect(await readFirstChunk(first)).toBe("acquired");

    const second = spawnWorker(dbPath, "run-contention");
    expect(await new Response(second.stdout).text()).toBe("Busy\n");
    expect(await second.exited).toBe(0);

    first.stdin.write("release\n");
    first.stdin.end();
    expect(await first.exited).toBe(0);

    const third = spawnWorker(dbPath, "run-contention");
    expect(await readFirstChunk(third)).toBe("acquired");
    third.stdin.write("release\n");
    third.stdin.end();
    expect(await third.exited).toBe(0);
  }, 30_000);

  test("a crashed process lease is recoverable after expiry", async () => {
    const dbPath = createDbPath();
    const crashed = spawnWorker(dbPath, "run-crashed", "crash", 100);
    expect(await new Response(crashed.stdout).text()).toBe("acquired\n");
    expect(await crashed.exited).toBe(0);

    await Bun.sleep(120);
    const recovered = spawnWorker(dbPath, "run-crashed", "release", 100);
    expect(await readFirstChunk(recovered)).toBe("acquired");
    recovered.stdin.write("release\n");
    recovered.stdin.end();
    expect(await recovered.exited).toBe(0);
  }, 30_000);
});
