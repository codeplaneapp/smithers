import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { it } from "vitest"
import { canExecute, workspaceFor } from "../src/history/Workspace.ts"

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-workspace-independent-"))
  mkdirSync(join(root, ".flows"))
  const engine = new DatabaseSync(join(root, ".flows", "engine.db"))
  engine.exec(`CREATE TABLE flows_runs(run_id TEXT PRIMARY KEY,parent_run_id TEXT);
    CREATE TABLE smthrs_history_workspaces(run_id TEXT PRIMARY KEY,workspace TEXT);
    CREATE TABLE flows_time_travel_edges(child_run_id TEXT,parent_run_id TEXT,kind TEXT);
    CREATE TABLE flows_time_travel_audits(id TEXT,run_id TEXT,status TEXT);
    INSERT INTO flows_runs VALUES('original',NULL),('fork','original'),('descendant','fork');
    INSERT INTO flows_time_travel_edges VALUES('fork','original','fork');`)
  const branch = join(root, "branch")
  engine.prepare("INSERT INTO smthrs_history_workspaces VALUES(?,?)").run("fork", branch)
  return {
    root,
    branch,
    engine,
    close() {
      engine.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
const controlFor = (root: string) => {
  const control = new DatabaseSync(join(root, ".flows", "control.db"))
  control.exec(
    `PRAGMA journal_mode=WAL;CREATE TABLE flows_runs(run_id TEXT PRIMARY KEY);CREATE TABLE smthrs_history_applied(audit_id TEXT PRIMARY KEY);`
  )
  return control
}

it("ordinary roots preserve no-database compatibility without creating storage", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-workspace-empty-"))
  try {
    assert.equal(workspaceFor(root, "new"), root)
    assert.equal(canExecute(root, root, "new"), true)
    assert.equal(canExecute(root, join(root, "wrong"), "new"), false)
    assert.equal(existsSync(join(root, ".flows")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("an inherited route observes committed control identity across a real WAL rollback and retry", () => {
  const f = fixture()
  const control = controlFor(f.root)
  try {
    // A descendant's control record is deliberately insufficient.
    control.prepare("INSERT INTO flows_runs VALUES(?)").run("descendant")
    for (const id of ["fork", "descendant"]) assert.equal(canExecute(f.root, f.branch, id), false)
    control.exec("BEGIN IMMEDIATE;INSERT INTO flows_runs VALUES('fork')")
    for (const id of ["fork", "descendant"]) assert.equal(canExecute(f.root, f.branch, id), false)
    control.exec("ROLLBACK")
    for (const id of ["fork", "descendant"]) assert.equal(canExecute(f.root, f.branch, id), false)
    control.exec("BEGIN IMMEDIATE;INSERT INTO flows_runs VALUES('fork');COMMIT")
    for (let i = 0; i < 3; i++) {
      for (const id of ["fork", "descendant"]) assert.equal(canExecute(f.root, f.branch, id), true)
    }
    assert.equal(canExecute(f.root, f.root, "descendant"), false)
  } finally {
    control.close()
    f.close()
  }
})

it("missing control storage closes bound routes while ordinary engine runs stay compatible", () => {
  const f = fixture()
  try {
    assert.equal(workspaceFor(f.root, "descendant"), f.branch)
    assert.equal(canExecute(f.root, f.branch, "fork"), false)
    assert.equal(canExecute(f.root, f.branch, "descendant"), false)
    assert.equal(canExecute(f.root, f.root, "original"), true)
    assert.equal(existsSync(join(f.root, ".flows", "control.db")), false)
  } finally {
    f.close()
  }
})

it("nested forks cannot inherit readiness through an unlinked or uncommitted nearer route", () => {
  const f = fixture()
  const control = controlFor(f.root)
  try {
    control.exec("INSERT INTO flows_runs VALUES('fork')")
    f.engine.exec(
      "INSERT INTO flows_runs VALUES('nested','descendant'),('leaf','nested');INSERT INTO flows_time_travel_edges VALUES('nested','descendant','fork')"
    )
    assert.equal(workspaceFor(f.root, "leaf"), undefined)
    assert.equal(canExecute(f.root, f.branch, "leaf"), false)
    const nested = join(f.root, "nested-branch")
    f.engine.prepare("INSERT INTO smthrs_history_workspaces VALUES(?,?)").run("nested", nested)
    assert.equal(workspaceFor(f.root, "leaf"), nested)
    assert.equal(canExecute(f.root, nested, "leaf"), false)
    control.exec("INSERT INTO flows_runs VALUES('nested')")
    assert.equal(canExecute(f.root, nested, "leaf"), true)
    assert.equal(canExecute(f.root, f.branch, "leaf"), false)
  } finally {
    control.close()
    f.close()
  }
})

it("the new identity guard preserves the complete per-run audit barrier without read-side writes", () => {
  const f = fixture()
  const control = controlFor(f.root)
  try {
    control.exec("INSERT INTO flows_runs VALUES('fork')")
    f.engine.exec("INSERT INTO flows_time_travel_audits VALUES('a','fork','in_progress'),('b','fork','completed')")
    assert.equal(canExecute(f.root, f.branch, "fork"), false)
    control.exec("INSERT INTO smthrs_history_applied VALUES('a')")
    assert.equal(canExecute(f.root, f.branch, "fork"), false)
    control.exec("INSERT INTO smthrs_history_applied VALUES('b')")
    assert.equal(canExecute(f.root, f.branch, "fork"), true)
    const paths = [
      join(f.root, ".flows", "engine.db"),
      join(f.root, ".flows", "control.db"),
      join(f.root, ".flows", "control.db-wal")
    ]
    const before = paths.map((p) => readFileSync(p))
    for (let i = 0; i < 3; i++) assert.equal(canExecute(f.root, f.branch, "fork"), true)
    paths.forEach((p, i) => assert.deepEqual(readFileSync(p), before[i]))
  } finally {
    control.close()
    f.close()
  }
})

it("corrupt ancestry fails closed and closes its database connection", () => {
  const f = fixture()
  try {
    f.engine.exec("INSERT INTO flows_runs VALUES('cycle-a','cycle-b'),('cycle-b','cycle-a')")
    assert.throws(() => canExecute(f.root, f.root, "cycle-a"), /Cyclic run ancestry/)
    f.engine.exec("BEGIN EXCLUSIVE;ROLLBACK")
  } finally {
    f.close()
  }
})
