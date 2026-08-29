/**
 * Node.js `Jj` layer for programs that snapshot and restore workspace state.
 *
 * The exported layer satisfies the platform-independent `Jj` service by
 * shelling out to the `jj` CLI. It deliberately spawns its own child processes
 * rather than going through `Shell`: `jj` invocations are argv arrays with no
 * shell interpretation, and the host must be able to checkpoint work even where
 * a user-facing shell is unavailable or sandboxed.
 *
 * Errors are classified from `jj`'s own stderr vocabulary onto the stable
 * `JjError` codes, the same way `NodeFileSystem` classifies errno.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
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

/** Runs `jj` with argv (never a shell string) in `cwd`. */
const jj = (method: string, args: ReadonlyArray<string>, cwd?: string): Effect.Effect<string, JjError> =>
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
  }).pipe(
    Effect.flatMap((output) =>
      output.exitCode === 0 ? Effect.succeed(output.stdout) : Effect.fail(classify(method, output))
    )
  )

// == operations

/**
 * `jj` snapshots the working copy on every command, so a snapshot is a describe
 * of the current change followed by a `new` to open a fresh one. The change id
 * returned is the one just closed — the state callers will `restore` to.
 */
const snapshot = (message?: string) =>
  jj("snapshot", message === undefined ? ["describe", "--quiet"] : ["describe", "-m", message, "--quiet"]).pipe(
    Effect.andThen(jj("snapshot", ["log", "-r", "@", "--no-graph", "-T", "change_id.short()"])),
    Effect.tap(() => jj("snapshot", ["new", "--quiet"])),
    Effect.map((changeId) => ({ changeId: changeId.trim() }))
  )

const restore = (changeId: string) =>
  Effect.asVoid(
    Effect.flatMap(requireRevision("restore", changeId), (revision) => jj("restore", ["restore", "--from", revision]))
  )

const diff = (from: string, to: string) =>
  Effect.flatMap(
    Effect.all([requireRevision("diff", from), requireRevision("diff", to)]),
    ([fromRevision, toRevision]) => jj("diff", ["diff", "--from", fromRevision, "--to", toRevision, "--git"])
  )

const workspaceAdd = (name: string, path: string, revision?: string) =>
  Effect.asVoid(
    revision === undefined
      ? jj("workspaceAdd", ["workspace", "add", "--name", name, path])
      : Effect.flatMap(requireRevision("workspaceAdd", revision), (pinned) =>
        jj("workspaceAdd", ["workspace", "add", "--name", name, "--revision", pinned, path]))
  )

const workspaceForget = (name: string) => Effect.asVoid(jj("workspaceForget", ["workspace", "forget", name]))

const status = () => jj("status", ["status"])

/**
 * Provides the `Jj` service backed by the `jj` CLI.
 *
 * @category layers
 * @since 1.0.0
 * @slop
 */
export const layer: Layer.Layer<Jj> = Layer.succeed(Jj)({
  snapshot,
  restore,
  diff,
  workspaceAdd,
  workspaceForget,
  status
})
