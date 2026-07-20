// Regression coverage for issue #748: focused, todo, and failing tests must
// never be silently accepted in the e2e fault suite.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
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

function scaffoldFixture() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-fault-only-todo-audit-"));
  created.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(realScript, join(dir, "scripts", "check-fault-skips.mjs"));
  mkdirSync(join(dir, "e2e", "faults"), { recursive: true });

  const budget = trackedBudget();
  budget.forEach(([rel, count], index) => {
    const spelling = index % 2 === 0 ? 'it.skip("pinned", () => {});' : 'it.skipIf(true)("pinned", () => {});';
    const lines = Array.from({ length: count }, () => spelling);
    writeFileSync(join(dir, rel), `${lines.join("\n")}\n`, "utf8");
  });
  return { dir, budget };
}

function runAudit(dir) {
  return Bun.spawnSync([process.execPath, join(dir, "scripts/check-fault-skips.mjs")], {
    cwd: dir,
    stderr: "pipe",
    stdout: "pipe",
  });
}

describe("check-fault-skips forbidden modifiers", () => {
  test("counts it.skip and it.skipIf as tracked skips", () => {
    const { dir, budget } = scaffoldFixture();
    const result = runAudit(dir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const total = budget.reduce((sum, [, count]) => sum + count, 0);
    expect(result.stdout.toString()).toContain(
      `${total} tracked skipped fault assertion(s); no untracked skips`,
    );
  });

  test("rejects only, todo, and failing modifiers for test, describe, and it", () => {
    const { dir } = scaffoldFixture();
    const rel = "e2e/faults/case99-forbidden-modifiers.test.ts";
    const modifiers = ["only", "todo", "failing"];
    const declarations = ["test", "describe", "it"];
    const lines = modifiers.flatMap((modifier) =>
      declarations.map((declaration) => `${declaration}.${modifier}("forbidden", () => {});`),
    );
    writeFileSync(join(dir, rel), `${lines.join("\n")}\n`, "utf8");

    const result = runAudit(dir);
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    for (const modifier of modifiers) {
      expect(stderr).toContain(
        `[fault-skip-audit] unexpected .${modifier} fault test modifier in ${rel}: expected 0, found 3`,
      );
    }
  });

  test("does not let a forbidden modifier replace an allowed skip", () => {
    const { dir, budget } = scaffoldFixture();
    const [rel, count] = budget[0];
    writeFileSync(join(dir, rel), 'test.only("forbidden", () => {});\n', "utf8");

    const result = runAudit(dir);
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain(
      `[fault-skip-audit] unexpected .only fault test modifier in ${rel}: expected 0, found 1`,
    );
    expect(stderr).toContain(
      `[fault-skip-audit] tracked skip count changed in ${rel}: expected ${count}, found 0`,
    );
  });
});
