/**
 * Permission-aware process spawning.
 *
 * `flows` has no shell service of its own — process execution is Effect's
 * `effect/unstable/process`. The only thing the kernel adds is the
 * `proc:spawn` capability check, applied to the one primitive every other
 * helper is derived from.
 *
 * There is no kernel spawner interface and no kernel spawner tag. Effect owns
 * both, and its tag fixes the error channel to `PlatformError`, so this module
 * is only the middleware: a `Layer` over Effect's own tag. A denied command is
 * projected into `PlatformError` by `Permission.toPlatformError`, which keeps
 * the structured kernel failure on the error's `cause`. Because the channel
 * stays `PlatformError`, the full six-method surface is derived from the one
 * guarded `spawn` through Effect's own `ChildProcessSpawner.make` without a
 * cast.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 0.1.0
 */
import { make as makeCapability } from "@smthrs/capability/Capability"
import { toPlatformError } from "@smthrs/capability/Permission"
import { Effect, Layer } from "effect"
import { systemError } from "effect/PlatformError"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as CommandLine from "./CommandLine.ts"
import { GrantStore } from "./GrantStore.ts"

/**
 * The process spawner service — Effect's tag, unchanged. Re-exported so the
 * kernel namespace stays one-stop; it is the *same* tag, never a second one.
 *
 * @category services
 * @since 0.1.0
 */
export { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

/**
 * Derives the full six-method surface from one `spawn`, so `exitCode`,
 * `string`, `lines`, and both `stream*` helpers can never bypass whatever
 * `spawn` was given.
 *
 * @category constructors
 * @since 0.1.0
 */
export { make } from "effect/unstable/process/ChildProcessSpawner"

/**
 * Constructs an unavailable spawner stub.
 *
 * Every derived helper reports the missing host as a `NotFound`
 * `PlatformError` naming the command line, so an unconfigured capability
 * answers rather than vanishing.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (
  overrides: Partial<ChildProcessSpawner["Service"]> = {}
): ChildProcessSpawner["Service"] => ({
  ...makeSpawner((command) =>
    Effect.fail(
      systemError({
        _tag: "NotFound",
        module: "ChildProcessSpawner",
        method: "spawn",
        description: `no process host for \`${CommandLine.render(command)}\``
      })
    )
  ),
  ...overrides
})

/**
 * Provides an unavailable spawner stub.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (
  overrides: Partial<ChildProcessSpawner["Service"]> = {}
): Layer.Layer<ChildProcessSpawner> => Layer.succeed(ChildProcessSpawner)(makeNoop(overrides))

/**
 * Decorates the process spawner in place with a `proc:spawn` capability check.
 *
 * The check is suspended into the spawn itself, so building a `Command` or a
 * stream neither requests permission nor starts a process; only running one
 * does. The capability resource is the command line `CommandLine.render`
 * produces, which is also what line-oriented adapters execute for commands
 * they support. Custom shell paths are included explicitly in the resource;
 * browser and remote adapters reject them rather than silently substituting a
 * different shell.
 *
 * The layer provides the tag it also requires: compose it over a host spawner
 * layer with `Layer.provide` and a `ChildProcess.Command` run as a plain
 * `Effect` is checked too.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<ChildProcessSpawner, never, ChildProcessSpawner | GrantStore> = Layer.effect(
  ChildProcessSpawner,
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const grants = yield* GrantStore
    const check = (command: ChildProcess.Command) =>
      Effect.suspend(() => {
        const rendered = CommandLine.render(command)
        return grants.check(makeCapability("proc:spawn", rendered), {
          cwd: CommandLine.cwd(command)
        }).pipe(
          Effect.mapError((error) =>
            toPlatformError({
              module: "ChildProcessSpawner",
              method: "spawn",
              pathOrDescriptor: rendered,
              error
            })
          )
        )
      })
    return makeSpawner(
      Effect.fn("ChildProcessSpawner.spawn")((command: ChildProcess.Command) =>
        check(command).pipe(Effect.andThen(spawner.spawn(command)))
      )
    )
  })
)
