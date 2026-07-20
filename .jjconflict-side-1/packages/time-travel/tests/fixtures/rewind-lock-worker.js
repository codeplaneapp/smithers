import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { acquireRewindLock } from "../../src/acquireRewindLock.js";

const [dbPath, runId, mode, rawTtlMs] = process.argv.slice(2);
const sqlite = new Database(dbPath);
const adapter = new SmithersDb(drizzle(sqlite));
const lease = await acquireRewindLock(adapter, runId, {
  leaseTtlMs: Number(rawTtlMs),
  autoRenew: false,
});

if (!lease) {
  process.stdout.write("Busy\n");
  sqlite.close();
  process.exit(0);
}

process.stdout.write("acquired\n");
if (mode === "crash") {
  sqlite.close();
  process.exit(0);
}
if (mode === "probe") {
  await lease.release();
  sqlite.close();
  process.exit(0);
}

await Bun.stdin.text();
await lease.release();
sqlite.close();
