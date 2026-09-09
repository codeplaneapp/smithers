import { describe, expect, it } from "vitest"
import { normalizeArguments } from "../src/cli/Arguments.ts"

describe("public workspace spelling", () => {
  it.each([
    [["--quiet", "--root", "/project", "targets"], ["targets", "--quiet", "--workspace", "/project"]],
    [["--silent=false", "--root=/project", "targets"], ["targets", "--silent=false", "--workspace=/project"]],
    [["targets", "--root", "/project"], ["targets", "--workspace", "/project"]],
    [["--root", "/project", "targets"], ["targets", "--workspace", "/project"]],
    [["build", "//...", "--root=/project"], ["build", "//...", "--workspace=/project"]],
    [["--json", ":check", "--root", "/project"], ["target", ":check", "--json", "--workspace", "/project"]],
    [["--root", "/project", "show", "target", "//:sources"], [
      "show",
      "target",
      "--workspace",
      "/project",
      "//:sources"
    ]],
    [["generate", "ci", "--root", "/project"], ["generate", "ci", "--workspace", "/project"]],
    [["flow", "list", "--root", "/project"], ["flow", "list", "--root", "/project"]],
    [["generate", "flow", "hello", "--root", "/project"], ["generate", "flow", "hello", "--root", "/project"]],
    [["run", "//:app", "--", "--root", "/argument"], ["run", "//:app", "--", "--root", "/argument"]]
  ])("normalizes only target workspace options: %j", (input, output) => {
    expect(normalizeArguments(input!)).toEqual(output)
  })
})
