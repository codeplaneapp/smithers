/** @jsxImportSource smithers */
import { smithers, Workflow, Task, Sequence } from "../../src/index";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const input = sqliteTable("input", {
  runId: text("run_id").primaryKey(),
  description: text("description"),
});

const outputA = sqliteTable(
  "output_a",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    value: integer("value"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
  }),
);

const outputB = sqliteTable(
  "output_b",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    value: integer("value"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
  }),
);

const schema = { input, outputA, outputB };
const tmpPath = join(
  mkdtempSync(join(tmpdir(), "smithers-approval-")),
  "db.sqlite",
);
const sqlite = new Database(tmpPath);
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS input (run_id TEXT PRIMARY KEY, description TEXT);
  CREATE TABLE IF NOT EXISTS output_a (run_id TEXT NOT NULL, node_id TEXT NOT NULL, iteration INTEGER NOT NULL DEFAULT 0, value INTEGER, PRIMARY KEY (run_id, node_id, iteration));
  CREATE TABLE IF NOT EXISTS output_b (run_id TEXT NOT NULL, node_id TEXT NOT NULL, iteration INTEGER NOT NULL DEFAULT 0, value INTEGER, PRIMARY KEY (run_id, node_id, iteration));
`);
const db = drizzle(sqlite, { schema });

export default smithers(db, (_ctx) => (
  <Workflow name="approval-workflow">
    <Sequence>
      <Task id="gate" output={outputA} needsApproval>
        {{ value: 1 }}
      </Task>
      <Task id="after" output={outputB}>
        {{ value: 2 }}
      </Task>
    </Sequence>
  </Workflow>
));
