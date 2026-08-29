// Behavioral unit coverage for scripts/check-fault-skips.mjs
// (SCRIPT_CHECK_FAULT_SKIPS): the ratchet that pins exactly how many
// `test.skip`/`describe.skipIf` calls each e2e fault file may contain. The
// tracked budget is parsed out of the real script source so these fixtures can
// never drift from the committed allow-list; the script itself is copied into
// a throwaway root so no real e2e files are ever read.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const realScript = resolve(root, "scripts/check-fault-skips.mjs");
const created = [];

setDefaultTimeout(30_000);

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function trackedBudget() {
  const source = readFileSync(realScript, "utf8");
  const entries = [...source.matchAll(/\["(e2e\/faults\/[^"]+)",\s*(\d+)\]/g)].map((match) => [
    match[1],
    Number(match[2]),
  ]);
  expect(entries.length).toBeGreaterThan(0);
  return entries;
}

// Rotate the skip spellings so the audit's `\b(test|describe).skip(If)?(` pattern
// stays pinned against all of its variants.
const SKIP_SPELLINGS = [
  'test.skip("pinned", () => {});',
  'describe.skip("pinned", () => {});',
  'test.skipIf(true)("pinned", () => {});',
  'describe.skipIf(true)("pinned", () => {});',
];

function scaffoldFixture() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-fault-skip-gate-"));
  created.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(realScript, join(dir, "scripts", "check-fault-skips.mjs"));
  mkdirSync(join(dir, "e2e", "faults"), { recursive: true });
  const budget = trackedBudget();
  budget.forEach(([rel, count], index) => {
    const lines = Array.from({ length: count }, () => SKIP_SPELLINGS[index % SKIP_SPELLINGS.length]);
    writeFileSync(join(dir, rel), `${lines.join("\n")}\n`, "utf8");
  });
  return { dir, budget };
}

function runAudit(dir) {
  return spawnSync(process.execPath, [join(dir, "scripts", "check-fault-skips.mjs")], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe("check-fault-skips audit", () => {
  test("passes when every tracked file holds exactly its budgeted skips, ignoring non-test files", () => {
    const { dir, budget } = scaffoldFixture();
    // A helper module full of skips must not trip the audit — only
    // *.test.* / *.spec.* files in e2e/faults are scanned.
    writeFileSync(join(dir, "e2e", "faults", "helpers.ts"), 'test.skip("not a test file", () => {});\n', "utf8");
    const result = runAudit(dir);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const total = budget.reduce((sum, [, count]) => sum + count, 0);
    expect(result.stdout).toContain(`${total} tracked skipped fault assertion(s); no untracked skips`);
  });

  test("fails when an untracked fault test introduces a skip", () => {
    const { dir } = scaffoldFixture();
    writeFileSync(
      join(dir, "e2e", "faults", "case99-shiny-new.test.ts"),
      'describe.skipIf(true)("sneaky", () => {});\n',
      "utf8",
    );
    const result = runAudit(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "unexpected skipped fault tests in e2e/faults/case99-shiny-new.test.ts: expected 0, found 1",
    );
  });

  test("fails when a tracked file loses its skip without the budget being updated", () => {
    const { dir, budget } = scaffoldFixture();
    const [rel, count] = budget[0];
    writeFileSync(join(dir, rel), 'test("now enabled", () => {});\n', "utf8");
    const result = runAudit(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`tracked skip count changed in ${rel}: expected ${count}, found 0`);
  });

  test("fails when a tracked file grows an extra skip beyond its budget", () => {
    const { dir, budget } = scaffoldFixture();
    const [rel, count] = budget[0];
    const lines = Array.from({ length: count + 1 }, () => 'test.skip("pinned", () => {});');
    writeFileSync(join(dir, rel), `${lines.join("\n")}\n`, "utf8");
    const result = runAudit(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`unexpected skipped fault tests in ${rel}: expected ${count}, found ${count + 1}`);
  });
});
