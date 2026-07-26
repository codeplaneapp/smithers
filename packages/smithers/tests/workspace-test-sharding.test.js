// Unit coverage for scripts/run-workspace-tests.mjs — the CI Windows-shard
// runner (CI_TEST_WORKFLOW). The script resolves its workspace from
// process.cwd(), so every test drives it against a throwaway fixture root and
// stays in --list mode (no package tests are ever spawned).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = resolve(root, "scripts/run-workspace-tests.mjs");
const created = [];

setDefaultTimeout(30_000);

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function runScript(cwd, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

// Directory names deliberately collide with the script's packageWeights map
// (apps/cli = 8, packages/engine = 6, .smithers = 2, unknown = 1) so the
// weighted partition is deterministic and pinnable.
function scaffoldWorkspace() {
  const dir = tempRoot("smithers-shard-fixture-");
  write(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fixture-root",
      // "missing-dir" (a listed workspace with no directory) and the stray
      // file under packages/ must both be tolerated silently.
      workspaces: ["packages/*", "apps/*", ".smithers", "missing-dir"],
    }),
  );
  const pkg = (rel, manifest) => write(join(dir, rel, "package.json"), JSON.stringify(manifest));
  pkg("apps/cli", { name: "@fixture/cli", scripts: { test: "bun test tests" } });
  pkg("packages/engine", { name: "@fixture/engine", scripts: { test: "bun test tests" } });
  pkg("packages/zeta", { name: "@fixture/zeta", scripts: { test: "bun test tests" } });
  pkg(".smithers", { name: "fixture-workflows", scripts: { test: "bun test tests" } });
  pkg("packages/no-test-script", { name: "@fixture/no-test-script" });
  mkdirSync(join(dir, "packages/no-manifest"), { recursive: true });
  write(join(dir, "packages/README.md"), "not a package\n");
  return dir;
}

describe("run-workspace-tests sharding", () => {
  test("rejects malformed or out-of-range arguments with usage and exit 2", () => {
    const dir = scaffoldWorkspace();
    const badArgLists = [
      ["--shard", "abc"],
      ["--shard", "3/2"],
      ["--shard", "0/2"],
      ["--shard"],
      ["--timeout-minutes", "0"],
      ["--timeout-minutes", "-3"],
      ["--timeout-minutes", "nope"],
      ["--exclude"],
      ["--bogus"],
    ];
    // --list goes first: a trailing --list would be swallowed as the value of
    // a value-less flag (e.g. `--exclude --list`) and the run would spawn tests.
    for (const args of badArgLists) {
      const result = runScript(dir, ["--list", ...args]);
      expect(result.status, `args: ${args.join(" ")}\nstderr:\n${result.stderr}`).toBe(2);
      expect(result.stderr, `args: ${args.join(" ")}`).toContain("Usage: node scripts/run-workspace-tests.mjs");
    }
  });

  test("partitions packages across shards by weight, deterministically, skipping non-test packages", () => {
    const dir = scaffoldWorkspace();
    const result = runScript(dir, ["--list", "--shard", "1/2"]);
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    // 4 test-bearing packages survive discovery: no-test-script (no scripts.test),
    // no-manifest (no package.json), the stray README, and the dangling
    // "missing-dir" workspace entry are all skipped.
    expect(result.stdout).toContain("Running workspace test shard 1/2 with 2/4 packages");
    // Greedy weighted partition: apps/cli(8) -> shard 1; packages/engine(6) and
    // .smithers(2) -> shard 2; packages/zeta(1) ties 8v8 and stays on shard 1.
    expect(result.stdout).toContain("Shard 1: apps/cli, packages/zeta");
    expect(result.stdout).toContain("Shard 2: .smithers, packages/engine");
  });

  test("selecting the other shard keeps the same partition", () => {
    const dir = scaffoldWorkspace();
    const result = runScript(dir, ["--list", "--shard", "2/2"]);
    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Running workspace test shard 2/2 with 2/4 packages");
    expect(result.stdout).toContain("Shard 1: apps/cli, packages/zeta");
    expect(result.stdout).toContain("Shard 2: .smithers, packages/engine");
  });

  test("--exclude trims whitespace, drops empty entries, and removes packages before sharding", () => {
    const dir = scaffoldWorkspace();
    const result = runScript(dir, ["--list", "--exclude", " apps/cli , ,packages/zeta "]);
    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Running workspace test shard 1/1 with 2/2 packages");
    expect(result.stdout).toContain("Shard 1: .smithers, packages/engine");
  });

  test("excluding every package yields an empty shard and still exits 0", () => {
    const dir = scaffoldWorkspace();
    const result = runScript(dir, ["--list", "--exclude", "apps/cli,packages/engine,packages/zeta,.smithers"]);
    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Running workspace test shard 1/1 with 0/0 packages");
  });

  test("fails loudly on workspace patterns it cannot expand", () => {
    const dir = tempRoot("smithers-shard-badpattern-");
    write(join(dir, "package.json"), JSON.stringify({ name: "fixture-root", workspaces: ["packages/*/src"] }));
    const result = runScript(dir, ["--list"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unsupported workspace pattern: packages/*/src");
  });
});
