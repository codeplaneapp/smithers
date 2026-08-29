/**
 * The checkpoint store's two halves, against a scripted process.
 *
 * `CheckpointsFixture.test.ts` drives the git half against a real repository;
 * this file pins the argv it spawns, the shape it answers with, and the whole of
 * the relocation table — which is the part that decides what a checkpoint can be
 * pointed at, and is therefore the part a wrong answer would silently corrupt.
 */
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Effect, Exit, Layer, Option, Sink, Stream } from "effect"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as Checkpoints from "../src/Checkpoints.ts"

interface Response {
  readonly stdout?: string
  readonly exitCode?: number
}

/** Records every argv and answers each from a table keyed by a fragment. */
const host = (
  spawns: Array<ReadonlyArray<string>>,
  responses: ReadonlyArray<readonly [string, Response | (() => Response)]>
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
    spawn: (command) =>
      Effect.sync(() => {
        const standard = command as ChildProcess.StandardCommand
        const argv = [standard.command, ...standard.args]
        spawns.push(argv)
        const line = argv.join(" ")
        const scripted = responses.find(([fragment]) => line.includes(fragment))?.[1] ?? {}
        const found = typeof scripted === "function" ? scripted() : scripted
        const encode = (text: string) => Stream.make(new TextEncoder().encode(text))
        const stdout = encode(found.stdout ?? "")
        const stderr = encode("")
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

const store = (
  spawns: Array<ReadonlyArray<string>>,
  responses: ReadonlyArray<readonly [string, Response | (() => Response)]>,
  options: Checkpoints.GitOptions = { root: "/work/repo" }
) => Effect.provide(Checkpoints.makeGit(options), host(spawns, responses))

const failureOf = <A>(exit: Exit.Exit<A, unknown>) =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) as { code?: string; message?: string } | undefined
    : undefined

const materialized: Checkpoints.Materialized = {
  id: "cp-0-1",
  host: "/work/repo/.flows-checkpoints/cp-0-1",
  guest: "/testbed/.flows-checkpoints/cp-0-1",
  root: "/work/repo",
  guestRoot: "/testbed"
}

/** The checkout of one id, as this store spells it. */
const checkout = (id: string, commit: string) => [
  `git -C /work/repo worktree remove --force /work/repo/.flows-checkpoints/${id}`,
  `git -C /work/repo -c worktree.useRelativePaths=true worktree add --detach --force /work/repo/.flows-checkpoints/${id} ${commit}`
]

/**
 * The repository-format read taken before every checkout, so the store can
 * restore exactly what stood if the checkout stamps the repository.
 */
const formatRead = [
  "git -C /work/repo config --local --get core.repositoryformatversion",
  "git -C /work/repo config --local --get extensions.relativeWorktrees"
]

describe("Checkpoints.makeGit capture", () => {
  it("records the working tree without touching the index or the worktree", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const snapshot = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["stash create", { stdout: "abc123\n" }]])
      return yield* checkpoints.capture("cp-0-1")
    }))

    // `stash create` and nothing else. `add`, `read-tree` and `write-tree` all
    // write the repository's index, and the agent's own `git diff` — the run's
    // evidence — is read off that index.
    //
    // And the commit is named in config, never with a ref: a ref is history,
    // and a checkpoint holds the agent's own edit.
    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo stash create flows checkpoint cp-0-1",
      "git -C /work/repo config --local flows-checkpoint.cp-0-1 abc123"
    ])
    expect(snapshot).toMatchObject({ id: "cp-0-1", ref: "abc123" })
  })

  it("takes HEAD when the working tree has nothing of its own to record", async () => {
    // `stash create` prints nothing for a clean tree. That is not an error and
    // must not be read as one: the tree IS the commit it is sitting on.
    const spawns: Array<ReadonlyArray<string>> = []
    const snapshot = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["stash create", { stdout: "" }],
        ["rev-parse", { stdout: "head999\n" }]
      ])
      return yield* checkpoints.capture("cp-1-0")
    }))

    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo stash create flows checkpoint cp-1-0",
      "git -C /work/repo rev-parse --verify --quiet HEAD^{commit}",
      "git -C /work/repo config --local flows-checkpoint.cp-1-0 head999"
    ])
    expect(snapshot.ref).toBe("head999")
  })

  it("refuses an id that could not safely become a ref or a directory", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [])
      return yield* checkpoints.capture("../../etc/passwd")
    })))

    expect(failureOf(exit)?.code).toBe("invalid_input")
    expect(spawns).toEqual([])
  })

  it("says so when git could not record the tree", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["stash create", { exitCode: 1 }]])
      return yield* checkpoints.capture("cp-0-0")
    })))

    expect(failureOf(exit)?.message).toContain("Could not record the working tree")
  })

  it("says so when git could not be spawned at all", async () => {
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* Effect.provide(
        Checkpoints.makeGit({ root: "/work/repo" }),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop())
      )
      return yield* checkpoints.capture("cp-0-0")
    })))

    expect(failureOf(exit)?.message).toContain("git could not run")
  })

  it("says so when the checkpoint could not be named", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["stash create", { stdout: "abc123\n" }],
        ["config --local flows-checkpoint", { exitCode: 1 }]
      ])
      return yield* checkpoints.capture("cp-0-0")
    })))

    expect(failureOf(exit)?.message).toContain("Could not name the checkpoint")
  })
})

describe("Checkpoints.makeGit materialize", () => {
  it("checks the tree out beside the repository and removes it however the call ends", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["config --local --get", { stdout: "abc123\n" }]])
      return yield* checkpoints.materialize("cp-0-1", (found) => Effect.succeed(found))
    }))

    expect(seen).toEqual({
      id: "cp-0-1",
      host: "/work/repo/.flows-checkpoints/cp-0-1",
      // No container declared, so the two names of the one directory are the
      // same name.
      guest: "/work/repo/.flows-checkpoints/cp-0-1",
      root: "/work/repo",
      guestRoot: "/work/repo"
    })
    // The scripted host answers every unmatched command with exit 0, so the
    // format read reports the marker as already present — a repository that
    // legitimately uses relative worktrees — and the store rightly leaves the
    // format alone.
    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo config --local --get flows-checkpoint.cp-0-1",
      ...formatRead,
      ...checkout("cp-0-1", "abc123"),
      "git -C /work/repo worktree remove --force /work/repo/.flows-checkpoints/cp-0-1"
    ])
  })

  it("removes the format stamp its own checkout wrote, before the call runs", async () => {
    // Git 2.48+ records the first relative checkout in the repository itself:
    // `extensions.relativeWorktrees = true`, `core.repositoryformatversion`
    // raised to 1. A pre-2.48 git that then opens the repository refuses it
    // whole — which on the r97 wave cost 15 of 45 benchmark runs every
    // in-container `git status` and `git diff` from the first `{ at: ctx.base }`
    // call onward. The repair must land before the relocated call, because the
    // call is the thing that runs git through the mount.
    const spawns: Array<ReadonlyArray<string>> = []
    let markerReads = 0
    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["config --local --get flows-checkpoint", { stdout: "abc123\n" }],
        ["--get core.repositoryformatversion", { stdout: "0\n" }],
        // Absent before the checkout, present after it: exactly what a
        // git 2.48+ relative `worktree add` leaves behind.
        ["--get extensions.relativeWorktrees", () => ({ exitCode: markerReads++ === 0 ? 1 : 0, stdout: "true\n" })]
      ])
      return yield* checkpoints.materialize(
        "cp-0-1",
        () => Effect.sync(() => spawns.push(["<the relocated call runs here>"]))
      )
    }))

    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo config --local --get flows-checkpoint.cp-0-1",
      ...formatRead,
      ...checkout("cp-0-1", "abc123"),
      "git -C /work/repo config --local --get extensions.relativeWorktrees",
      "git -C /work/repo config --local --unset extensions.relativeWorktrees",
      "git -C /work/repo config --local core.repositoryformatversion 0",
      "<the relocated call runs here>",
      "git -C /work/repo worktree remove --force /work/repo/.flows-checkpoints/cp-0-1"
    ])
  })

  it("clears a checkout a killed run left behind, so a handle keeps resolving", async () => {
    // The release runs for an interruption and not for a `SIGKILL`. A run killed
    // outright leaves the scratch checkout standing, `worktree add` refuses a
    // path that exists, and every later call at that id would then answer
    // `checkpoint_unavailable` for a handle the journal still says is good. So
    // the checkout is cleared on the way in as well as on the way out.
    const spawns: Array<ReadonlyArray<string>> = []
    const read = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["config --local --get", { stdout: "abc123\n" }],
        // What git says about the leftover: it removes it, and the add that
        // would have failed against it succeeds.
        ["worktree remove", { exitCode: 0 }]
      ])
      return yield* checkpoints.materialize("cp-0-1", (found) => Effect.succeed(found.host))
    }))

    expect(read).toBe("/work/repo/.flows-checkpoints/cp-0-1")
    expect(spawns.map((argv) => argv.join(" ")).filter((line) => line.includes("worktree"))).toEqual([
      ...checkout("cp-0-1", "abc123"),
      "git -C /work/repo worktree remove --force /work/repo/.flows-checkpoints/cp-0-1"
    ])
  })

  it("keeps clearing on the way in when nothing is there to clear", async () => {
    // The common case: `worktree remove` fails because the path is not a
    // worktree, and that failure is not the run's problem.
    const spawns: Array<ReadonlyArray<string>> = []
    const read = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["config --local --get", { stdout: "abc123\n" }],
        // git's answer when the path is not a worktree, which is not the run's
        // problem: the checkout it was going to clear was never there.
        ["worktree remove", { exitCode: 128 }]
      ])
      return yield* checkpoints.materialize("cp-0-1", (found) => Effect.succeed(found.id))
    }))

    expect(read).toBe("cp-0-1")
  })

  it("removes the checkout when the call inside it fails", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["config --local --get", { stdout: "abc123\n" }]])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.fail("the call failed"))
    })))

    expect(Exit.isFailure(exit)).toBe(true)
    // A run killed at its wall-clock budget would otherwise leave a second
    // checkout of the whole repository inside the tree whose diff is its answer.
    expect(spawns.at(-1)?.join(" ")).toContain("worktree remove --force")
  })

  it("gives the container's name for the directory when the host declared one", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["config --local --get", { stdout: "abc123\n" }]], {
        root: "/work/repo",
        cwd: "/testbed"
      })
      return yield* checkpoints.materialize("cp-0-1", (found) => Effect.succeed(found))
    }))

    // One directory, two names: the host checks it out under the workspace, and
    // the container sees it at the same subpath under its bind mount. That is
    // the whole reason the scratch lives inside the workspace.
    expect(seen.host).toBe("/work/repo/.flows-checkpoints/cp-0-1")
    expect(seen.guest).toBe("/testbed/.flows-checkpoints/cp-0-1")
  })

  it("resolves the base id against the capture base, then HEAD", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["capture-base", { stdout: "base999\n" }]])
      return yield* checkpoints.materialize(Checkpoints.baseId, () => Effect.void)
    }))

    expect(spawns[0]?.join(" ")).toContain("refs/flows/capture-base^{commit}")
  })

  it("falls back to HEAD when no capture base was recorded", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["HEAD^", { stdout: "head999\n" }]])
      return yield* checkpoints.materialize(Checkpoints.baseId, () => Effect.void)
    }))

    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo rev-parse --verify --quiet refs/flows/capture-base^{commit}",
      "git -C /work/repo rev-parse --verify --quiet HEAD^{commit}",
      ...formatRead,
      ...checkout("base", "head999"),
      "git -C /work/repo worktree remove --force /work/repo/.flows-checkpoints/base"
    ])
  })

  it("takes only the declared base ref when the host named one", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [], { root: "/work/repo", baseRef: "refs/flows/absent" })
      return yield* checkpoints.materialize(Checkpoints.baseId, () => Effect.void)
    })))

    // A declared ref that does not resolve is an error rather than a fallback:
    // a baseline against the wrong tree answers the question wrong, which is
    // worse than not answering it.
    expect(failureOf(exit)?.code).toBe("not_found")
    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo rev-parse --verify --quiet refs/flows/absent^{commit}"
    ])
  })

  it("refuses an id that could not safely become a directory", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [])
      return yield* checkpoints.materialize("../escape", () => Effect.void)
    })))

    expect(failureOf(exit)?.code).toBe("invalid_input")
    expect(spawns).toEqual([])
  })

  it("says so when the checkout itself failed", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["config --local --get", { stdout: "abc123\n" }],
        ["worktree add", { exitCode: 128 }]
      ])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.void)
    })))

    expect(failureOf(exit)?.message).toContain("Could not check out checkpoint cp-0-1")
  })
})

describe("Checkpoints.makeNoop", () => {
  it("says plainly that this host pins nothing", async () => {
    const noop = Checkpoints.makeNoop()
    const captured = await Effect.runPromise(Effect.exit(noop.capture("cp-0-0")))
    const held = await Effect.runPromise(Effect.exit(noop.materialize("cp-0-0", () => Effect.void)))

    expect(failureOf(captured)?.code).toBe("provider_unavailable")
    expect(failureOf(held)?.message).toContain("Take the reading on the live tree instead")
  })

  it("is provided as a layer, for a host with no version control at all", async () => {
    const exit = await Effect.runPromise(Effect.exit(
      Effect.gen(function*() {
        const checkpoints = yield* Checkpoints.Checkpoints
        return yield* checkpoints.capture("cp-0-0")
      }).pipe(Effect.provide(Checkpoints.layerNoop))
    ))

    expect(failureOf(exit)?.code).toBe("provider_unavailable")
  })

  it("is what the layer constructor builds, given a store", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const snapshot = await Effect.runPromise(
      Effect.gen(function*() {
        const checkpoints = yield* Checkpoints.Checkpoints
        return yield* checkpoints.capture("cp-0-0")
      }).pipe(
        Effect.provide(Checkpoints.layerGit({ root: "/work/repo" })),
        Effect.provide(host(spawns, [["stash create", { stdout: "abc123\n" }]]))
      )
    )

    expect(snapshot.id).toBe("cp-0-0")
  })

  it("builds a store from an implementation", async () => {
    const built = Checkpoints.make({
      capture: (id) => Effect.succeed(new Checkpoints.Snapshot({ id, ref: `custom/${id}` })),
      materialize: (id, use) => use({ id, host: `/h/${id}`, guest: `/g/${id}`, root: "/h", guestRoot: "/g" })
    })

    expect((await Effect.runPromise(built.capture("x"))).ref).toBe("custom/x")
    expect(await Effect.runPromise(built.materialize("x", (found) => Effect.succeed(found.guest)))).toBe("/g/x")
  })
})

describe("Checkpoints.relocate", () => {
  it("points a shell call at the checkpoint's own directory", () => {
    expect(Checkpoints.relocate("bash", { mode: "unhermetic", command: "bin/test" }, materialized)).toEqual({
      _tag: "Relocated",
      input: { mode: "unhermetic", command: "bin/test", cwd: "/work/repo/.flows-checkpoints/cp-0-1" }
    })
  })

  it("gives a containerised shell call the path the container will resolve", () => {
    // The container reaches the workspace through a mount, so it reaches the
    // scratch checkout at the same subpath under that mount. `bash` says which
    // side it is on by naming a container, so this reads the same field.
    expect(
      Checkpoints.relocate(
        "bash",
        { mode: "unhermetic", command: "bin/test", container: "swebench-1" },
        materialized
      )
    ).toEqual({
      _tag: "Relocated",
      input: {
        mode: "unhermetic",
        command: "bin/test",
        container: "swebench-1",
        cwd: "/testbed/.flows-checkpoints/cp-0-1"
      }
    })
  })

  it("overrides a cwd the caller supplied, because at is where the call runs", () => {
    expect(Checkpoints.relocate("bash", { command: "x", cwd: "/elsewhere" }, materialized)).toEqual({
      _tag: "Relocated",
      input: { command: "x", cwd: "/work/repo/.flows-checkpoints/cp-0-1" }
    })
    // Including one that climbs out of the workspace: a checkpoint is a copy of
    // the tree and holds no copy of anywhere else, so there is no subpath to
    // keep and the tree itself is the whole of what can be offered.
    expect(Checkpoints.relocate("bash", { command: "x", cwd: "../sibling" }, materialized)).toMatchObject({
      input: { cwd: "/work/repo/.flows-checkpoints/cp-0-1" }
    })
  })

  it("keeps the subdirectory a shell call named, on both sides of the mount", () => {
    // The failure this closes is a false baseline. django's suite is run as
    // `./runtests.py` from `tests/`; dropping that `tests/` runs it at the
    // repository top, where the script does not exist, and the non-zero exit
    // reads as "the check fails on the pinned tree" when nothing was checked at
    // all. A checkpoint that manufactures a failing baseline is worse than no
    // checkpoint.
    expect(
      Checkpoints.relocate("bash", { command: "./runtests.py", cwd: "tests" }, materialized)
    ).toMatchObject({ input: { cwd: "/work/repo/.flows-checkpoints/cp-0-1/tests" } })
    // The same directory named absolutely, from inside the container.
    expect(
      Checkpoints.relocate(
        "bash",
        { command: "./runtests.py", cwd: "/testbed/tests", container: "swebench-1" },
        materialized
      )
    ).toMatchObject({ input: { cwd: "/testbed/.flows-checkpoints/cp-0-1/tests" } })
    // And named absolutely on the host, which is the same question asked of the
    // other of the two names.
    expect(
      Checkpoints.relocate("bash", { command: "x", cwd: "/work/repo/sympy/stats" }, materialized)
    ).toMatchObject({ input: { cwd: "/work/repo/.flows-checkpoints/cp-0-1/sympy/stats" } })
    // The workspace root itself names no subdirectory, under either name.
    for (const cwd of ["/work/repo", "/work/repo/", ".", "./"]) {
      expect(Checkpoints.relocate("bash", { command: "x", cwd }, materialized)).toMatchObject({
        input: { cwd: "/work/repo/.flows-checkpoints/cp-0-1" }
      })
    }
  })

  it("treats an empty container name as no container", () => {
    expect(Checkpoints.relocate("bash", { command: "x", container: "" }, materialized)).toMatchObject({
      input: { cwd: "/work/repo/.flows-checkpoints/cp-0-1" }
    })
  })

  it("prefixes a reader's relative path with the checkpoint's directory", () => {
    // These flows resolve their subject against the workspace root, and the
    // checkpoint is a directory under it, so the prefix is workspace-relative.
    expect(Checkpoints.relocate("read", { path: "sympy/stats/crv_types.py" }, materialized)).toEqual({
      _tag: "Relocated",
      input: { path: ".flows-checkpoints/cp-0-1/sympy/stats/crv_types.py" }
    })
    expect(Checkpoints.relocate("ls", { path: "sympy" }, materialized)).toMatchObject({
      input: { path: ".flows-checkpoints/cp-0-1/sympy" }
    })
    expect(Checkpoints.relocate("grep", { pattern: "def _cdf", root: "sympy/stats" }, materialized)).toMatchObject({
      input: { pattern: "def _cdf", root: ".flows-checkpoints/cp-0-1/sympy/stats" }
    })
    expect(Checkpoints.relocate("glob", { pattern: "**/*.py", root: "sympy/" }, materialized)).toMatchObject({
      input: { pattern: "**/*.py", root: ".flows-checkpoints/cp-0-1/sympy" }
    })
  })

  it("takes the checkpoint's own directory when the reader names no root", () => {
    for (const named of [{}, { root: "" }, { root: "." }]) {
      expect(Checkpoints.relocate("grep", { pattern: "x", ...named }, materialized)).toMatchObject({
        input: { root: ".flows-checkpoints/cp-0-1" }
      })
    }
  })

  it("refuses an absolute path rather than guessing which prefix names the tree", () => {
    // An absolute path in these runs is a container path, and the host cannot
    // know which part of it is the repository.
    expect(Checkpoints.relocate("read", { path: "/testbed/a.py" }, materialized)).toEqual({
      _tag: "AbsolutePath",
      path: "/testbed/a.py"
    })
  })

  it("refuses a reader's path that climbs back out into the live tree", () => {
    // `.flows-checkpoints/cp-0-1/../../mod.py` is `mod.py` in the live tree.
    // Rewriting it would hand the cell the very work it took the reading to
    // avoid, under the checkpoint's own name — and because the checkpoint is
    // folded into the call key, that live reading would replay as a pinned one
    // for the rest of the run.
    for (const path of ["../../mod.py", "../..", "a/../../../mod.py", "./../../mod.py"]) {
      expect(Checkpoints.relocate("read", { path }, materialized)).toEqual({ _tag: "OutsideTree", path })
    }
    expect(Checkpoints.relocate("grep", { pattern: "x", root: "../.." }, materialized)).toEqual({
      _tag: "OutsideTree",
      path: "../.."
    })
    // A `..` that stays inside is arithmetic, not an escape, and resolves.
    expect(Checkpoints.relocate("read", { path: "sympy/../mod.py" }, materialized)).toMatchObject({
      input: { path: ".flows-checkpoints/cp-0-1/mod.py" }
    })
  })

  it("refuses a flow that names what it touches with something other than a path", () => {
    expect(Checkpoints.relocate("read", { path: 7 }, materialized)).toEqual({ _tag: "UnsupportedFlow" })
  })

  it("treats an input that is not an object as naming nothing, and takes the checkpoint itself", () => {
    expect(Checkpoints.relocate("read", "a.py", materialized)).toMatchObject({
      input: { path: ".flows-checkpoints/cp-0-1" }
    })
  })

  it("refuses every flow the table does not name, `test` included", () => {
    for (const flow of ["edit", "write", "apply_patch", "remember", "webfetch"]) {
      expect(Checkpoints.relocate(flow, {}, materialized)).toEqual({ _tag: "UnsupportedFlow" })
    }
    // `test` answers this exact question already, with `against: "base"`. Two
    // mechanisms pointed at one tree are two answers that can disagree.
    expect(Checkpoints.relocate("test", { selection: [] }, materialized)).toEqual({ _tag: "UnsupportedFlow" })
  })
})
