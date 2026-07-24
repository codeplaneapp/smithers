// Deterministic verification — the hard gate, run with zero model spend wherever
// possible. A fluency eval's verify <Task> calls computeVerdict() from an
// agentless compute child; only `judge` verification spends a model.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { build } from "esbuild";
import { gradeSideEffectCompliance } from "@smithers/scorers";
import { repoRoot } from "./paths.js";
import type { CandidateReport, EvalVerdict } from "./report-schema.js";

export type VerifyKind = "contains" | "equals" | "graph" | "sql" | "query" | "build" | "ui-functional" | "side-effect-marking" | "judge";

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
  /** required functional checks for `ui-functional` (empty = the full set) */
  required: string[];
  /** require stable key threading for `side-effect-marking` */
  requireIdempotencyKey: boolean;
  /** require a verify-then-undo tool handler for `side-effect-marking` */
  requireRevert: boolean;
  /** candidate repository root used for absolute-path write classification */
  repoRoot: string | null;
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
    required: Array.isArray(v.required) ? v.required : [],
    requireIdempotencyKey: v.requireIdempotencyKey ?? false,
    requireRevert: v.requireRevert ?? false,
    repoRoot: v.repoRoot ?? null,
  };
}

/** Normalize a short CLI/component answer so `smithers ps`,
 * `bunx smithers-orchestrator ps`, "`ps`" all compare equal, and a JSX component
 * answer `<Parallel>` / `</Task>` compares equal to its bare name `Parallel`. */
export function normalizeCliAnswer(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`<>/]/g, "") // code ticks + JSX angle brackets + closing-tag slash
    .replace(/^\s*(bunx\s+)?smithers(-orchestrator)?\s+/g, "")
    .replace(/[.,;:]+$/g, "") // trailing punctuation
    .replace(/\s+/g, " ")
    .trim();
}

function scoreFromChecks(checks: EvalVerdict["checks"]): number {
  if (checks.length === 0) return 0;
  return checks.filter((c) => c.passed).length / checks.length;
}

function sideEffectMarkingVerify(artifact: string, v: VerifySpec): EvalVerdict {
  const report = gradeSideEffectCompliance(artifact, {
    requireIdempotencyKey: v.requireIdempotencyKey,
    requireRevert: v.requireRevert,
    ...(v.repoRoot ? { repoRoot: v.repoRoot } : {}),
  });
  const checks: EvalVerdict["checks"] = report.violations.length > 0
    ? report.violations.map((violation, index) => ({
        name: `${violation.kind}:${index + 1}`,
        passed: false,
        detail: violation.detail,
      }))
    : [{ name: "side-effect-compliance", passed: true, detail: "all detected external mutations are marked" }];
  return {
    passed: report.passed,
    score: report.score,
    reason: report.passed
      ? "side-effect markings satisfy the deterministic analyzer"
      : report.violations.map((violation) => `[${violation.kind}] ${violation.detail}`).join(" "),
    method: "side-effect-marking",
    checks,
  };
}

/** Match a `must`/`mustNot` token against the artifact. A JSX opening-tag token
 * like "<Task" must also match the createSmithers factory-namespace form
 * `<parent.Task` — both `<Task>` (bare import) and `<parent.Task>` (factory
 * member access) are documented, idiomatic ways to reference a component (see
 * docs/components/subflow.mdx), so a plain substring check unfairly fails the
 * factory-namespace form. */
function matchesToken(artifact: string, token: string): boolean {
  const jsxTag = /^<([A-Za-z_$][\w$]*)$/.exec(token);
  if (jsxTag) {
    return new RegExp(`<(?:[A-Za-z_$][\\w$]*\\.)?${jsxTag[1]}\\b`).test(artifact);
  }
  return artifact.includes(token);
}

function containsVerify(artifact: string, v: VerifySpec): EvalVerdict {
  const checks: EvalVerdict["checks"] = [];
  for (const m of v.must) {
    checks.push({ name: `must:${m}`, passed: matchesToken(artifact, m), detail: m });
  }
  for (const m of v.mustNot) {
    checks.push({ name: `mustNot:${m}`, passed: !matchesToken(artifact, m), detail: m });
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function equalsVerify(artifact: string, v: VerifySpec): EvalVerdict {
  const want = normalizeCliAnswer(v.answer ?? "");
  const got = normalizeCliAnswer(artifact);
  // Exact, exact-per-line, or a whole-word match — NOT a loose substring, so the
  // canonical answer "up" does not falsely match a candidate that said "update".
  const wordMatch = want.length > 0 && new RegExp(`(^|\\s)${escapeRegex(want)}($|\\s)`).test(got);
  const passed = got === want || got.split("\n").some((line) => line.trim() === want) || wordMatch;
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
    // .smithers/state is gitignored and may not exist on a fresh checkout —
    // create it so the very first graph-verify doesn't ENOENT.
    mkdirSync(tmpBase, { recursive: true });
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
    ...v.must.map((m) => ({ name: `must:${m}`, passed: matchesToken(artifact, m), detail: m })),
    ...v.mustNot.map((m) => ({ name: `mustNot:${m}`, passed: !matchesToken(artifact, m), detail: m })),
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
  const passed = resultMatchesExpect(got, want);
  return {
    passed,
    score: passed ? 1 : 0,
    reason: passed ? "query result matches expectation" : `expected ${want}, got ${got.slice(0, 200)}`,
    method: "sql",
    checks: [{ name: "result", passed, detail: got.slice(0, 200) }],
  };
}

/** Run the CANDIDATE's SQL (its artifact) against a seeded fixture db and compare
 * the result to the known answer. This is the db-query eval: did the weak model
 * write SQL that answers the question? */
async function queryVerify(artifact: string, v: VerifySpec): Promise<EvalVerdict> {
  if (!v.db) {
    return { passed: false, score: 0, reason: "query verify needs a fixture db", method: "query", checks: [{ name: "fixture", passed: false, detail: "missing db" }] };
  }
  // Strip code fences / leading prose so a candidate's ```sql block still runs.
  const sql = artifact.replace(/```sql/gi, "").replace(/```/g, "").trim();
  const { Database } = await import("bun:sqlite");
  let rows: unknown[] = [];
  try {
    const db = new Database(v.db, { readonly: true });
    rows = db.query(sql).all();
    db.close();
  } catch (err) {
    return { passed: false, score: 0, reason: `candidate SQL failed: ${err instanceof Error ? err.message : String(err)}`, method: "query", checks: [{ name: "runs", passed: false, detail: sql.slice(0, 120) }] };
  }
  const got = JSON.stringify(rows);
  const want = (v.expect ?? "").trim();
  const passed = resultMatchesExpect(got, want);
  return {
    passed,
    score: passed ? 1 : 0,
    reason: passed ? "candidate query returns the expected answer" : `expected ${want}, got ${got.slice(0, 200)}`,
    method: "query",
    checks: [{ name: "result", passed, detail: got.slice(0, 200) }],
  };
}

/** Decide whether a stringified SQL result `got` satisfies the expected `want`.
 *
 * A scalar/token expectation must match a WHOLE cell value — exact, or via the
 * single-cell normalizer ([{"count":4}] → "4") — and is NEVER substring-matched.
 * Substring matching (a fragment that must appear) is allowed ONLY for genuinely
 * structural expectations (containing JSON punctuation). Without this guard a raw
 * `got.includes(want)` false-passes: expect "4" matched a result of 14/40/41, and
 * expect "implement" matched "implementation". */
function resultMatchesExpect(got: string, want: string): boolean {
  if (want.length === 0) return got === want;
  if (got === want) return true;
  if (normalizeScalar(got) === normalizeScalar(want)) return true;
  const wantLooksScalar = /^-?\d+(\.\d+)?$/.test(want) || /^[A-Za-z0-9_-]+$/.test(want);
  return !wantLooksScalar && got.includes(want);
}

/** Reduce a single-row/single-value result to its scalar so column aliases don't
 * matter: [{"n":3}] and [{"count":3}] both → "3". */
function normalizeScalar(json: string): string {
  try {
    const v = JSON.parse(json);
    if (Array.isArray(v) && v.length === 1 && v[0] && typeof v[0] === "object") {
      const vals = Object.values(v[0] as Record<string, unknown>);
      if (vals.length === 1) return String(vals[0]);
    }
  } catch {
    /* not json */
  }
  return json.trim();
}

type ImportBinding = { imported: string; local: string; module: string; namespace: boolean };

// The UI deliverables are not required to pass the repository's full strict
// typecheck (they are authored snippets), but these diagnostics are essential
// to the build gate: they prove imports resolve, exports exist, and type-only
// or nonexistent namespace bindings are not being used as runtime UI values.
const STRUCTURAL_DIAGNOSTIC_CODES = new Set([1361, 2305, 2307, 2339, 2614, 2694]);

function importedBindings(source: ts.SourceFile): ImportBinding[] {
  const result: ImportBinding[] = [];
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const module = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (!clause) continue;
    if (clause.name) result.push({ imported: "default", local: clause.name.text, module, namespace: false });
    const named = clause.namedBindings;
    if (!named) continue;
    if (ts.isNamespaceImport(named)) result.push({ imported: "*", local: named.name.text, module, namespace: true });
    else for (const element of named.elements) result.push({ imported: element.propertyName?.text ?? element.name.text, local: element.name.text, module, namespace: false });
  }
  return result;
}

function isImportedModule(bindings: ImportBinding[], token: string): boolean {
  return bindings.some((b) => b.module === token || b.module.endsWith(`/${token}`));
}

function hasPropertyAccess(source: ts.SourceFile, property: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === property) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function hasDottedAccess(source: ts.SourceFile, expression: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.getText(source) === expression) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function hasCallOrJsxUse(source: ts.SourceFile, bindings: ImportBinding[], name: string, jsxOnly = false): boolean {
  const relevant = bindings.filter((b) => b.imported === name || b.namespace);
  if (relevant.length === 0) return false;
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningLikeElement(node)) {
      const tag = node.tagName;
      if (relevant.some((b) => (b.namespace && tag.getText() === `${b.local}.${name}`) || (!b.namespace && tag.getText() === b.local))) found = true;
    }
    if (!jsxOnly && ts.isCallExpression(node)) {
      const callee = node.expression;
      if (relevant.some((b) => (b.namespace && ts.isPropertyAccessExpression(callee) && callee.expression.getText() === b.local && callee.name.text === name) || (!b.namespace && callee.getText() === b.local))) found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function hasJsxTag(source: ts.SourceFile, token: string): boolean {
  const name = token.slice(1).split(/[.\s]/, 1)[0];
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningLikeElement(node) && node.tagName.getText().split(".").pop() === name) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function structuralRequirement(source: ts.SourceFile, bindings: ImportBinding[], token: string): boolean {
  if (token.startsWith("<")) return hasJsxTag(source, token);
  if (token.includes("/") || token.startsWith("@")) return isImportedModule(bindings, token);
  if (token.startsWith(".") && token.length > 1) return hasPropertyAccess(source, token.slice(1));
  if (token.includes(".")) return hasDottedAccess(source, token);
  const imported = bindings.find((b) => b.imported === token);
  const isGatewayCall = /^(createGateway|useGateway)/.test(token);
  return imported || bindings.some((b) => b.namespace) ? hasCallOrJsxUse(source, bindings, token, !isGatewayCall) : false;
}

function forbiddenStructure(source: ts.SourceFile, bindings: ImportBinding[], token: string): boolean {
  if (token.startsWith("<")) return !hasJsxTag(source, token);
  if (token.startsWith(".") && token.length > 1) return !hasPropertyAccess(source, token.slice(1));
  if (token.includes(".")) return !hasDottedAccess(source, token);
  const callName = token.endsWith("(") ? token.slice(0, -1) : token;
  if (token.endsWith("(") && bindings.some((b) => b.imported === callName)) return !hasCallOrJsxUse(source, bindings, callName);
  return !structuralRequirement(source, bindings, token);
}

/** Bundle against the real workspace, then require imported APIs/components to be used structurally. */
async function buildVerify(artifact: string, v: VerifySpec): Promise<EvalVerdict> {
  const checks: EvalVerdict["checks"] = [];
  const root = repoRoot();
  const tmpBase = join(root, ".smithers", "state");
  let dir: string | null = null;
  let source: ts.SourceFile | null = null;
  let typeDiagnostics: readonly ts.Diagnostic[] = [];
  try {
    if (!artifact.trim()) throw new Error("empty artifact");
    mkdirSync(tmpBase, { recursive: true });
    dir = mkdtempSync(join(tmpBase, "eval-build-"));
    const file = join(dir, "candidate.tsx");
    writeFileSync(file, artifact, "utf8");
    await build({ absWorkingDir: root, entryPoints: [file], bundle: true, write: false, platform: "browser", format: "esm", logLevel: "silent" });
    checks.push({ name: "bundles", passed: true, detail: "resolved workspace modules and exports" });
    source = ts.createSourceFile(file, artifact, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const parseErrors = (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    checks.push({ name: "parses", passed: parseErrors.length === 0, detail: parseErrors[0]?.messageText?.toString() ?? "valid TSX" });
    if (parseErrors.length === 0) {
      const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
      const program = ts.createProgram([file], { ...parsed.options, noEmit: true }, undefined);
      typeDiagnostics = ts
        .getPreEmitDiagnostics(program, program.getSourceFile(file))
        .filter((diagnostic) => STRUCTURAL_DIAGNOSTIC_CODES.has(diagnostic.code));
    }
    checks.push({
      name: "typechecks",
      passed: typeDiagnostics.length === 0,
      detail: typeDiagnostics.length === 0 ? "imports and exports are valid" : ts.flattenDiagnosticMessageText(typeDiagnostics[0].messageText, " ").slice(0, 300),
    });
  } catch (err) {
    checks.push({ name: "bundles", passed: false, detail: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) });
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  if (source) {
    const bindings = importedBindings(source);
    for (const token of v.must) checks.push({ name: `must:${token}`, passed: structuralRequirement(source, bindings, token), detail: "imported and structurally used" });
    for (const token of v.mustNot) checks.push({ name: `mustNot:${token}`, passed: forbiddenStructure(source, bindings, token), detail: "forbidden structure absent" });
  } else {
    for (const token of [...v.must, ...v.mustNot]) checks.push({ name: `${v.must.includes(token) ? "must" : "mustNot"}:${token}`, passed: false, detail: "artifact did not parse/build" });
  }
  const passed = checks.length > 0 && checks.every((c) => c.passed);
  return { passed, score: scoreFromChecks(checks), reason: passed ? "bundle resolves and uses required UI structures" : `failed: ${checks.filter((c) => !c.passed).map((c) => c.name).join(", ")}`, method: "build", checks };
}

/** The DEFAULT_UI_CHECKS full functional set, in display order. */
const DEFAULT_UI_CHECKS = ["mounts", "status", "events", "output", "error", "approval", "approvalLive"];

/** Drive the candidate UI in a real browser against the fixture run (the
 * ui-functional verifier). Shells out to ui-functional-runner.ts, which boots a
 * Gateway + headless Chromium and asserts observed behavior. Zero model spend;
 * this is the hard functional gate that pairs with the ui-quality judge. */
function functionalVerify(artifact: string, v: VerifySpec): EvalVerdict {
  const root = repoRoot();
  const tmpBase = join(root, ".smithers", "state");
  let dir: string | null = null;
  let raw: string | null = null;
  let crashDetail = "";
  try {
    mkdirSync(tmpBase, { recursive: true });
    dir = mkdtempSync(join(tmpBase, "eval-uifn-"));
    const artifactFile = join(dir, "candidate.tsx");
    const outFile = join(dir, "verdict.json");
    writeFileSync(artifactFile, artifact, "utf8");
    const runner = join(root, "evals/lib/ui-functional-runner.ts");
    const required = v.required.length ? v.required : DEFAULT_UI_CHECKS;
    const res = spawnSync(
      "bun",
      [runner, "--artifact", artifactFile, "--out", outFile, "--required", required.join(",")],
      { cwd: root, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
    );
    try {
      raw = readFileSync(outFile, "utf8");
    } catch {
      crashDetail = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim().slice(-500);
    }
  } catch (err) {
    crashDetail = err instanceof Error ? err.message : String(err);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  if (!raw) {
    return {
      passed: false,
      score: 0,
      reason: `ui-functional runner produced no verdict: ${crashDetail.slice(0, 300)}`,
      method: "ui-functional",
      checks: [{ name: "runner", passed: false, detail: crashDetail.slice(0, 300) }],
      renderedText: "",
      features: {},
    };
  }
  let parsed: {
    passed?: boolean;
    score?: number;
    reason?: string;
    checks?: Array<{ name: string; passed: boolean; detail?: string }>;
    renderedText?: string;
    features?: Record<string, boolean>;
    infraError?: string | null;
  };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      passed: false,
      score: 0,
      reason: `ui-functional verdict was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      method: "ui-functional",
      checks: [],
      renderedText: "",
      features: {},
    };
  }
  return {
    passed: Boolean(parsed.passed),
    score: typeof parsed.score === "number" ? parsed.score : 0,
    reason: parsed.reason ?? "ui-functional verified",
    method: "ui-functional",
    checks: (parsed.checks ?? []).map((c) => ({ name: c.name, passed: c.passed, detail: c.detail ?? "" })),
    renderedText: parsed.renderedText ?? "",
    features: parsed.features ?? {},
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
    case "query":
      return await queryVerify(artifact, verify);
    case "build":
      return await buildVerify(artifact, verify);
    case "ui-functional":
      return functionalVerify(artifact, verify);
    case "side-effect-marking":
      return sideEffectMarkingVerify(artifact, verify);
    case "contains":
    default:
      return containsVerify(artifact, verify);
  }
}
