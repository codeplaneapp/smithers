import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Effect, Exit, Layer, Option, Sink, Stream } from "effect"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as Container from "../src/Container.ts"
import * as TestRun from "../src/TestRun.ts"
import * as TestRunner from "../src/TestRunner.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

interface Response {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
}

/**
 * Records every argv the flow spawns and answers each from a table keyed by a
 * distinguishing fragment, so a test asserts on the invocation rather than on
 * the order the implementation happens to use.
 */
const host = (
  spawns: Array<ReadonlyArray<string>>,
  responses: ReadonlyArray<readonly [string, Response]>
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
    spawn: (command) =>
      Effect.sync(() => {
        const standard = command as ChildProcess.StandardCommand
        const argv = [standard.command, ...standard.args]
        spawns.push(argv)
        // The working directory is part of what identifies a run: the baseline
        // is the same argv in the scratch worktree.
        const line = [...argv, standard.options.cwd ?? ""].join(" ")
        const found = responses.find(([fragment]) => line.includes(fragment))?.[1] ?? {}
        const encode = (text: string) => Stream.make(new TextEncoder().encode(text))
        const stdout = encode(found.stdout ?? "")
        const stderr = encode(found.stderr ?? "")
        return makeHandle({
          pid: ProcessId(1),
          exitCode: Effect.succeed(ExitCode(found.exitCode ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout,
          stderr,
          all: Stream.concat(stdout, stderr),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
  }))

const runner = TestRunner.layer({ command: "python -m pytest -rA", cwd: "/repo" })

const failureOf = <A>(exit: Exit.Exit<A, unknown>) =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) as { code?: string; message?: string } | undefined
    : undefined

describe("TestRun", () => {
  it("answers with a reading of the runner's report, not its output", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const result = await execute(Effect.provide(
      TestRun.run({ selection: ["tests/test_widen.py::test_narrows"] }),
      Layer.merge(
        host(spawns, [["pytest", {
          stdout: "FAILED tests/test_widen.py::test_narrows - boom\n1 failed, 41 passed in 1.2s\n",
          exitCode: 1
        }]]),
        runner
      )
    ))
    expect(result).toMatchObject({
      exitCode: 1,
      passed: 41,
      failed: ["tests/test_widen.py::test_narrows"],
      parsed: true
    })
    // The selection travels as arguments; a test id full of :: and brackets is
    // never quoted into a command line.
    expect(spawns).toEqual([[
      "bash",
      "-lc",
      "python -m pytest -rA \"$@\"",
      "python -m pytest -rA",
      "tests/test_widen.py::test_narrows"
    ]])
    expect(result.command).toContain("python -m pytest -rA")
    expect(Object.hasOwn(result, "base")).toBe(false)
  })

  it("keeps the raw tail when the report cannot be read", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const result = await execute(Effect.provide(
      TestRun.run({}),
      Layer.merge(host(spawns, [["pytest", { stderr: "Segmentation fault\n", exitCode: 139 }]]), runner)
    ))
    expect(result).toMatchObject({ parsed: false, passed: 0, failed: [], tailTruncated: false })
    expect(result.tail).toContain("Segmentation fault")
  })

  it("runs the pristine base in a scratch worktree and attributes every failure", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const result = await execute(Effect.provide(
      TestRun.run({ against: "base" }),
      Layer.merge(
        host(spawns, [
          ["rev-parse", { stdout: "abc123\n" }],
          ["worktree add", {}],
          ["worktree remove", {}],
          [TestRun.scratchDirectory, { stdout: "FAILED tests/b.py::stale - old\n1 failed, 40 passed\n", exitCode: 1 }],
          ["pytest", {
            stdout: "FAILED tests/a.py::mine - new\nFAILED tests/b.py::stale - old\n2 failed, 39 passed\n",
            exitCode: 1
          }]
        ]),
        runner
      )
    ))
    expect(result.failed).toEqual(["tests/a.py::mine", "tests/b.py::stale"])
    expect(result.base).toMatchObject({
      ref: TestRunner.captureBase,
      commit: "abc123",
      failed: ["tests/b.py::stale"],
      passed: 40
    })
    expect(result.introduced).toEqual(["tests/a.py::mine"])
    expect(result.preexisting).toEqual(["tests/b.py::stale"])
    expect(result.fixed).toEqual([])
    const lines = spawns.map((argv) => argv.join(" "))
    expect(lines[1]).toBe(`git -C /repo rev-parse --verify --quiet ${TestRunner.captureBase}^{commit}`)
    expect(lines[2]).toBe(`git -C /repo worktree add --detach --force /repo/${TestRun.scratchDirectory} abc123`)
    expect(lines[3]).toBe(lines[0])
    expect(lines[4]).toBe(`git -C /repo worktree remove --force /repo/${TestRun.scratchDirectory}`)
  })

  it("falls back from the capture base to HEAD, and says which it used", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const result = await execute(Effect.provide(
      TestRun.run({ against: "base" }),
      Layer.merge(
        host(spawns, [
          [`${TestRunner.captureBase}^`, { exitCode: 1 }],
          ["rev-parse", { stdout: "deadbee\n" }],
          ["pytest", { stdout: "3 passed\n" }]
        ]),
        runner
      )
    ))
    expect(result.base?.ref).toBe("HEAD")
    expect(result.base?.commit).toBe("deadbee")
  })

  it("refuses a baseline it cannot anchor rather than comparing against the wrong tree", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await execute(Effect.provide(
      Effect.exit(TestRun.run({ against: "base" })),
      Layer.merge(
        host(spawns, [["rev-parse", { exitCode: 1 }], ["pytest", { stdout: "3 passed\n" }]]),
        TestRunner.layer({ command: "pytest", cwd: "/repo", baseRef: "refs/flows/absent" })
      )
    ))
    expect(failureOf(exit)?.code).toBe("not_found")
    expect(failureOf(exit)?.message).toContain("refs/flows/absent")
    expect(spawns.some((argv) => argv.join(" ").includes("worktree add"))).toBe(false)
  })

  it("removes the scratch worktree even when the baseline run fails to start", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const stalled = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
      spawn: (command) => {
        const standard = command as ChildProcess.StandardCommand
        const argv = [standard.command, ...standard.args]
        spawns.push(argv)
        const line = argv.join(" ")
        if ((standard.options.cwd ?? "").includes(TestRun.scratchDirectory)) {
          return Effect.fail(new Error("spawn refused") as never)
        }
        const stdout = Stream.make(new TextEncoder().encode(line.includes("rev-parse") ? "abc123\n" : "3 passed\n"))
        return Effect.succeed(makeHandle({
          pid: ProcessId(1),
          exitCode: Effect.succeed(ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout,
          stderr: Stream.empty,
          all: stdout,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        }))
      }
    }))
    const exit = await execute(
      Effect.provide(Effect.exit(TestRun.run({ against: "base" })), Layer.merge(stalled, runner))
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(spawns.some((argv) => argv.join(" ").includes("worktree remove"))).toBe(true)
  })

  it("routes the run through the container transport when the declaration names one", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    await execute(Effect.provide(
      TestRun.run({ selection: ["tests/test_x.py"] }),
      Layer.mergeAll(
        host(spawns, [["pytest", { stdout: "1 passed\n" }]]),
        TestRunner.layer({ command: "pytest -rA", cwd: "/testbed", root: "/work/repo", container: "swebench-1" }),
        Layer.succeed(Container.Container)(Container.makeCommand())
      )
    ))
    expect(spawns[0]).toEqual([
      "docker",
      "exec",
      "-w",
      "/testbed",
      "swebench-1",
      "bash",
      "-lc",
      "pytest -rA \"$@\"",
      "pytest -rA",
      "tests/test_x.py"
    ])
  })

  it("says plainly when the host declares no runner", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await execute(Effect.provide(
      Effect.exit(TestRun.run({})),
      Layer.merge(host(spawns, []), TestRunner.layerNoop)
    ))
    expect(failureOf(exit)?.code).toBe("provider_unavailable")
    expect(spawns).toEqual([])
  })

  it("declares the irreversible tier and the spawn capability", () => {
    expect(TestRun.effects).toMatchObject({ tier: "irreversible", mode: "expected" })
    expect(TestRun.effectsFor({})).toBe(TestRun.effects)
    expect(TestRun.capabilities).toEqual(["proc:spawn:*"])
  })
})
