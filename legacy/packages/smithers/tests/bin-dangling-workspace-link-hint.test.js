import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { danglingWorkspaceLinkHint } from "../src/bin/danglingWorkspaceLinkHint.js";

/** @type {string[]} */
const tempRoots = [];
afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempRoot() {
  const root = mkdtempSync(join(tmpdir(), "smithers-dangling-hint-"));
  tempRoots.push(root);
  return root;
}

describe("danglingWorkspaceLinkHint", () => {
  test("names a dangling @smthrs link and the pnpm install fix", () => {
    const root = makeTempRoot();
    const scopeDir = join(root, "node_modules", "@smthrs");
    mkdirSync(scopeDir, { recursive: true });
    const deadTarget = join(root, ".smithers", "workflows", ".worktrees", "sr-task", "apps", "cli");
    symlinkSync(deadTarget, join(scopeDir, "cli"));
    const hint = danglingWorkspaceLinkHint(join(root, "src", "bin"));
    expect(hint).not.toBeNull();
    expect(hint).toContain(join(scopeDir, "cli"));
    expect(hint).toContain(deadTarget);
    expect(hint).toContain("worktree");
    expect(hint).toContain("pnpm install");
  });
  test("reports a dangling top-level smthrs link", () => {
    const root = makeTempRoot();
    const nodeModules = join(root, "node_modules");
    mkdirSync(nodeModules, { recursive: true });
    symlinkSync(join(root, "gone", "packages", "smithers"), join(nodeModules, "smthrs"));
    const hint = danglingWorkspaceLinkHint(root);
    expect(hint).not.toBeNull();
    expect(hint).toContain(join(nodeModules, "smthrs"));
  });
  test("returns null when workspace links resolve", () => {
    const root = makeTempRoot();
    const scopeDir = join(root, "node_modules", "@smthrs");
    const realPkg = join(root, "packages", "cli");
    mkdirSync(scopeDir, { recursive: true });
    mkdirSync(realPkg, { recursive: true });
    writeFileSync(join(realPkg, "package.json"), "{}", "utf8");
    symlinkSync(realPkg, join(scopeDir, "cli"));
    expect(danglingWorkspaceLinkHint(root)).toBeNull();
  });
  test("ignores unrelated dangling links outside the smithers entries", () => {
    const root = makeTempRoot();
    const nodeModules = join(root, "node_modules");
    mkdirSync(nodeModules, { recursive: true });
    symlinkSync(join(root, "gone"), join(nodeModules, "left-pad"));
    expect(danglingWorkspaceLinkHint(root)).toBeNull();
  });
});
