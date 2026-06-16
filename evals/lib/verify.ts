// Deterministic verification — the hard gate, run with zero model spend wherever
// possible. A fluency eval's verify <Task> calls computeVerdict() from an
// agentless compute child; only `judge` verification spends a model.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./paths.js";
import type { CandidateReport, EvalVerdict } from "./report-schema.js";

export type VerifyKind = "contains" | "equals" | "graph" | "sql" | "judge";

export type VerifySpec = {
  kind: VerifyKind;
  /** substrings the artifact MUST contain (contains/graph) */
  must: string[];
  /** substrings the artifact must NOT contain (a hallucinated API, a wrong component) */
  mustNot: string[];
  /** canonical answer for `equals` (CLI verb / component / short answer) */
  answer: string | null;
  /** rubric for `judge` */
  rubric: string | null;
  /** query for `sql` */
  sql: string | null;
  /** expected stringified rows for `sql` */
  expect: string | null;
  /** sqlite db path for `sql` (a seeded fixture) */
  db: string | null;
};

/** Input arrives as raw value or null (never the zod default) — coalesce hard. */
export function normalizeVerify(raw: unknown): VerifySpec {
  const v = (raw ?? {}) as Partial<VerifySpec>;
  return {
    kind: (v.kind ?? "contains") as VerifyKind,
    must: Array.isArray(v.must) ? v.must : [],
    mustNot: Array.isArray(v.mustNot) ? v.mustNot : [],
    answer: v.answer ?? null,
    rubric: v.rubric ?? null,
    sql: v.sql ?? null,
    expect: v.expect ?? null,
    db: v.db ?? null,
  };
}

/** Normalize a CLI-ish answer so `smithers ps`, `bunx smithers-orchestrator ps`,
 * and "`ps`" all compare equal. */
export function normalizeCliAnswer(s: string): string {
  return s
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/^\s*(bunx\s+)?smithers(-orchestrator)?\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreFromChecks(checks: EvalVerdict["checks"]): number {
  if (checks.length === 0) return 0;
  return checks.filter((c) => c.passed).length / checks.length;
}

function containsVerify(artifact: string, v: VerifySpec): EvalVerdict {
  const checks: EvalVerdict["checks"] = [];
  for (const m of v.must) {
    checks.push({ name: `must:${m}`, passed: artifact.includes(m), detail: m });
  }
  for (const m of v.mustNot) {
    checks.push({ name: `mustNot:${m}`, passed: !artifact.includes(m), detail: m });
  }
  const passed = checks.every((c) => c.passed) && checks.length > 0;
  return {
    passed,
    score: scoreFromChecks(checks),
    reason: passed
      ? `artifact contains all ${v.must.length} required token(s)`
      : `missing/forbidden tokens: ${checks.filter((c) => !c.passed).map((c) => c.name).join(", ")}`,
    method: "contains",
    checks,
  };
}

function equalsVerify(artifact: string, v: VerifySpec): EvalVerdict {
  const want = normalizeCliAnswer(v.answer ?? "");
  const got = normalizeCliAnswer(artifact);
  // accept the canonical answer appearing anywhere in a normalized answer line
  const passed = got === want || got.split("\n").some((line) => line.trim() === want) || got.includes(want);
  return {
    passed,
    score: passed ? 1 : 0,
    reason: passed ? `answer matches "${v.answer}"` : `expected "${v.answer}", got "${artifact.slice(0, 120)}"`,
    method: "equals",
    checks: [{ name: "equals", passed, detail: v.answer ?? "" }],
  };
}

/** Render the candidate's workflow with `smithers graph` (no execution). A clean
 * render proves it is a valid, wireable workflow; the must/mustNot tokens prove
 * it used the right components. */
function graphVerify(artifact: string, v: VerifySpec): EvalVerdict {
  const root = repoRoot();
  const tmpBase = join(root, ".smithers", "state");
  let dir: string | null = null;
  let graphStatus: number | null = null;
  let graphOut = "";
  try {
    dir = mkdtempSync(join(tmpBase, "eval-graph-"));
    const file = join(dir, "candidate.tsx");
    writeFileSync(file, artifact, "utf8");
    const cliEntry = join(root, "apps/cli/src/index.js");
    const res = spawnSync("bun", [cliEntry, "graph", file], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
    });
    graphStatus = res.status;
    graphOut = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
  } catch (err) {
    graphOut = err instanceof Error ? err.message : String(err);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  const checks: EvalVerdict["checks"] = [
    {
      name: "graph-renders",
      passed: graphStatus === 0,
      detail: graphStatus === 0 ? "rendered" : `exit ${graphStatus}: ${graphOut.slice(0, 300)}`,
    },
    ...v.must.map((m) => ({ name: `must:${m}`, passed: artifact.includes(m), detail: m })),
    ...v.mustNot.map((m) => ({ name: `mustNot:${m}`, passed: !artifact.includes(m), detail: m })),
  ];
  const passed = checks.every((c) => c.passed);
  return {
    passed,
    score: scoreFromChecks(checks),
    reason: passed
      ? "workflow renders and uses the required components"
      : `failed: ${checks.filter((c) => !c.passed).map((c) => c.name).join(", ")}`,
    method: "graph",
    checks,
  };
}

async function sqlVerify(v: VerifySpec): Promise<EvalVerdict> {
  if (!v.db || !v.sql) {
    return {
      passed: false,
      score: 0,
      reason: "sql verify requires a seeded fixture db + query (not provided)",
      method: "sql",
      checks: [{ name: "fixture", passed: false, detail: "missing db/sql" }],
    };
  }
  // Lazy import so non-sql verifies never touch bun:sqlite.
  const { Database } = await import("bun:sqlite");
  let rows: unknown[] = [];
  try {
    const db = new Database(v.db, { readonly: true });
    rows = db.query(v.sql).all();
    db.close();
  } catch (err) {
    return {
      passed: false,
      score: 0,
      reason: `query failed: ${err instanceof Error ? err.message : String(err)}`,
      method: "sql",
      checks: [{ name: "query", passed: false, detail: String(err) }],
    };
  }
  const got = JSON.stringify(rows);
  const want = (v.expect ?? "").trim();
  // `expect` may be the exact stringified rows, or a substring that must appear.
  const passed = got === want || (want.length > 0 && got.includes(want));
  return {
    passed,
    score: passed ? 1 : 0,
    reason: passed ? "query result matches expectation" : `expected ${want}, got ${got.slice(0, 200)}`,
    method: "sql",
    checks: [{ name: "result", passed, detail: got.slice(0, 200) }],
  };
}

/** Deterministic verdict for every non-judge verify kind. */
export async function computeVerdict(
  verify: VerifySpec,
  report: CandidateReport,
): Promise<EvalVerdict> {
  const artifact = report?.artifact ?? "";
  switch (verify.kind) {
    case "equals":
      return equalsVerify(artifact, verify);
    case "graph":
      return graphVerify(artifact, verify);
    case "sql":
      return await sqlVerify(verify);
    case "contains":
    default:
      return containsVerify(artifact, verify);
  }
}
