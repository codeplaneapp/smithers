import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type PromotionTier = "pr" | "nightly";

export type FaultCase = {
  id: string;
  file: string;
  promotionTier: PromotionTier;
};

export type FaultMatrix = {
  version: number;
  promotionPassesRequired: number;
  cases: FaultCase[];
};

export type CaseResult = {
  id: string;
  file: string;
  tests: number;
  failures: number;
  skipped: number;
  durationMs: number;
  outcome: "pass" | "flake" | "incomplete";
};

export type RecentRun = Pick<
  CaseResult,
  "outcome" | "tests" | "failures" | "skipped" | "durationMs"
> & {
  runId: string;
  recordedAt: string;
};

export type CaseHistory = {
  totalAttempts: number;
  totalCompletedRuns: number;
  totalFlakes: number;
  consecutivePasses: number;
  recentRuns: RecentRun[];
};

export type FlakeHistory = {
  version: 1;
  cases: Record<string, CaseHistory>;
};

export const E2E_ROOT = resolve(import.meta.dirname, "..");
export const REPO_ROOT = resolve(E2E_ROOT, "..");
export const MATRIX_PATH = join(E2E_ROOT, "fault-matrix.json");

function parseMatrix(raw: string, source: string): FaultMatrix {
  const value = JSON.parse(raw) as Partial<FaultMatrix>;
  if (value.version !== 1 || value.promotionPassesRequired !== 100 || !Array.isArray(value.cases)) {
    throw new Error(`${source}: expected version 1 and promotionPassesRequired=100`);
  }

  const ids = new Set<string>();
  const files = new Set<string>();
  for (const entry of value.cases) {
    if (!/^case\d{2}$/.test(entry.id)) throw new Error(`${source}: invalid case id ${entry.id}`);
    if (ids.has(entry.id)) throw new Error(`${source}: duplicate case id ${entry.id}`);
    if (files.has(entry.file)) throw new Error(`${source}: duplicate case file ${entry.file}`);
    if (entry.promotionTier !== "pr" && entry.promotionTier !== "nightly") {
      throw new Error(`${source}: invalid promotion tier for ${entry.id}`);
    }
    ids.add(entry.id);
    files.add(entry.file);
  }
  return value as FaultMatrix;
}

export function loadMatrix(path = MATRIX_PATH): FaultMatrix {
  return parseMatrix(readFileSync(path, "utf8"), path);
}

export function loadMatrixFromGit(ref: string): FaultMatrix | null {
  const object = `${ref}:e2e/fault-matrix.json`;
  execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });
  try {
    execFileSync("git", ["cat-file", "-e", object], { cwd: REPO_ROOT, stdio: "ignore" });
  } catch {
    return null;
  }
  const raw = execFileSync("git", ["show", object], { cwd: REPO_ROOT, encoding: "utf8" });
  return parseMatrix(raw, object);
}

export function assertMatrixInventory(matrix: FaultMatrix): void {
  const actual = readdirSync(join(E2E_ROOT, "faults"))
    .filter((file) => /^case\d{2}-.+\.test\.ts$/.test(file))
    .map((file) => `faults/${file}`)
    .sort();
  const declared = matrix.cases.map((entry) => entry.file).sort();
  if (JSON.stringify(actual) !== JSON.stringify(declared)) {
    throw new Error(
      `fault-matrix.json must list every fault case exactly once\ndeclared=${JSON.stringify(declared)}\nactual=${JSON.stringify(actual)}`,
    );
  }
}

function attributes(tag: string): Record<string, string> {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]),
  );
}

export function parseJUnitResults(xml: string, matrix: FaultMatrix): CaseResult[] {
  const suites = new Map<string, Record<string, string>>();
  for (const match of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    const attrs = attributes(match[1]!);
    if (attrs.name?.startsWith("e2e/faults/") && attrs.name === attrs.file) {
      suites.set(attrs.name, attrs);
    }
  }

  return matrix.cases.map((entry) => {
    const file = `e2e/${entry.file}`;
    const attrs = suites.get(file);
    const tests = Number(attrs?.tests ?? 0);
    const failures = Number(attrs?.failures ?? (attrs ? 0 : 1));
    const skipped = Number(attrs?.skipped ?? 0);
    const durationMs = Number(attrs?.time ?? 0) * 1000;
    const outcome = failures > 0 ? "flake" : tests === 0 || skipped > 0 ? "incomplete" : "pass";
    return { id: entry.id, file, tests, failures, skipped, durationMs, outcome };
  });
}

export function readHistory(path: string): FlakeHistory {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as FlakeHistory;
    if (value.version !== 1 || typeof value.cases !== "object") throw new Error("invalid schema");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, cases: {} };
    throw new Error(`Cannot read flake history ${path}: ${String(error)}`);
  }
}

export function mergeHistory(
  history: FlakeHistory,
  results: CaseResult[],
  runId: string,
  recordedAt = new Date().toISOString(),
): FlakeHistory {
  for (const result of results) {
    const current = history.cases[result.id] ?? {
      totalAttempts: 0,
      totalCompletedRuns: 0,
      totalFlakes: 0,
      consecutivePasses: 0,
      recentRuns: [],
    };
    const completed = result.outcome !== "incomplete";
    const recent: RecentRun = {
      runId,
      recordedAt,
      outcome: result.outcome,
      tests: result.tests,
      failures: result.failures,
      skipped: result.skipped,
      durationMs: result.durationMs,
    };
    history.cases[result.id] = {
      totalAttempts: current.totalAttempts + 1,
      totalCompletedRuns: current.totalCompletedRuns + (completed ? 1 : 0),
      totalFlakes: current.totalFlakes + (result.outcome === "flake" ? 1 : 0),
      consecutivePasses: result.outcome === "pass" ? current.consecutivePasses + 1 : 0,
      recentRuns: [...current.recentRuns, recent].slice(-100),
    };
  }
  return history;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

export function promotionFailures(
  current: FaultMatrix,
  base: FaultMatrix,
  history: FlakeHistory,
): string[] {
  const baseCases = new Map(base.cases.map((entry) => [entry.id, entry]));
  const failures: string[] = [];
  for (const entry of current.cases) {
    const before = baseCases.get(entry.id);
    const isPromotion = entry.promotionTier === "pr" && before?.promotionTier !== "pr";
    if (!isPromotion) continue;
    const recent = history.cases[entry.id]?.recentRuns ?? [];
    const window = recent.slice(-current.promotionPassesRequired);
    const passes = window.filter((run) => run.outcome === "pass").length;
    if (window.length !== current.promotionPassesRequired || passes !== window.length) {
      failures.push(
        `${entry.id} cannot move to pr: requires 100 consecutive complete nightly passes; history has ${passes}/${current.promotionPassesRequired}`,
      );
    }
  }
  return failures;
}

export function repoRelativeFaultFiles(matrix: FaultMatrix): string[] {
  return matrix.cases.map((entry) => relative(REPO_ROOT, resolve(E2E_ROOT, entry.file)));
}
