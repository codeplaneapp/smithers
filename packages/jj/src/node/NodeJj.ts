/**
 * Node.js `Jj` layer for programs that snapshot and restore workspace state.
 *
 * The exported layers satisfy the platform-independent `Jj` service by shelling
 * out to the `jj` CLI. There are two, and the difference between them is who
 * owns the child process:
 *
 * - {@link layer} spawns through `node:child_process` directly. `jj`
 *   invocations are argv arrays with no shell interpretation, and a host must
 *   be able to checkpoint work even where a spawner is unavailable, sandboxed,
 *   or gated behind a `proc:spawn` grant the user has not given.
 * - {@link layerSpawner} spawns through Effect's `ChildProcessSpawner`, so a
 *   host that decorates that service decorates jj as well. That is what puts a
 *   jj child in its own process group, in `@smthrs/kernel`'s `ProcessLedger`,
 *   and within reach of the reaper that sweeps a crashed incarnation: a
 *   `jj snapshot` that hangs is otherwise a process no host can account for.
 *   `@smthrs/platform-node`'s contained host bundle uses this one.
 *
 * Errors are classified from `jj`'s own stderr vocabulary onto the stable
 * `JjError` codes, the same way `NodeFileSystem` classifies errno, and both
 * layers share that classification.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as PlatformError from "effect/PlatformError"
import * as Stream from "effect/Stream"
import * as EffectChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as ChildProcess from "node:child_process"
import { Jj, JjError } from "../Jj.ts"

interface Output {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const classify = (method: string, output: Output): JjError => {
  const text = `${output.stderr}\n${output.stdout}`.toLowerCase()
  const code: JjError["code"] = text.includes("conflict")
    ? "conflict"
    : text.includes("no such revision") || text.includes("revision not found") || text.includes("doesn't exist")
        // A malformed revision ("Failed to parse revset: Syntax error") is an
        // invalid ref, exactly as the wasm layer classifies it — the code is
        // durable identity in journals, so the two layers must agree.
        || text.includes("failed to parse revset")
    ? "invalid_ref"
    : "unknown"
  return new JjError({ code, message: `jj ${method}: ${output.stderr.trim() || output.stdout.trim()}` })
}

/**
 * Mirrors the wasm layer's guard in `resolve_revision` (`crates/flows-jj`):
 * an empty revision string is `invalid_ref` before anything is spawned —
 * `jj`'s own answer would be a clap usage error that classifies `unknown`,
 * and the two layers must agree on durable error identity.
 */
const requireRevision = (method: string, revision: string): Effect.Effect<string, JjError> =>
  revision.length === 0
    ? Effect.fail(new JjError({ code: "invalid_ref", message: `jj ${method}: empty revision string` }))
    : Effect.succeed(revision)

/** How one `jj` invocation reaches the operating system. */
type Run = (method: string, args: ReadonlyArray<string>, cwd?: string) => Effect.Effect<string, JjError>

/** Turns a finished invocation into either its stdout or a classified failure. */
const settle = (method: string, output: Output): Effect.Effect<string, JjError> =>
  output.exitCode === 0 ? Effect.succeed(output.stdout) : Effect.fail(classify(method, output))

/** Runs `jj` with argv (never a shell string) in `cwd`. */
const jj: Run = (method, args, cwd) =>
  Effect.callback<Output, JjError>((resume) => {
    const child = ChildProcess.spawn("jj", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (error: NodeJS.ErrnoException) =>
      resume(Effect.fail(
        error.code === "ENOENT"
          ? new JjError({ code: "not_installed", message: "jj: command not found on PATH", cause: error })
          : new JjError({ code: "unknown", message: `jj ${method}: ${error.message}`, cause: error })
      )))
    child.on("close", (exitCode: number | null) => resume(Effect.succeed({ stdout, stderr, exitCode: exitCode ?? 1 })))
    return Effect.sync(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    })
  }).pipe(Effect.flatMap((output) => settle(method, output)))

/**
 * Runs `jj` through a `ChildProcessSpawner`.
 *
 * The classification is the same as {@link jj}'s, including the `not_installed`
 * answer: a spawner reports a missing binary as a `NotFound` `PlatformError`,
 * which is `ENOENT` with a different name on it.
 */
const viaSpawner = (spawner: ChildProcessSpawner["Service"]): Run => (method, args, cwd) =>
  Effect.scoped(
    Effect.gen(function*() {
      const handle = yield* spawner.spawn(
        EffectChildProcess.make("jj", [...args], cwd === undefined ? {} : { cwd })
      )
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode
        ],
        { concurrency: 3 }
      )
      return { stdout, stderr, exitCode }
    })
  ).pipe(
    Effect.catch((error: PlatformError.PlatformError) =>
      Effect.fail(
        error.reason._tag === "NotFound"
          ? new JjError({ code: "not_installed", message: "jj: command not found on PATH", cause: error })
          : new JjError({ code: "unknown", message: `jj ${method}: ${error.message}`, cause: error })
      )
    ),
    Effect.flatMap((output) => settle(method, output))
  )

// == operations

/**
 * Every `Jj` operation over one way of running `jj`.
 *
 * The two layers below differ only in the `run` they are given, so the
 * command vocabulary and the error classification have exactly one definition:
 * a jj child that goes through a host spawner must behave the same as one that
 * does not, or the containment story would be bought with a behavior change.
 */
const operations = (run: Run) => {
  /**
   * `jj` snapshots the working copy on every command, so a snapshot is a
   * describe of the current change followed by a `new` to open a fresh one.
   * The change id returned is the one just closed, the state callers will
   * `restore` to.
   */
  const snapshot = (message?: string) =>
    run("snapshot", message === undefined ? ["describe", "--quiet"] : ["describe", "-m", message, "--quiet"]).pipe(
      Effect.andThen(run("snapshot", ["log", "-r", "@", "--no-graph", "-T", "change_id.short()"])),
      Effect.tap(() => run("snapshot", ["new", "--quiet"])),
      Effect.map((changeId) => ({ changeId: changeId.trim() }))
    )

  const restore = (changeId: string) =>
    Effect.asVoid(
      Effect.flatMap(
        requireRevision("restore", changeId),
        (revision) => run("restore", ["restore", "--from", revision])
      )
    )

  const diff = (from: string, to: string) =>
    Effect.flatMap(
      Effect.all([requireRevision("diff", from), requireRevision("diff", to)]),
      ([fromRevision, toRevision]) => run("diff", ["diff", "--from", fromRevision, "--to", toRevision, "--git"])
    )

  const workspaceAdd = (name: string, path: string, revision?: string) =>
    Effect.asVoid(
      revision === undefined
        ? run("workspaceAdd", ["workspace", "add", "--name", name, path])
        : Effect.flatMap(requireRevision("workspaceAdd", revision), (pinned) =>
          run("workspaceAdd", ["workspace", "add", "--name", name, "--revision", pinned, path]))
    )

  const workspaceForget = (name: string) => Effect.asVoid(run("workspaceForget", ["workspace", "forget", name]))

  const status = () => run("status", ["status"])

  /**
   * `jj root` prints the workspace root for whatever directory it runs in,
   * which is the same answer walking up looking for `.jj` would give and one jj
   * is allowed to change its mind about (colocated repositories, workspaces).
   */
  const root = (from: string) => Effect.map(run("root", ["root"], from), (output) => output.trim())

  /**
   * A revert is `jj revert --insert-before @`: the reverse of the change is
   * inserted underneath the working copy, so the working copy holds the
   * reverted tree instead of holding a commit that undoes it somewhere else in
   * the graph.
   *
   * The paths are read BEFORE the revert runs. They are the paths the reverted
   * change touched, which is what the caller means by "what was undone", and
   * reading them first keeps the answer independent of where the revert lands.
   */
  const revert = (changeId: string) =>
    Effect.flatMap(
      requireRevision("revert", changeId),
      (revision) =>
        run("revert", ["diff", "-r", revision, "--name-only"]).pipe(
          Effect.flatMap((names) =>
            Effect.as(
              run("revert", ["revert", "-r", revision, "--insert-before", "@"]),
              {
                reverted: names.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
              }
            )
          )
        )
    )

  return { snapshot, restore, diff, workspaceAdd, workspaceForget, status, root, revert }
}

/**
 * Provides the `Jj` service backed by the `jj` CLI, spawning its own children.
 *
 * This is the layer for a program that has no spawner to offer, so it starts
 * its children outside whatever kill policy a host has decided on: a `jj` this
 * layer starts leads no process group the host recorded, appears in no
 * `ProcessLedger`, and is not reaped by a later incarnation of a host that
 * died holding it.
 *
 * That is a bounded exposure rather than a leak, and the bound is what makes
 * this layer usable at all. Every command below is short-lived and starts no
 * long-lived children of its own — each one writes to a pipe, so jj starts no
 * pager — and the invocation holds the handle it started, so cancelling a
 * flow signals the process rather than losing it
 * (`packages/jj/test/NodeJjLifetime.test.ts`). A host that wants the process
 * GROUP contained, and a record a crash leaves behind, composes
 * {@link layerSpawner} under a contained spawner instead;
 * `@smthrs/platform-node`'s `NodeHost.layerContained` does exactly that.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<Jj> = Layer.succeed(Jj)(operations(jj))

/**
 * Provides the `Jj` service backed by the `jj` CLI, spawning through the host's
 * `ChildProcessSpawner`.
 *
 * Use this one wherever the host contains what it starts. A jj child spawned
 * around the spawner leads no process group the host recorded, appears in no
 * `ProcessLedger`, and is never reaped, so a `jj` that hangs after the host
 * dies is a process nothing on the machine can account for. Routing it through
 * the spawner puts it under whatever policy the host has already decided on.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerSpawner: Layer.Layer<Jj, never, ChildProcessSpawner> = Layer.effect(
  Jj,
  Effect.map(ChildProcessSpawner, (spawner) => operations(viaSpawner(spawner)))
)
