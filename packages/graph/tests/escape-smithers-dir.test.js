import { describe, test, expect } from "bun:test";
import { sep } from "node:path";
import { escapeSmithersDir } from "../src/escapeSmithersDir.js";

const p = (...segs) => segs.join(sep);

describe("escapeSmithersDir", () => {
  test("escapes upward past a .smithers/workflows dirname to the workspace root", () => {
    // The classic genesis: a workflow file at <repo>/.smithers/workflows/x.tsx
    // whose dirname must NOT become the run root (that spawns a nested
    // .smithers/workflows/.smithers workspace).
    expect(escapeSmithersDir(p("", "repo", ".smithers", "workflows"))).toBe(
      p("", "repo"),
    );
  });

  test("escapes from a deeper path inside .smithers", () => {
    expect(
      escapeSmithersDir(p("", "Users", "me", "proj", ".smithers", "workflows", "sub")),
    ).toBe(p("", "Users", "me", "proj"));
  });

  test("leaves a path with no .smithers segment unchanged", () => {
    expect(escapeSmithersDir(p("", "repo", "packages", "app"))).toBe(
      p("", "repo", "packages", "app"),
    );
  });

  test("a relative .smithers path resolves against cwd, then escapes to cwd", () => {
    // resolve() makes it absolute first, so .smithers gains real ancestors and
    // the escape lands on the invoking directory rather than a garbage root.
    expect(escapeSmithersDir(p(".smithers", "workflows"))).toBe(process.cwd());
  });

  test("returns the filesystem root when .smithers sits directly at the root", () => {
    // The only case with no ancestor to escape to.
    expect(escapeSmithersDir(p("", ".smithers", "workflows"))).toBe(sep);
  });

  test("only escapes past the FIRST .smithers segment", () => {
    expect(
      escapeSmithersDir(p("", "repo", ".smithers", "workflows", ".smithers", "wt", "x")),
    ).toBe(p("", "repo"));
  });
});
