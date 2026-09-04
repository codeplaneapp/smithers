/**
 * Pinned trees, and the scratch checkouts a call runs against.
 *
 * A checkpoint is a **value**: minting one changes nothing about the workspace,
 * and running a call against one leaves the live tree exactly as it stands.
 * That is the whole of what it buys. Before it existed, the only way a run
 * could answer "did this command fail before my change" was to undo the change
 * — and the journals price that exactly. On `sympy__sympy-13878` the r95repl
 * lane applied one byte-identical 4,789-character patch **five times**, four of
 * those applications preceded by `git checkout -- sympy/stats/crv_types.py`,
 * because a clean fails-before proof required reverting the very work it was
 * meant to prove.
 *
 * This module is the host half of `@smthrs/harness`'s `ctx.checkpoint()` and
 * `ctx.call(flow, input, { at })`. The harness owns the surface, the identity,
 * the bound and the refusals; nothing in it knows what a tree is. This owns the
 * two host operations that need one:
 *
 * - {@link Checkpoints.capture} records the working tree under an id, and
 * - {@link Checkpoints.materialize} gives that tree back as a directory for the
 *   length of one call.
 *
 * ## The git binding, and the container constraint it is shaped by
 *
 * {@link layerGit} records a checkpoint with `git stash create`, then names the
 * commit it prints in this repository's own git config rather than with a ref —
 * see {@link configSection} for why a ref would hand the agent its own edit back
 * as history. `stash create` is the one git command
 * that records the working tree and changes nothing else: it does not write the
 * repository's index, does not move the worktree, and does not touch the stash
 * ref. That matters more than it sounds. The agent runs `git` in this same
 * workspace and its own `git diff` is the run's evidence, so a capture that
 * staged into the real index would be the harness editing the evidence while
 * recording it. A tree with nothing to record prints nothing, and the
 * checkpoint is then `HEAD` — which is exactly what the tree is.
 *
 * Untracked files are not in the recorded tree, which matches how the rig
 * captures a patch: `capture-patch.sh` drops paths that did not exist when the
 * agent started, so a checkpoint holds what a patch would hold.
 *
 * The materialization is a detached worktree at `<root>/.flows-checkpoints/<id>`
 * — **inside** the workspace, which looks wrong and is the only thing that
 * works. A benchmark check runs through `docker exec` inside `/testbed`, and
 * `/testbed` is a bind mount of the live workspace. A scratch checkout anywhere
 * else on the host is simply not visible to the container, so the call would run
 * against a path that does not exist. Placed under the workspace it is visible
 * at the same subpath under the mount, needs no second mount, and needs no
 * change to how the rig starts its container. `TestRun`'s `against: "base"`
 * reached the same conclusion first and this reuses its shape;
 * `evals/swebench/run-instance.sh` excludes the directory from patch capture for
 * the same reason it excludes `.flows-test-base`.
 *
 * The worktree is added and removed around **one call**, which is stricter than
 * the frame lifetime the design asks for and much simpler: there is no cache to
 * invalidate, no id to leak, and a checkpoint used by three calls pays three
 * checkouts rather than risking one stale directory. A run that reuses a
 * checkpoint across frames simply re-materializes it, because the ref is what
 * persists.
 *
 * ## What can be pointed at a checkpoint, and what cannot
 *
 * {@link relocate} is the closed answer. `bash` names *where it runs*, so it is
 * relocated by its `cwd` — into the checkpoint, and into the same subdirectory
 * of it the call asked for, because a check declared in `tests/` that silently
 * ran at the top would come back failing for a reason nobody chose. `read`,
 * `ls`, `grep` and `glob` name *what they touch* relative to the workspace
 * root, so they are relocated by prefixing that root — and only when the path
 * they name stays inside the tree, because an absolute path in these runs is a
 * container path the host cannot rebase and a `..` path is the live tree under
 * another name. Every other flow answers `checkpoint_unsupported` through the
 * harness, including `test`, which already has `against: "base"` for exactly
 * this question and would otherwise have two mechanisms that can disagree.
 *
 * @since 0.1.0
 */
import { ChildProcessSpawner } from "@smthrs/kernel/ChildProcessSpawner"
import { Context, Effect, Layer, Schema } from "effect"
import * as Exec from "./internal/Exec.ts"
import * as StdError from "./StdError.ts"
import * as TestRunner from "./TestRunner.ts"

/**
 * The id naming the tree a run opened on.
 *
 * It is not minted: the host either recorded one before the agent started or it
 * did not. {@link layerGit} resolves it to {@link TestRunner.captureBase} and
 * then to `HEAD`, which is the same precedence `TestRun` uses for the same
 * question — so a workspace that has one answer for a baseline has one answer
 * for both.
 *
 * @category constants
 * @since 0.1.0
 */
export const baseId = "base"

/**
 * The directory checkpoints are materialized into, relative to the repository
 * root and therefore also relative to a container's view of it.
 *
 * @category constants
 * @since 0.1.0
 */
export const scratchDirectory = ".flows-checkpoints"

/**
 * The git-config section {@link layerGit} records minted checkpoints under.
 *
 * Config and **not a ref**, and that is the whole of the decision. A ref is
 * history: `git log --all` lists it, `git show` prints it, and `git log --all
 * -S` searches it — so a checkpoint named by a ref would hand an agent a commit
 * containing its own edit and let it read that back as if it were upstream
 * work. That exact class cost the measured program real money before the rig
 * moved jj's store out of the workspace (`evals/swebench/run-instance.sh`:
 * django-13346 applied two of its own snapshots as a fake fix), and a ref here
 * would reintroduce it one wave later.
 *
 * The commit object itself is unreferenced. It stays alive for the life of the
 * run — nothing in a run prunes — and `git worktree add --detach <sha>` checks
 * one out perfectly well, which is measured in `CheckpointsFixture.test.ts`. So
 * the tree is reachable by id and no command that walks refs can reach it:
 * `git log`, `git log --all`, `git log -S` and `git show <ref>` all answer
 * exactly as they did before the capture.
 *
 * Two commands still see it, and both are measured rather than argued in
 * `CheckpointsFixture.test.ts`. `git fsck` reports it as a dangling commit,
 * because that is what an unreferenced commit is; and while a checkpoint is
 * checked out, `git log --all` includes the other worktree's detached `HEAD`,
 * because `--all` spans worktrees unless `--single-worktree` says otherwise.
 * Neither is reachable by a name that looks like project history, and the cell
 * contract's environment section says outright that a dangling commit is this
 * harness holding the agent's own tree — which is the half of the django-13346
 * lesson that a store cannot enforce.
 *
 * @category constants
 * @since 0.1.0
 */
export const configSection = "flows-checkpoint"

/**
 * One tree this run has pinned.
 *
 * `ref` is the store's own name for it. Nothing above this module interprets
 * it; it travels so the journal says which tree a checkpointed call read.
 *
 * @category models
 * @since 0.1.0
 */
export class Snapshot extends Schema.Class<Snapshot>("flows/std/Checkpoints/Snapshot")({
  id: Schema.String,
  ref: Schema.String
}) {}

/**
 * A tree handed back as a directory, for the length of one call.
 *
 * `host` is where the process running on this machine finds it. `guest` is
 * where a container finds the same directory, which is the same path when no
 * container is in play. They differ exactly as `TestRunner.Runner`'s `cwd` and
 * `root` differ, and for the same reason: one directory, two names.
 *
 * `root` and `guestRoot` are the workspace itself under those same two names.
 * They travel because a call that named a directory *inside* the workspace has
 * to keep it: a check that runs in `tests/` and is pointed at a checkpoint must
 * run in the checkpoint's `tests/`, not at its top. Silently dropping that
 * subpath is how a baseline comes back failing for a reason nobody chose, which
 * is the one failure a checkpoint exists to make impossible.
 *
 * @category models
 * @since 0.1.0
 */
export interface Materialized {
  readonly id: string
  readonly host: string
  readonly guest: string
  /** The workspace this checkpoint is a tree of, as this machine names it. */
  readonly root: string
  /** The workspace as a container names it; the same as {@link Materialized.root} when none does. */
  readonly guestRoot: string
}

/**
 * The two host operations a checkpoint needs.
 *
 * @category services
 * @since 0.1.0
 */
export interface Checkpoints {
  /** Records the working tree as it stands, under `id`. */
  readonly capture: (id: string) => Effect.Effect<Snapshot, StdError.StdError>
  /**
   * Hands `id` back as a directory for the length of the effect it wraps.
   *
   * Scoped rather than returned, because the directory has to be removed
   * however the call ends — a benchmark run killed at its wall-clock budget
   * would otherwise leave a second checkout of the whole repository in a tree
   * whose diff is the run's answer.
   */
  readonly materialize: <A, E, R>(
    id: string,
    use: (materialized: Materialized) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | StdError.StdError, R>
}

/**
 * The {@link Checkpoints} service tag.
 *
 * @category services
 * @since 0.1.0
 */
export const Checkpoints: Context.Service<Checkpoints, Checkpoints> = Context.Service("/std/Checkpoints")

/**
 * Builds a store from its two operations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (service: Checkpoints): Checkpoints => Checkpoints.of(service)

/**
 * The refusal a host with nowhere to pin a tree answers with.
 *
 * @category errors
 * @since 0.1.0
 */
export const unavailable: StdError.StdError = new StdError.StdError({
  code: "provider_unavailable",
  message: "This host pins no trees, so it holds no checkpoints. Take the reading on the live tree instead."
})

/**
 * Builds a store for a host that pins nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): Checkpoints =>
  make({
    capture: () => Effect.fail(unavailable),
    materialize: () => Effect.fail(unavailable)
  })

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Checkpoints> = Layer.succeed(Checkpoints, makeNoop())

/**
 * What {@link layerGit} needs to know about the repository it pins.
 *
 * @category models
 * @since 0.1.0
 */
export interface GitOptions {
  /** The host path of the git repository whose trees are pinned. */
  readonly root: string
  /**
   * Where a container sees {@link GitOptions.root}, when one does.
   *
   * Absent means there is no container, and the guest path of a materialized
   * checkpoint is then its host path.
   */
  readonly cwd?: string | undefined
  /**
   * The ref naming the tree the run opened on, for {@link baseId}.
   *
   * Absent takes `TestRunner.captureBase` and then `HEAD`, which is the
   * precedence `TestRun` already uses.
   */
  readonly baseRef?: string | undefined
}

const failed = (message: string, code: StdError.Code = "command_failed"): StdError.StdError =>
  new StdError.StdError({ code, message })

/**
 * A checkpoint id, restricted to what can safely become a git-config key and a
 * directory name. No dots: a dot would split the config key into another
 * subsection.
 */
const namable = /^[A-Za-z0-9][A-Za-z0-9-]*$/

const trimmed = (path: string): string => path.replace(/\/+$/, "")

const git = (
  root: string,
  args: ReadonlyArray<string>
): Effect.Effect<Exec.ExecResult, StdError.StdError, ChildProcessSpawner> =>
  Exec.exec("git", { args: ["-C", root, ...args] }).pipe(
    Effect.mapError((error) => failed(`git could not run: ${error.message}`))
  )

const resolved = (
  root: string,
  refs: ReadonlyArray<string>
): Effect.Effect<{ readonly ref: string; readonly commit: string }, StdError.StdError, ChildProcessSpawner> =>
  Effect.gen(function*() {
    for (const ref of refs) {
      const answer = yield* git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
      const commit = answer.stdout.trim()
      if (answer.exitCode === 0 && commit !== "") return { ref, commit }
    }
    return yield* Effect.fail(
      failed(
        `No checkpoint is stored under ${refs.join(" or ")} in ${root}. Take the reading on the live tree instead.`,
        "not_found"
      )
    )
  })

/**
 * Builds the git-backed store.
 *
 * The capture writes through a temporary index so the workspace's own index is
 * untouched — the agent's `git diff` is the run's evidence and must not move
 * because the harness recorded something. `core.fileMode=false` matches
 * `snapshot-base.sh`: a `docker cp` extraction does not preserve permission
 * bits, so the modes recorded are the image's.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeGit = (
  options: GitOptions
): Effect.Effect<Checkpoints, never, ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    return gitStore(options, spawner)
  })

/**
 * The store itself, with the spawner it runs git through already resolved.
 *
 * Resolving it here rather than threading it through {@link Checkpoints} keeps
 * the service's own requirement empty, which is what lets a browser host bind
 * {@link layerNoop} against the identical interface — the same shape
 * `TestRunner` and `Container` take.
 */
const gitStore = (options: GitOptions, spawner: ChildProcessSpawner["Service"]): Checkpoints => {
  const spawn = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner>): Effect.Effect<A, E> =>
    Effect.provideService(effect, ChildProcessSpawner, spawner)
  const root = trimmed(options.root)
  const guestRoot = options.cwd === undefined ? root : trimmed(options.cwd)
  const keyOf = (id: string) => `${configSection}.${id}`
  const baseRefs = options.baseRef === undefined ? [TestRunner.captureBase, "HEAD"] : [options.baseRef]

  /**
   * The commit one id names.
   *
   * `base` is the one id nobody mints, so it is resolved from refs — the same
   * precedence `TestRun` uses. Every other id was recorded by {@link capture}
   * into this repository's config, which is where a checkpoint is named
   * *without* becoming history. See {@link configSection}.
   */
  const commitOf = (id: string) =>
    Effect.gen(function*() {
      if (id === baseId) return (yield* resolved(root, baseRefs)).commit
      const found = yield* git(root, ["config", "--local", "--get", keyOf(id)])
      const commit = found.stdout.trim()
      if (found.exitCode !== 0 || commit === "") {
        return yield* Effect.fail(
          failed(
            `No checkpoint is stored under ${id} in ${root}. Take the reading on the live tree instead.`,
            "not_found"
          )
        )
      }
      return commit
    })

  const capture = (id: string) =>
    spawn(Effect.gen(function*() {
      if (!namable.test(id)) {
        return yield* Effect.fail(
          failed(`A checkpoint id must match ${namable.source}; ${id} does not.`, "invalid_input")
        )
      }
      const recorded = yield* git(root, ["stash", "create", `flows checkpoint ${id}`])
      if (recorded.exitCode !== 0) {
        return yield* Effect.fail(failed(`Could not record the working tree: ${recorded.stderr.trim()}`))
      }
      // Nothing to record means the working tree IS the commit it is on, so
      // that commit is the checkpoint. `stash create` says so by printing
      // nothing, which is not an error and must not be read as one.
      const commit = recorded.stdout.trim() === ""
        ? (yield* resolved(root, ["HEAD"])).commit
        : recorded.stdout.trim()
      const named = yield* git(root, ["config", "--local", keyOf(id), commit])
      if (named.exitCode !== 0) {
        return yield* Effect.fail(failed(`Could not name the checkpoint: ${named.stderr.trim()}`))
      }
      return new Snapshot({ id, ref: commit })
    }))

  /**
   * The repository-format keys a relative `worktree add` rewrites, read before
   * the checkout so {@link restoreFormat} can put back exactly what stood.
   */
  const formatState = Effect.gen(function*() {
    const version = yield* git(root, ["config", "--local", "--get", "core.repositoryformatversion"])
    const marker = yield* git(root, ["config", "--local", "--get", "extensions.relativeWorktrees"])
    return {
      version: version.exitCode === 0 ? version.stdout.trim() : undefined,
      marked: marker.exitCode === 0
    }
  })

  /**
   * Removes the format stamp {@link materialize}'s `worktree add` wrote, when
   * it wrote one.
   *
   * Git 2.48 and later record the first relative checkout in the repository
   * itself: `extensions.relativeWorktrees = true`, and
   * `core.repositoryformatversion` raised to 1 so older git honours the
   * extensions section. Removing the worktree takes neither back — and a git
   * before 2.48 that opens a repository carrying an extension it does not know
   * refuses the whole repository, not the worktree. The benchmark containers
   * run exactly such a git against this same directory through a bind mount,
   * so the stamp must not outlive the one command that needed it. See the
   * comment inside {@link materialize} for the measured damage.
   *
   * Restores only what this checkout introduced: a marker that predates the
   * checkout belongs to the repository and is left standing, and a pre-2.48
   * git writes nothing, so there is nothing to remove.
   */
  const restoreFormat = (before: { readonly version: string | undefined; readonly marked: boolean }) =>
    Effect.gen(function*() {
      if (before.marked) return
      const marker = yield* git(root, ["config", "--local", "--get", "extensions.relativeWorktrees"])
      if (marker.exitCode !== 0) return
      const unset = yield* git(root, ["config", "--local", "--unset", "extensions.relativeWorktrees"])
      if (unset.exitCode !== 0) {
        return yield* Effect.fail(
          failed(`Could not restore the repository format after checking out a checkpoint: ${unset.stderr.trim()}`)
        )
      }
      const version = yield* git(root, ["config", "--local", "core.repositoryformatversion", before.version ?? "0"])
      if (version.exitCode !== 0) {
        return yield* Effect.fail(
          failed(`Could not restore the repository format after checking out a checkpoint: ${version.stderr.trim()}`)
        )
      }
    })

  const materialize = <A, E, R>(
    id: string,
    use: (materialized: Materialized) => Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | StdError.StdError, R> =>
    Effect.gen(function*() {
      if (!namable.test(id)) {
        return yield* Effect.fail(
          failed(`A checkpoint id must match ${namable.source}; ${id} does not.`, "invalid_input")
        )
      }
      const commit = yield* spawn(commitOf(id))
      const host = `${root}/${scratchDirectory}/${id}`
      const discard = Effect.ignore(spawn(git(root, ["worktree", "remove", "--force", host])))
      const before = yield* spawn(formatState)
      // The worktree is removed however the call ends: a run killed at its
      // wall-clock budget would otherwise leave a second checkout of the whole
      // repository inside the tree whose diff is the run's answer.
      //
      // It is removed on the way *in* as well, and that is not belt and braces.
      // A release runs for an interruption and not for a `SIGKILL`, so a run
      // killed outright leaves the checkout standing — and `worktree add`
      // refuses a path that exists, so every later call at that id would answer
      // `checkpoint_unavailable` for a handle the journal still says is good. A
      // checkpoint has to survive the kill that its own scoping cannot catch.
      //
      // `worktree.useRelativePaths` makes the checkout's `.git` file point at
      // the repository by a relative path. Without it that pointer is this
      // machine's absolute path, which does not exist inside a container, and
      // `git` run at the checkpoint through the mount answers "not a git
      // repository" — for a directory that is one. Git before 2.48 does not
      // know the key and ignores it, which costs that host nothing it had.
      //
      // A git that does know it also stamps the repository itself: the first
      // relative checkout writes `extensions.relativeWorktrees = true` and
      // raises `core.repositoryformatversion` to 1 in the workspace's own
      // config, and removing the worktree takes neither back. A pre-2.48 git
      // that then opens the repository refuses it whole — "unknown repository
      // extension found: relativeworktrees" — and the benchmark containers run
      // exactly such a git against this directory through the bind mount.
      // Measured on the r97 wave: 15 of 45 runs lost every in-container `git
      // status` and `git diff` at /testbed (exit 128 or 129) from the first
      // `{ at: ctx.base }` call onward. `restoreFormat` therefore runs before
      // `use`, so the repository the call reads — and every in-container git
      // after it — carries the format it had before the checkout. The relative
      // pointers keep working without the stamp: git resolves them regardless,
      // and the marker's only job is to warn older worktree *tooling*, which
      // no benchmark container runs.
      return yield* Effect.acquireUseRelease(
        discard.pipe(
          Effect.andThen(spawn(git(root, [
            "-c",
            "worktree.useRelativePaths=true",
            "worktree",
            "add",
            "--detach",
            "--force",
            host,
            commit
          ]))),
          Effect.flatMap((added) =>
            added.exitCode === 0
              ? Effect.void
              : Effect.fail(failed(`Could not check out checkpoint ${id}: ${added.stderr.trim()}`))
          )
        ),
        () =>
          spawn(restoreFormat(before)).pipe(
            Effect.andThen(use({ id, host, guest: `${guestRoot}/${scratchDirectory}/${id}`, root, guestRoot }))
          ),
        () => discard
      )
    })

  return make({ capture, materialize })
}

/**
 * Provides {@link makeGit}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerGit = (options: GitOptions): Layer.Layer<Checkpoints, never, ChildProcessSpawner> =>
  Layer.effect(Checkpoints)(makeGit(options))

/**
 * The flows whose input names where they run or what they read, and the field
 * that says so.
 *
 * A closed table rather than a per-flow hook, because the set is small and the
 * rule for admitting one is exact: the field has to name a location the whole
 * call is relative to. `bash` runs in a directory; the four readers resolve
 * their subject against the workspace root. Everything else — an edit, a patch,
 * a web fetch, a memory write — either names no location or writes, and both
 * are refused above this module.
 *
 * `test` is deliberately absent. It answers this exact question already, with
 * `against: "base"`, and a second mechanism pointed at the same tree is a way
 * for two answers to disagree.
 */
const located: Readonly<Record<string, { readonly field: string; readonly kind: "cwd" | "path" }>> = {
  bash: { field: "cwd", kind: "cwd" },
  read: { field: "path", kind: "path" },
  ls: { field: "path", kind: "path" },
  grep: { field: "root", kind: "path" },
  glob: { field: "root", kind: "path" }
}

/**
 * Why one input could not be pointed at a checkpoint.
 *
 * @category models
 * @since 0.1.0
 */
export type Relocation =
  | { readonly _tag: "Relocated"; readonly input: Schema.Json }
  | { readonly _tag: "UnsupportedFlow" }
  | { readonly _tag: "AbsolutePath"; readonly path: string }
  | { readonly _tag: "OutsideTree"; readonly path: string }

/**
 * Resolves `.` and `..` inside a relative path, or answers `undefined` when the
 * path climbs out of whatever it would be joined under.
 *
 * This is the whole of the isolation the reader rule can enforce, and it is not
 * optional. Prefixing blindly turns `../../mod.py` into
 * `.flows-checkpoints/cp-1-0/../../mod.py`, which is a path back into the live
 * tree — so the cell would read the work it is trying to take a baseline
 * against, the journal would record that reading under the checkpoint it named,
 * and the call key folds the checkpoint in, so the live reading would replay as
 * a pinned one forever. A proof built on it is a proof of nothing, which is the
 * exact failure this module exists to abolish.
 */
const contained = (path: string): string | undefined => {
  const parts: Array<string> = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment !== "..") {
      parts.push(segment)
      continue
    }
    if (parts.length === 0) return undefined
    parts.pop()
  }
  return parts.join("/")
}

/**
 * The part of `declared` that names a place inside `root`, or `undefined` when
 * it names somewhere the checkpoint does not hold a copy of.
 *
 * A relative path is already workspace-relative. An absolute one is compared
 * against the root on the side that issued it — a container call names the
 * mount, a host call names this machine — because that is the only prefix the
 * store can strip without guessing.
 */
const within = (root: string, declared: string): string | undefined => {
  if (!declared.startsWith("/")) return contained(declared)
  if (trimmed(declared) === root) return ""
  return declared.startsWith(`${root}/`) ? contained(declared.slice(root.length + 1)) : undefined
}

/**
 * Rewrites one call's input so the call runs against a materialized checkpoint.
 *
 * Returns the rewritten input, or the reason there is none. A `bash` call runs
 * in the checkpoint's directory — from the *guest* side when it names a
 * container, because that is the path the container will be given — and keeps
 * whatever subdirectory it asked for: a check declared in `tests/` runs in the
 * checkpoint's `tests/`. A working directory the checkpoint holds no copy of,
 * such as somewhere else on the machine, becomes the checkpoint's own top,
 * because a tree is all this can offer and there is no subpath in it to keep.
 *
 * A reader takes the checkpoint's workspace-relative directory as the prefix of
 * what it names, because these flows resolve their subject against the
 * workspace root and the checkpoint is a directory under it.
 *
 * Two paths are refused rather than rewritten, and both for the same reason —
 * the host would otherwise hand back a reading of a tree the cell did not name.
 * An absolute path in these runs is a container path, and the host cannot know
 * which prefix of it names the tree. A relative path that climbs past the
 * checkpoint with `..` names the live tree, exactly the tree the reading was
 * taken to avoid.
 *
 * @category conversions
 * @since 0.1.0
 */
export const relocate = (
  flow: string,
  input: Schema.Json,
  materialized: Materialized
): Relocation => {
  const rule = located[flow]
  if (rule === undefined) return { _tag: "UnsupportedFlow" }
  const record = input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, Schema.Json>
    : {}
  const declared = record[rule.field]
  if (rule.kind === "cwd") {
    // A container call is given the path the container will resolve; a host
    // call is given the host's. `bash` chooses which by naming a container, so
    // this reads the same field it does.
    const containerised = typeof record["container"] === "string" && record["container"] !== ""
    const base = containerised ? materialized.guest : materialized.host
    const kept = typeof declared === "string" && declared !== ""
      ? within(containerised ? materialized.guestRoot : materialized.root, declared)
      : ""
    return {
      _tag: "Relocated",
      input: { ...record, cwd: kept === undefined || kept === "" ? base : `${base}/${kept}` }
    }
  }
  const relative = `${scratchDirectory}/${materialized.id}`
  if (declared === undefined) return { _tag: "Relocated", input: { ...record, [rule.field]: relative } }
  if (typeof declared !== "string") return { _tag: "UnsupportedFlow" }
  if (declared.startsWith("/")) return { _tag: "AbsolutePath", path: declared }
  const kept = contained(declared)
  if (kept === undefined) return { _tag: "OutsideTree", path: declared }
  return { _tag: "Relocated", input: { ...record, [rule.field]: kept === "" ? relative : `${relative}/${kept}` } }
}
