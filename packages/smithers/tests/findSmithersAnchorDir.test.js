import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findSmithersAnchorDir } from "../src/findSmithersAnchorDir.js";

const HOME_BEFORE = process.env.HOME;
/** @type {string[]} */
const created = [];

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "smithers-anchor-home-"));
  created.push(home);
  process.env.HOME = home;
  return home;
}

afterEach(() => {
  if (HOME_BEFORE === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = HOME_BEFORE;
  }
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("findSmithersAnchorDir", () => {
  test("returns the nearest ancestor below HOME that contains .smithers/", () => {
    const home = makeHome();
    const project = join(home, "project");
    const deep = join(project, "a", "b");
    mkdirSync(join(project, ".smithers"), { recursive: true });
    mkdirSync(deep, { recursive: true });
    // Walks up from a nested subdir to the anchor.
    expect(findSmithersAnchorDir(deep)).toBe(project);
    // And resolves directly when invoked on the anchor itself.
    expect(findSmithersAnchorDir(project)).toBe(project);
  });

  test("ignores a .smithers file that is not a directory", () => {
    const home = makeHome();
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    // A bare file named `.smithers` must not anchor (statSync().isDirectory() guard).
    Bun.write(join(project, ".smithers"), "not a dir");
    expect(findSmithersAnchorDir(project)).toBeUndefined();
  });

  test("stops at or above HOME (a global ~/.smithers must not anchor)", () => {
    const home = makeHome();
    mkdirSync(join(home, ".smithers"), { recursive: true });
    // HOME itself is excluded even though it has a .smithers/.
    expect(findSmithersAnchorDir(home)).toBeUndefined();
    // A sibling outside HOME is excluded by the startsWith(home + "/") guard.
    const outside = mkdtempSync(join(tmpdir(), "smithers-anchor-outside-"));
    created.push(outside);
    expect(findSmithersAnchorDir(outside)).toBeUndefined();
  });

  test("with HOME unset, walks to the filesystem root and returns undefined when nothing anchors", () => {
    const scratch = mkdtempSync(join(tmpdir(), "smithers-anchor-nohome-"));
    created.push(scratch);
    delete process.env.HOME;
    // No HOME guard, no .smithers ancestor -> the fsRoot guard ends the walk.
    expect(findSmithersAnchorDir(join(scratch, "x", "y"))).toBeUndefined();
  });

  test("skips a nested .smithers/workflows/.smithers and anchors on the real workspace root", () => {
    const home = makeHome();
    const project = join(home, "project");
    // Real workspace pack.
    mkdirSync(join(project, ".smithers", "workflows"), { recursive: true });
    // A stray NESTED pack left by a prior buggy run.
    mkdirSync(join(project, ".smithers", "workflows", ".smithers"), { recursive: true });
    // Invoked from inside the nested workflows dir, resolution must escape past
    // the nested .smithers and land on the real project root, not the nested one.
    expect(findSmithersAnchorDir(join(project, ".smithers", "workflows"))).toBe(project);
  });
});
