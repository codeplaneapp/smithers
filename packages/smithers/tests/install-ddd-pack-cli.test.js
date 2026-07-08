// Unit coverage for scripts/install-ddd-pack.ts (SCRIPT_INSTALL_DDD_PACK):
// argument validation, the pre-existing-DDD warning, and a real install into a
// temp target — pure filesystem copies of this repo's authored pack, no agents
// or network.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = resolve(root, "scripts/install-ddd-pack.ts");
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

function runInstall(args) {
  return spawnSync("bun", [script, ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe("install-ddd-pack CLI", () => {
  test("rejects a missing target argument with usage", () => {
    const result = runInstall([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: bun scripts/install-ddd-pack.ts <target-repo-dir>");
  });

  test("rejects a nonexistent target and a target that is a plain file", () => {
    const dir = tempRoot("smithers-ddd-target-");
    const missing = join(dir, "does-not-exist");
    let result = runInstall([missing]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Target repo does not exist or is not a directory");

    const file = join(dir, "a-file");
    writeFileSync(file, "not a directory\n");
    result = runInstall([file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Target repo does not exist or is not a directory");
  });

  test("installs the self-contained pack into an empty target", () => {
    const target = tempRoot("smithers-ddd-install-");
    const result = runInstall([target]);
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`Installed DDD pack into ${join(target, ".smithers")}`);
    // The target has no node_modules, so the bootstrap hint must appear.
    expect(result.stdout).toContain("run `smithers init` in the target first");

    // lib/ddd mirrors the source's non-test helper files exactly.
    const sourceLib = readdirSync(join(root, ".smithers/lib/ddd"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && !/\.test\.tsx?$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    expect(sourceLib.length).toBeGreaterThan(0);
    const installedLib = readdirSync(join(target, ".smithers/lib/ddd")).sort();
    expect(installedLib).toEqual(sourceLib);
    expect(installedLib.some((name) => /\.test\.tsx?$/.test(name))).toBe(false);

    for (const rel of [
      "workflows/ddd-generate-docs.tsx",
      "workflows/ddd-bug-scan.tsx",
      "workflows/docs-driven-development.tsx",
      "ui/docs-driven-development.tsx",
      "ui/ddd-shared.tsx",
    ]) {
      expect(existsSync(join(target, ".smithers", rel)), rel).toBe(true);
    }
    // The repo-only dev harness must NOT ship to targets.
    expect(existsSync(join(target, ".smithers/workflows/ddd-improve.tsx"))).toBe(false);
  });

  test("warns before writing when the target already has a DDD system, but still installs", () => {
    const target = tempRoot("smithers-ddd-preexisting-");
    mkdirSync(join(target, "docs/spec"), { recursive: true });
    writeFileSync(join(target, "docs/spec/features.json"), "{}\n");
    const result = runInstall([target]);
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("already has a docs-driven-development system");
    expect(result.stdout).toContain("docs/spec/features.json");
    expect(existsSync(join(target, ".smithers/workflows/docs-driven-development.tsx"))).toBe(true);
  });
});
