// Regression tests for the deterministic eval verifier's pass/fail gate.
//
// Bug (H20/M34): the `query`/`sql` verifiers decided pass with a raw
// `got.includes(want)` against the JSON-stringified rows. A scalar expectation
// then substring-matched a larger result — expect "4" passed for a count of
// 14/40/41, and expect "implement" passed for "implementation" — so wrong SQL
// was scored as correct, silently corrupting the scorecard. These exercise the
// fix end-to-end against a real bun:sqlite fixture (no mocks).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { computeVerdict, type VerifySpec } from "./verify.ts";
import type { CandidateReport } from "./report-schema.ts";

function spec(over: Partial<VerifySpec>): VerifySpec {
  return { kind: "query", must: [], mustNot: [], answer: null, rubric: null, sql: null, expect: null, db: null, required: [], ...over };
}

function report(sql: string): CandidateReport {
  return { artifact: sql } as unknown as CandidateReport;
}

describe("query verifier whole-cell matching", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function seedDb(create: string, insert: string): string {
    const dir = mkdtempSync(join(tmpdir(), "verify-"));
    dirs.push(dir);
    const path = join(dir, "fixture.db");
    const db = new Database(path);
    db.run(create);
    db.run(insert);
    db.close();
    return path;
  }

  test("a scalar number expect does NOT substring-match a larger number", async () => {
    const db = seedDb("CREATE TABLE runs (id INTEGER)", "INSERT INTO runs (id) VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14)");
    const v = spec({ kind: "query", db, expect: "4" });
    // Wrong SQL returns 14 — which CONTAINS "4". Must NOT pass.
    const wrong = await computeVerdict(v, report("SELECT count(*) AS c FROM runs"));
    expect(wrong.passed).toBe(false);
    // Correct SQL returns 4 — must pass (via the single-cell normalizer).
    const right = await computeVerdict(v, report("SELECT count(*) AS c FROM runs WHERE id <= 4"));
    expect(right.passed).toBe(true);
  });

  test("a scalar token expect does NOT substring-match a longer value", async () => {
    const db = seedDb("CREATE TABLE w (name TEXT)", "INSERT INTO w (name) VALUES ('implementation')");
    const v = spec({ kind: "query", db, expect: "implement" });
    const verdict = await computeVerdict(v, report("SELECT name FROM w LIMIT 1"));
    expect(verdict.passed).toBe(false);
  });

  test("column aliasing still matches via the single-cell normalizer", async () => {
    const db = seedDb("CREATE TABLE runs (id INTEGER)", "INSERT INTO runs (id) VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14)");
    const v = spec({ kind: "query", db, expect: "14" });
    const verdict = await computeVerdict(v, report("SELECT count(*) AS total FROM runs"));
    expect(verdict.passed).toBe(true);
  });
});

describe("must/mustNot JSX-tag tokens tolerate the createSmithers factory namespace", () => {
  function containsSpec(over: Partial<VerifySpec>): VerifySpec {
    return { kind: "contains", must: [], mustNot: [], answer: null, rubric: null, sql: null, expect: null, db: null, required: [], ...over };
  }

  // Bug: `must: ["<Task"]` false-failed the documented createSmithers factory
  // form `<parent.Task>` because it was checked with a raw `artifact.includes`.
  // Both `<Task>` (bare import) and `<parent.Task>` (factory member access) are
  // valid, idiomatic ways to reference a component (docs/components/subflow.mdx).
  test("a bare component `must` token matches `<parent.Component>` factory JSX", async () => {
    const v = containsSpec({ must: ["<Workflow", "<Sequence", "<Subflow", "<Task"] });
    const artifact = `
      const parent = createSmithers();
      export default (
        <parent.Workflow>
          <parent.Sequence>
            <parent.Subflow child={child} />
            <parent.Task name="a" run={() => {}} />
          </parent.Sequence>
        </parent.Workflow>
      );
    `;
    const verdict = await computeVerdict(v, report(artifact));
    expect(verdict.passed).toBe(true);
  });

  test("a bare component `must` token still matches a plain bare-imported tag", async () => {
    const v = containsSpec({ must: ["<Task"] });
    const verdict = await computeVerdict(v, report("<Task name=\"a\" run={() => {}} />"));
    expect(verdict.passed).toBe(true);
  });

  test("a bare component `must` token does not false-match a substring of another name", async () => {
    const v = containsSpec({ must: ["<Task"] });
    const verdict = await computeVerdict(v, report("<TaskGroup name=\"a\" />"));
    expect(verdict.passed).toBe(false);
  });
});
