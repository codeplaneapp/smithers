import { describe, test, expect } from "bun:test";
import { parse, resolve, sep } from "node:path";
import { escapeSmithersDir } from "../src/escapeSmithersDir.js";

// On Windows resolve() qualifies rooted paths with the cwd drive ("\repo" →
// "D:\repo"), so absolute test paths must be built from that same root or the
// expectations drift by a drive letter.
const ROOT = parse(resolve(sep)).root;
const abs = (...segs) => ROOT + segs.join(sep);

describe("escapeSmithersDir", () => {
  test("escapes upward past a .smithers/workflows dirname to the workspace root", () => {
    // The classic genesis: a workflow file at <repo>/.smithers/workflows/x.tsx
    // whose dirname must NOT become the run root (that spawns a nested
    // .smithers/workflows/.smithers workspace).
    expect(escapeSmithersDir(abs("repo", ".smithers", "workflows"))).toBe(
      abs("repo"),
    );
  });

  test("escapes from a deeper path inside .smithers", () => {
    expect(
      escapeSmithersDir(abs("Users", "me", "proj", ".smithers", "workflows", "sub")),
    ).toBe(abs("Users", "me", "proj"));
  });

  test("leaves a path with no .smithers segment unchanged", () => {
    expect(escapeSmithersDir(abs("repo", "packages", "app"))).toBe(
      abs("repo", "packages", "app"),
    );
  });

  test("a relative .smithers path resolves against cwd, then escapes to cwd", () => {
    // resolve() makes it absolute first, so .smithers gains real ancestors and
    // the escape lands above the first .smithers segment rather than a garbage
    // root. Worktrees may themselves live below .smithers.
    const cwd = resolve();
    const parts = cwd.split(sep);
    const smithersIndex = parts.indexOf(".smithers");
    const expected = smithersIndex > 0 ? parts.slice(0, smithersIndex).join(sep) || sep : cwd;
    expect(escapeSmithersDir([".smithers", "workflows"].join(sep))).toBe(expected);
  });

  test("returns the filesystem root when .smithers sits directly at the root", () => {
    // The only case with no ancestor to escape to.
    expect(escapeSmithersDir(abs(".smithers", "workflows"))).toBe(ROOT);
  });

  test("only escapes past the FIRST .smithers segment", () => {
    expect(
      escapeSmithersDir(abs("repo", ".smithers", "workflows", ".smithers", "wt", "x")),
    ).toBe(abs("repo"));
  });
});
