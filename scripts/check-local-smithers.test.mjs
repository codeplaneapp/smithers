import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ALLOWLIST,
  MIRRORED_RESOLVERS,
  REPO_ROOT,
  SOURCE_ENTRY,
  checkMirroredResolvers,
  findViolationsInFile,
  isCommentLine,
  listScannedFiles,
  check,
} from "./check-local-smithers.mjs";

describe("isCommentLine", () => {
  it("recognises the comment styles used across the repo", () => {
    assert.equal(isCommentLine("  // run it"), true);
    assert.equal(isCommentLine("# shell comment"), true);
    assert.equal(isCommentLine(" * jsdoc continuation"), true);
    assert.equal(isCommentLine("/* block start"), true);
  });

  it("does not treat code as a comment", () => {
    assert.equal(isCommentLine('const x = "// not a comment";'), false);
  });
});

describe("findViolationsInFile", () => {
  it("flags a published-CLI call in a shell script", () => {
    const violations = findViolationsInFile("a.sh", "bunx smthrs up flow.tsx\n");
    assert.equal(violations.length, 1);
    assert.equal(violations[0].line, 1);
  });

  it("flags every runner that fetches the published package", () => {
    for (const runner of ["bunx", "npx", "pnpm dlx", "yarn dlx"]) {
      const violations = findViolationsInFile("a.sh", `${runner} smthrs ps\n`);
      assert.equal(violations.length, 1, `${runner} should be flagged`);
    }
  });

  it("ignores comments in a shell script", () => {
    assert.deepEqual(findViolationsInFile("a.sh", "# bunx smthrs ps\n"), []);
  });

  it("flags a published-CLI call in package.json scripts", () => {
    const contents = JSON.stringify({ scripts: { build: "tsc", release: "bunx smthrs up r.tsx" } }, null, 2);
    const violations = findViolationsInFile("package.json", contents);
    assert.equal(violations.length, 1);
    assert.match(violations[0].text, /^release: /);
  });

  it("ignores non-script package.json fields", () => {
    const contents = JSON.stringify({ description: "run bunx smthrs up" });
    assert.deepEqual(findViolationsInFile("package.json", contents), []);
  });

  it("survives malformed package.json instead of throwing", () => {
    assert.deepEqual(findViolationsInFile("package.json", "{not json"), []);
  });

  it("flags a shell-executed call in TypeScript", () => {
    const source = "const res = await $`bunx smthrs graph f.tsx`.nothrow();\n";
    const violations = findViolationsInFile("w.tsx", source);
    assert.equal(violations.length, 1);
  });

  it("flags a spawnSync call in JavaScript", () => {
    const source = 'spawnSync("sh", ["-c", "bunx smthrs ps"]);\n';
    assert.equal(findViolationsInFile("h.mjs", source).length, 1);
  });

  it("leaves prose in agent prompts and docs assertions alone", () => {
    const source = 'const prompt = "Verify with `bunx smthrs graph <file>`";\n';
    assert.deepEqual(findViolationsInFile("w.tsx", source), []);
  });

  it("flags every line of a plugin server config", () => {
    const contents = JSON.stringify({
      mcpServers: { smithers: { command: "bunx smthrs", args: ["--mcp"] } },
    });
    assert.equal(findViolationsInFile("claude-plugin/.mcp.json", contents).length, 1);
  });

  it("returns nothing for an allowlisted path", () => {
    const [allowlisted] = Object.keys(ALLOWLIST);
    assert.deepEqual(findViolationsInFile(allowlisted, "bunx smthrs ps\n"), []);
  });
});

describe("checkMirroredResolvers", () => {
  const created = [];

  function makeTmp() {
    const dir = mkdtempSync(join(tmpdir(), "check-local-smithers-"));
    created.push(dir);
    return dir;
  }

  function writeResolvers(root, contents) {
    for (let index = 0; index < MIRRORED_RESOLVERS.length; index++) {
      const path = join(root, MIRRORED_RESOLVERS[index]);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, contents[index]);
    }
  }

  it("passes when the copies are byte-identical", () => {
    const root = makeTmp();
    writeResolvers(
      root,
      MIRRORED_RESOLVERS.map(() => "export const a = 1;\n"),
    );
    assert.deepEqual(checkMirroredResolvers(root), []);
  });

  it("reports drift with the command that repairs it", () => {
    const root = makeTmp();
    writeResolvers(root, ["export const a = 1;\n", "export const a = 2;\n"]);
    const problems = checkMirroredResolvers(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /has drifted/);
    assert.match(problems[0], /cp /);
  });

  it("reports a copy that is missing beside a copy that exists", () => {
    const root = makeTmp();
    const present = join(root, MIRRORED_RESOLVERS[0]);
    mkdirSync(join(present, ".."), { recursive: true });
    writeFileSync(present, "export const a = 1;\n");
    const problems = checkMirroredResolvers(root);
    assert.equal(problems.length, MIRRORED_RESOLVERS.length - 1);
    assert.match(problems[0], /is missing/);
  });

  it("passes when no plugin resolver copy exists", () => {
    assert.deepEqual(checkMirroredResolvers(makeTmp()), []);
  });

  process.on("exit", () => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });
});

describe("the repo itself", () => {
  it("scans the internal execution surfaces", () => {
    const scanned = listScannedFiles();
    assert.ok(scanned.includes("package.json"));
    assert.ok(scanned.includes("scripts/check-local-smithers.mjs"));
    assert.ok(scanned.some((path) => path.startsWith("ci/")));
    assert.ok(!scanned.some((path) => path.includes("node_modules")));
  });

  it("names a working-tree entry that exists", () => {
    assert.ok(existsSync(join(REPO_ROOT, SOURCE_ENTRY)), `${SOURCE_ENTRY} must exist`);
  });

  it("has no internal script running the published CLI", () => {
    const { violations, resolverProblems } = check();
    assert.deepEqual(resolverProblems, []);
    assert.deepEqual(
      violations.map((violation) => `${violation.path}:${violation.line}`),
      [],
    );
  });
});
