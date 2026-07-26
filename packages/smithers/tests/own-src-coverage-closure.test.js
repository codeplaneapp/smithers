import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createSmithers, createSmithersPostgres } from "../src/create.js";
import { migrateSmithersStore } from "../src/migrateSmithersStore.js";

setDefaultTimeout(60_000);

/** @type {string[]} */
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function makeDbPath(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return join(dir, "smithers.db");
}

describe("createSmithers Sandbox default workflow", () => {
  test("the default workflow's build() renders a sandbox-named Workflow element", () => {
    // When <Sandbox> is used without an explicit `workflow` prop, createSmithers
    // injects a default workflow object whose `build()` renders a Workflow named
    // `sandbox:<id>` wrapping the sandbox children. Invoking that build closure
    // exercises the arrow that only runs when the sandbox actually renders.
    const api = createSmithers(
      { result: z.object({ v: z.string() }) },
      { dbPath: makeDbPath("smithers-sandbox-build-") },
    );
    try {
      const sandbox = api.Sandbox({ id: "box", children: "sandbox-child" });
      const workflow = sandbox.props.workflow;
      expect(typeof workflow.build).toBe("function");
      const element = workflow.build();
      expect(element.props.name).toBe("sandbox:box");
      expect(element.props.children).toBe("sandbox-child");
    } finally {
      api.db?.$client?.close?.();
    }
  });
});

// PGlite's socket server desyncs node-postgres on Windows CI; the real Postgres
// path is covered by the dedicated test-postgres job (see createSmithersPostgres.test.js).
describe.skipIf(process.platform === "win32")("createSmithersPostgres BIGINT type parser", () => {
  test("reads a BIGINT column back as a JS number (exercises the pg type-20 parser)", async () => {
    // createSmithersPostgres registers a pg type parser mapping BIGINT (oid 20)
    // to a JS number so ms timestamps/counters match SQLite. Reading a real
    // BIGINT value back invokes that parser callback with a non-null value.
    const api = await createSmithersPostgres({ result: z.object({ n: z.number() }) }, { provider: "pglite" });
    try {
      await api.db.connection.query({ text: 'CREATE TABLE "bigt" (id BIGINT)' });
      await api.db.connection.query({ text: 'INSERT INTO "bigt" (id) VALUES (9007199254740000)' });
      const { rows } = await api.db.connection.query({ text: 'SELECT id FROM "bigt"' });
      expect(typeof rows[0].id).toBe("number");
      expect(rows[0].id).toBe(9007199254740000);
    } finally {
      await api.close();
    }
  });
});

describe("migrateSmithersStore source-open failures", () => {
  test("an unopenable SQLite source surfaces an actionable DB_QUERY_FAILED", async () => {
    // A directory sitting at the source dbPath makes bun:sqlite fail to open the
    // file ("unable to open database file"). The migration must replace that raw
    // engine text with the actionable "Could not open the legacy SQLite store"
    // guidance (upgradeSqliteSourceStore's unopenable-source branch), not leak it.
    const ws = mkdtempSync(join(tmpdir(), "smithers-migrate-unopenable-"));
    dirs.push(ws);
    mkdirSync(join(ws, ".smithers"), { recursive: true });
    mkdirSync(join(ws, "smithers.db"), { recursive: true });
    await expect(migrateSmithersStore({ cwd: ws, from: "sqlite", to: "pglite", env: {} })).rejects.toMatchObject({
      code: "DB_QUERY_FAILED",
    });
  });
});
