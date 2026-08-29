/**
 * The `test` flow over a real repository, a real git, and a real process.
 *
 * `TestRun.test.ts` drives every branch against a scripted spawner, which is
 * how the parsing and the attribution are pinned. It cannot say whether the
 * baseline half works, because the whole of that half is git: a ref written by
 * something else, a detached worktree checked out beside the tree under test,
 * a second run of the identical invocation inside it, and the removal
 * afterwards. The r91 wave is the reason that distinction is worth a file — it
 * shipped this flow with no composition binding it and measured zero `test`
 * calls across 45 runs, which is what an untried path costs.
 *
 * The runner here is a shell script in the repository, so nothing but `git` and
 * `bash` is assumed.
 */
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as TestRun from "../src/TestRun.ts"
import * as TestRunner from "../src/TestRunner.ts"

const git = (root: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

/** A repository whose suite passes or fails according to one file's contents. */
const repository = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flows-testrun-")))
  writeFileSync(
    join(root, "runtests.sh"),
    [
      "#!/bin/bash",
      "if grep -q FIXED mod.py; then echo 'tests/test_a.py::test_a PASSED';",
      "else echo 'FAILED tests/test_a.py::test_a - boom'; fi",
      "if grep -q BROKEN mod.py; then echo 'FAILED tests/test_b.py::test_b - boom'; fi",
      "printf '%s\\n' \"$@\" > selection.txt",
      ""
    ].join("\n"),
    { mode: 0o755 }
  )
  writeFileSync(join(root, "mod.py"), "x = 1\n")
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "rig@localhost"])
  git(root, ["config", "user.name", "rig"])
  git(root, ["add", "-A"])
  git(root, ["commit", "-qm", "base"])
  return root
}

const run = (input: typeof TestRun.Input.Type, runner: TestRunner.Runner) =>
  Effect.runPromise(
    Effect.provide(
      TestRun.run(input),
      Layer.mergeAll(NodeServices.layer, TestRunner.layer(runner))
    ) as Effect.Effect<typeof TestRun.Output.Type>
  )

describe("TestRun over a real repository", () => {
  it("runs the base commit beside the working tree and attributes the difference", async () => {
    const root = repository()
    // The ref `evals/swebench/lib/snapshot-base.sh` writes, which is also the
    // flow's own default when a declaration names none.
    git(root, ["update-ref", TestRunner.captureBase, "HEAD"])
    writeFileSync(join(root, "mod.py"), "FIXED\nBROKEN\n")

    // The shape `NodeControl.testRunner` builds out of `FLOWS_TEST_COMMAND` and
    // its companions, for a host whose repository is not in a container.
    const output = await run(
      { against: "base", selection: ["tests/test_a.py::test_a[x y]"] },
      { command: "bash ./runtests.sh", cwd: root, root }
    )

    expect(output.parsed).toBe(true)
    expect(output.failed).toEqual(["tests/test_b.py::test_b"])
    expect(output.base?.ref).toBe(TestRunner.captureBase)
    expect(output.base?.commit).toBe(git(root, ["rev-parse", "HEAD"]).trim())
    expect(output.base?.failed).toEqual(["tests/test_a.py::test_a"])
    expect(output.introduced).toEqual(["tests/test_b.py::test_b"])
    expect(output.preexisting).toEqual([])
    expect(output.fixed).toEqual(["tests/test_a.py::test_a"])
    // A test id carries `::`, brackets and spaces routinely. It reaches the
    // runner as one argument because it travels as data, never as shell text.
    expect(readFileSync(join(root, "selection.txt"), "utf8").trim())
      .toBe("tests/test_a.py::test_a[x y]")
    // The baseline worktree is gone however the call ended.
    expect(git(root, ["worktree", "list"])).not.toContain(TestRun.scratchDirectory)
  }, 60_000)

  it("falls back to HEAD when no capture base was ever recorded", async () => {
    const root = repository()
    writeFileSync(join(root, "mod.py"), "FIXED\n")

    const output = await run({ against: "base" }, { command: "bash ./runtests.sh", cwd: root, root })

    expect(output.base?.ref).toBe("HEAD")
    expect(output.fixed).toEqual(["tests/test_a.py::test_a"])
  }, 60_000)

  it("refuses a declared base ref that does not resolve rather than baselining the wrong tree", async () => {
    const root = repository()
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.provide(
          TestRun.run({ against: "base" }),
          Layer.mergeAll(
            NodeServices.layer,
            TestRunner.layer({ command: "bash ./runtests.sh", cwd: root, root, baseRef: "refs/flows/absent" })
          )
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("No pristine base to compare against")
  }, 60_000)
})
