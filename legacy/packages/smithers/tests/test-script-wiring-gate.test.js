// Behavioral unit coverage for scripts/check-smithers-test-script.mjs
// (SCRIPT_CHECK_SMITHERS_TEST_SCRIPT): the gate that keeps every workspace
// package with runtime tests wired into `pnpm -r test`, and every .smithers
// test file covered by some `bun test` script. The script resolves the repo
// root from its own location, so each case copies it into a throwaway fixture
// workspace — the real repo is never scanned.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const realScript = resolve(root, "scripts/check-smithers-test-script.mjs");
const created = [];

setDefaultTimeout(30_000);

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scaffoldFixture() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-test-script-gate-"));
  created.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(realScript, join(dir, "scripts", "check-smithers-test-script.mjs"));
  return dir;
}

function write(dir, rel, contents) {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`, "utf8");
}

function runGate(dir) {
  return spawnSync(process.execPath, [join(dir, "scripts", "check-smithers-test-script.mjs")], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe("check-smithers-test-script gate", () => {
  test("passes when packages and .smithers cover their runtime test files, including suffixed variants", () => {
    const dir = scaffoldFixture();
    write(dir, "packages/good/package.json", { name: "@fixture/good", scripts: { test: "bun test tests" } });
    write(dir, "packages/good/tests/basic.test.js", "");
    // Suffixed runtime test patterns (x.test-browser.tsx) count as tests too.
    write(dir, "apps/tool/package.json", { name: "@fixture/tool", scripts: { test: "bun test server" } });
    write(dir, "apps/tool/server/api.test-browser.tsx", "");
    // A package with no tests needs no test script.
    write(dir, "packages/quiet/package.json", { name: "@fixture/quiet" });
    write(dir, ".smithers/package.json", {
      name: "fixture-workflows",
      scripts: {
        // Explicit ./-prefixed file, trailing-slash ancestor dir, and a nested
        // dir argument must all count as covering their files.
        test: "bun test ./tests/exact.test.ts lib/",
        "test:ddd": "bun test ui/ddd",
      },
    });
    write(dir, ".smithers/tests/exact.test.ts", "");
    write(dir, ".smithers/lib/deep/util.spec-browser.tsx", "");
    write(dir, ".smithers/ui/ddd/flow.test.tsx", "");
    // node_modules under .smithers must never be scanned for uncovered tests.
    write(dir, ".smithers/lib/node_modules/dep/sneaky.test.js", "");
    const result = runGate(dir);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  test("fails when a package has runtime tests but no test script for pnpm -r test", () => {
    const dir = scaffoldFixture();
    write(dir, "packages/broken/package.json", { name: "@fixture/broken" });
    write(dir, "packages/broken/tests/x.test.js", "");
    const result = runGate(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "packages/broken/package.json has runtime tests but no scripts.test for pnpm -r test",
    );
  });

  test("fails when a .smithers test file is not run by any bun test script, naming the candidates", () => {
    const dir = scaffoldFixture();
    write(dir, ".smithers/package.json", {
      name: "fixture-workflows",
      scripts: {
        test: "bun test tests",
        "test:ddd": "bun test ui/ddd",
        lint: "oxlint .", // not a bun test script; must not appear as a candidate
      },
    });
    write(dir, ".smithers/tests/covered.test.ts", "");
    write(dir, ".smithers/ui/other/orphan.test.tsx", "");
    const result = runGate(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '.smithers/ui/other/orphan.test.tsx is a runtime test file but no "bun test" script runs it',
    );
    expect(result.stderr).toContain("add it to one of: test, test:ddd.");
    expect(result.stderr).not.toContain("lint");
  });

  test("a dir-name prefix that is not a path ancestor does not count as coverage", () => {
    const dir = scaffoldFixture();
    write(dir, ".smithers/package.json", {
      name: "fixture-workflows",
      // "ui/dd" is a string prefix of "ui/ddd" but not its directory ancestor.
      scripts: { test: "bun test ui/dd" },
    });
    write(dir, ".smithers/ui/ddd/flow.test.tsx", "");
    const result = runGate(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".smithers/ui/ddd/flow.test.tsx");
  });
});
