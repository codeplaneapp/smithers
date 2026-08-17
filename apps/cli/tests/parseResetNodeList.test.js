import { describe, expect, test } from "bun:test";
import { parseResetNodeList } from "../src/parseResetNodeList.js";

describe("parseResetNodeList", () => {
  test("keeps a single node id working", () => {
    expect(parseResetNodeList("analyze")).toEqual(["analyze"]);
  });

  // `fork`/`replay` reset only the nodes they are handed, so a caller that
  // wants a dependent re-run has to name it. A comma list is how the CLI lets
  // them, and dropping it would silently strip every id but the first.
  test("splits a comma list so dependents can be named alongside their source", () => {
    expect(parseResetNodeList("analyze,implement")).toEqual(["analyze", "implement"]);
    expect(parseResetNodeList(" analyze , implement , analyze ")).toEqual(["analyze", "implement"]);
    expect(parseResetNodeList("loop::0,loop::1")).toEqual(["loop::0", "loop::1"]);
  });

  test("returns undefined when no reset was requested", () => {
    expect(parseResetNodeList(undefined)).toBeUndefined();
    expect(parseResetNodeList("")).toBeUndefined();
    expect(parseResetNodeList(" , , ")).toBeUndefined();
  });
});
