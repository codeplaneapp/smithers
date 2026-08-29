/**
 * @since 0.1.0
 *
 * The `Jj` service: version control as a Host capability.
 *
 * `flows` snapshots the working copy around every step, so jj is not a tool the
 * agent happens to call — it is host access, and it goes through a layer like
 * every other. Contract only; module shape follows `effect/FileSystem`.
 *
 * The error lives here rather than in a shared host error module so that a
 * consumer who only snapshots a working copy does not pull in a process
 * spawner or an HTTP client. The one thing this package does import is
 * `@smthrs/capability`, the leaf that names the permission failures a guarded
 * `Jj` adds; it depends on nothing but `effect` either.
 *
 * The tag key and the error `_tag` are durable identity: step keys digest the
 * resolved service set, and `JjError` round-trips through the journal, so
 * renaming either invalidates recorded runs.
 */
import type * as Permission from "@smthrs/capability/Permission"
import { Context, Effect, Layer, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"

/**
 * Why a jj operation failed, as a closed and stable set.
 *
 * `not_installed` — no usable jj on this host. `conflict` — the repository
 * refused because the operation would conflict. `invalid_ref` — the change id
 * or revision does not resolve. `unknown` — everything else jj reported.
 *
 * These codes are public contract: callers branch on them, step keys digest
 * them, and UIs map them to remediation. Add a code; never repurpose one.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const JjErrorCode = Schema.Literals(["not_installed", "conflict", "invalid_ref", "unknown"])

/**
 * The value form of {@link JjErrorCode}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type JjErrorCode = typeof JjErrorCode.Type

/**
 * A jj failure, shaped after `effect/PlatformError`: a stable `code` reason,
 * the `module` and `method` that failed, and a human `message`.
 *
 * Codes are a STABLE public contract: callers branch on them, step keys digest
 * them, UIs map them to remediation. Never repurpose a code — add one.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class JjError extends Schema.TaggedError<JjError>()("@smthrs/jj/JjError", {
  code: JjErrorCode,
  module: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  message: Schema.String,
  /** The jj command that produced the failure, when one was run. */
  command: Schema.optional(Schema.String),
  /** The underlying host failure, carried whole rather than flattened away. */
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * Creates a `JjError` from a failed jj operation, composing the human
 * `message` from the code, the failing `module.method`, and the optional
 * description so every jj failure reads the same way.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const jjError = (options: {
  readonly code: JjErrorCode
  readonly module?: string | undefined
  readonly method: string
  readonly description?: string | undefined
  readonly command?: string | undefined
}): JjError => {
  const module = options.module ?? "Jj"
  return new JjError({
    code: options.code,
    module,
    method: options.method,
    message: `${options.code}: ${module}.${options.method}${options.description ? `: ${options.description}` : ""}`,
    command: options.command
  })
}

/**
 * Refines a failure to jj's own error, so a caller can tell "jj said no" from
 * "the capability kernel said no" without matching on `_tag` by hand.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export const isJjError = (error: unknown): error is JjError =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "@smthrs/jj/JjError"

/**
 * A jj change id — the durable handle a run uses to name workspace state.
 *
 * It is a bare string alias rather than a branded type because it crosses the
 * journal and the process boundary as one, and the value jj prints is the
 * value we store.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ChangeId = string

/**
 * Everything a `Jj` operation can fail with.
 *
 * `flows` runs jj behind the capability kernel, so the honest error channel of
 * this contract is jj's own failure *plus* the three the kernel adds. The
 * interface declares them here, in the package that owns the service, rather
 * than being redeclared and re-tagged by `@smthrs/kernel`: one interface, one
 * tag, and a caller that holds `Jj` cannot forget a snapshot may be denied.
 *
 * `@smthrs/capability` is a leaf that depends on nothing but `effect`, so
 * naming these here keeps this package browser-bundleable and keeps the
 * kernel → jj dependency acyclic.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type JjFailure = JjError | Permission.PermissionError

/**
 * Version control as a host capability: snapshot the working copy, restore it,
 * diff two revisions, and manage the workspaces parallel agents run in.
 *
 * It is deliberately small — only the operations `flows` needs to make a step
 * reversible — and every method's error channel is {@link JjFailure}, so a
 * caller cannot forget that a snapshot may be denied by the permission kernel
 * rather than by jj.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Jj {
  /** Commits the working copy and returns the change id to restore to later. */
  readonly snapshot: (message?: string) => Effect.Effect<{ readonly changeId: ChangeId }, JjFailure>
  /** Puts the working copy back to `changeId`. */
  readonly restore: (changeId: ChangeId) => Effect.Effect<void, JjFailure>
  /** Unified diff between two revisions. */
  readonly diff: (from: ChangeId, to: ChangeId) => Effect.Effect<string, JjFailure>
  /**
   * Adds a named workspace rooted at `path` — one lane per parallel agent.
   *
   * When `revision` is given, the new workspace is pinned at that revision
   * instead of the lane default, which is how a fork lands the child on the
   * frame's recorded pointer without touching the parent's working copy.
   *
   * `PlatformError` is in the channel because the guarded implementation
   * canonicalizes `path` against the workspace root before it asks for the
   * `jj:workspace-add` and `fs:write` capabilities, and resolving a path is a
   * filesystem operation that can itself fail.
   */
  readonly workspaceAdd: (
    name: string,
    path: string,
    revision?: ChangeId
  ) => Effect.Effect<void, JjFailure | PlatformError>
  /** Drops a named workspace, without touching the commits made in it. */
  readonly workspaceForget: (name: string) => Effect.Effect<void, JjFailure>
  /** The working copy's status, as jj prints it. */
  readonly status: () => Effect.Effect<string, JjFailure>
}

/**
 * The service key for {@link Jj}. The tag string is durable identity — step
 * keys digest the resolved service set — so renaming it invalidates recorded
 * runs.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export const Jj: Context.Service<Jj, Jj> = Context.Service("@smthrs/jj/Jj")

/**
 * Brands an implementation as the {@link Jj} service, so a new backend is
 * checked where it is written rather than where it is provided.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (impl: Jj): Jj => Jj.of(impl)

/**
 * Creates a stub `Jj` for tests. Every method fails with `JjError`
 * `not_installed` until overridden.
 *
 * The failing default is the point: a test that stubs only `snapshot` gets a
 * named failure the moment the code under test reaches `restore`, instead of a
 * silent success.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Jj>): Jj => {
  const missing = (method: string) =>
    Effect.fail(
      jjError({ code: "not_installed", method, description: "jj is not available on this host" })
    )
  return Jj.of({
    snapshot: () => missing("snapshot"),
    restore: () => missing("restore"),
    diff: () => missing("diff"),
    workspaceAdd: () => missing("workspaceAdd"),
    workspaceForget: () => missing("workspaceForget"),
    status: () => missing("status"),
    ...overrides
  })
}

/**
 * Provides {@link makeNoop} as the `Jj` layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Jj>): Layer.Layer<Jj> => Layer.succeed(Jj)(makeNoop(overrides))
