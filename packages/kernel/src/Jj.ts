/**
 * Permission-aware Jujutsu version-control operations.
 *
 * There is no kernel `Jj` interface and no kernel `Jj` tag. `@smthrs/jj` owns
 * both, and its error channel already names the failures the kernel adds, so
 * this module is only the middleware: a `Layer` over the same tag that reads
 * the raw service out of context and returns a guarded one in its place.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md`,
 * `docs/specs/Concepts/Effect Taxonomy.md`, and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 0.1.0
 */
import { make as makeCapability } from "@smthrs/capability/Capability"
import { Jj } from "@smthrs/jj"
import { Effect, FileSystem as EffectFileSystem, Layer, Path as EffectPath } from "effect"
import { canonicalResource } from "./FileSystem.ts"
import { GrantStore } from "./GrantStore.ts"
import { Workspace } from "./Workspace.ts"

/**
 * The Jujutsu service — `@smthrs/jj`'s tag, unchanged. Re-exported so the
 * kernel namespace stays one-stop; it is the *same* tag, never a second one.
 *
 * @category services
 * @since 0.1.0
 */
export { Jj } from "@smthrs/jj"

/**
 * Provides an unavailable Jujutsu stub.
 *
 * @category layers
 * @since 0.1.0
 */
export { layerNoop } from "@smthrs/jj"

/**
 * Constructs a Jujutsu service from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export { make } from "@smthrs/jj"

/**
 * Constructs an unavailable Jujutsu stub.
 *
 * @category constructors
 * @since 0.1.0
 */
export { makeNoop } from "@smthrs/jj"

/**
 * Decorates the Jujutsu service in place with operation-specific capability
 * checks.
 *
 * The layer provides the tag it also requires: compose it over a host jj layer
 * with `Layer.provide` and every consumer of `Jj` — including one that never
 * heard of the kernel — resolves the guarded implementation.
 *
 * `workspaceAdd` canonicalizes its destination through the *raw* filesystem
 * before asking for `jj:workspace-add` and `fs:write`, so an existing symlink
 * cannot turn an inside-workspace grant into outside authority.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<
  Jj,
  never,
  Jj | EffectFileSystem.FileSystem | EffectPath.Path | Workspace | GrantStore
> = Layer.effect(
  Jj,
  Effect.gen(function*() {
    const jj = yield* Jj
    const fileSystem = yield* EffectFileSystem.FileSystem
    const path = yield* EffectPath.Path
    const workspace = yield* Workspace
    const grants = yield* GrantStore
    return Jj.of({
      status: Effect.fn("Jj.status")(() =>
        grants.check(makeCapability("jj:status", ".")).pipe(Effect.andThen(jj.status()))
      ),
      diff: Effect.fn("Jj.diff")((from, to) =>
        grants.check(makeCapability("jj:diff", `${from}:${to}`)).pipe(Effect.andThen(jj.diff(from, to)))
      ),
      snapshot: Effect.fn("Jj.snapshot")((message) =>
        grants.check(makeCapability("jj:snapshot", message ?? "")).pipe(Effect.andThen(jj.snapshot(message)))
      ),
      restore: Effect.fn("Jj.restore")((changeId) =>
        grants.check(makeCapability("jj:restore", changeId)).pipe(Effect.andThen(jj.restore(changeId)))
      ),
      workspaceAdd: Effect.fn("Jj.workspaceAdd")((name, destination, revision) =>
        canonicalResource(fileSystem, path, workspace.root, destination).pipe(
          Effect.flatMap((resource) =>
            grants.check(makeCapability("jj:workspace-add", resource)).pipe(
              Effect.andThen(grants.check(makeCapability("fs:write", resource))),
              Effect.andThen(
                jj.workspaceAdd(
                  name,
                  path.normalize(path.isAbsolute(destination) ? destination : path.resolve(workspace.root, destination)),
                  revision
                )
              )
            )
          )
        )
      ),
      workspaceForget: Effect.fn("Jj.workspaceForget")((name) =>
        grants.check(makeCapability("jj:workspace-forget", name)).pipe(Effect.andThen(jj.workspaceForget(name)))
      )
    })
  })
)
