/**
 * The dispatcher: a plain service over a resolved plugin list, generic over the
 * hook interface.
 *
 * Governing contract: D11 in `docs/pages/design-decisions.md`. Each
 * host holds an instance over its augmented `FlowsHooks` and may dispatch only
 * the runtime catalog it supplied. The shipped cell host owns the three
 * waterfalls declared in `packages/agent/src/CellPlugin.ts`; there is
 * no engine-wide lifecycle dispatcher.
 *
 * Cancellation is fiber interruption via scope closure; nothing here threads an
 * `AbortSignal`.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type { ArgsOf, ContextOf, KeysOfKind, SuccessOf } from "./Hooks.ts"
import type { FlowsHooks } from "./index.ts"
import { PluginError } from "./PluginError.ts"
import type { HandlerRecord, Resolved } from "./Resolve.ts"

const empty: ReadonlyArray<HandlerRecord> = Object.freeze([])

const runHandler = (
  record: HandlerRecord,
  args: ReadonlyArray<unknown>
): Effect.Effect<unknown, PluginError, any> =>
  Effect.suspend(() => record.handler(...args) as Effect.Effect<unknown, unknown, any>).pipe(
    Effect.catchCause((cause) =>
      Effect.fail(
        new PluginError({
          code: "hook_failed",
          message: `hook "${record.hook}" failed in plugin "${record.plugin}"`,
          plugin: record.plugin,
          hook: record.hook,
          cause
        })
      )
    )
  )

/**
 * The dispatch surface.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service<H = FlowsHooks> {
  /** The resolved list this dispatcher walks. */
  readonly resolved: Resolved<H>
  /** Frozen, ordered handler records for a hook. */
  readonly handlers: (hook: string) => ReadonlyArray<HandlerRecord>
  /** Runs every handler in resolved order, one at a time. */
  readonly sequential: <K extends KeysOfKind<H, "sequential">>(
    hook: K,
    ...args: ArgsOf<H[K]>
  ) => Effect.Effect<ReadonlyArray<SuccessOf<H[K]>>, PluginError, ContextOf<H[K]>>
  /**
   * Runs every handler concurrently, ignoring results. Never fails: handler
   * failures are returned so the caller can report them at its own boundary.
   */
  readonly parallel: <K extends KeysOfKind<H, "parallel">>(
    hook: K,
    ...args: ArgsOf<H[K]>
  ) => Effect.Effect<ReadonlyArray<PluginError>, never, ContextOf<H[K]>>
  /** Runs handlers in order until one returns `Option.some`. */
  readonly first: <K extends KeysOfKind<H, "first">>(
    hook: K,
    ...args: ArgsOf<H[K]>
  ) => Effect.Effect<SuccessOf<H[K]>, PluginError, ContextOf<H[K]>>
  /** Threads a value through every handler, merging each returned patch. */
  readonly waterfall: <K extends KeysOfKind<H, "waterfall">>(
    hook: K,
    initial: ArgsOf<H[K]>[0],
    merge: (previous: ArgsOf<H[K]>[0], patch: Exclude<SuccessOf<H[K]>, void>) => ArgsOf<H[K]>[0]
  ) => Effect.Effect<ArgsOf<H[K]>[0], PluginError, ContextOf<H[K]>>
}

/**
 * Builds a dispatcher over an already resolved plugin list.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <H = FlowsHooks>(resolved: Resolved<H>): Service<H> => {
  const handlers = (hook: string): ReadonlyArray<HandlerRecord> => resolved.handlers.get(hook) ?? empty

  const sequential = ((hook: string, ...args: Array<unknown>) =>
    Effect.gen(function*() {
      const results: Array<unknown> = []
      for (const record of handlers(hook)) {
        results.push(yield* runHandler(record, args))
      }
      return results
    })) as Service<H>["sequential"]

  const parallel = ((hook: string, ...args: Array<unknown>) =>
    Effect.forEach(
      handlers(hook),
      (record) =>
        runHandler(record, args).pipe(
          Effect.match({ onFailure: (error) => [error], onSuccess: () => [] as Array<PluginError> })
        ),
      { concurrency: "unbounded" }
    ).pipe(Effect.map((chunks) => chunks.flat()))) as Service<H>["parallel"]

  const first = ((hook: string, ...args: Array<unknown>) =>
    Effect.gen(function*() {
      for (const record of handlers(hook)) {
        const result = yield* runHandler(record, args)
        if (Option.isOption(result) && Option.isSome(result)) return result
      }
      return Option.none()
    })) as unknown as Service<H>["first"]

  const waterfall =
    ((hook: string, initial: unknown, merge: (previous: unknown, patch: unknown) => unknown) =>
      Effect.gen(function*() {
        let value = initial
        for (const record of handlers(hook)) {
          const patch = yield* runHandler(record, [value])
          if (patch !== undefined && patch !== null) value = merge(value, patch)
        }
        return value
      })) as Service<H>["waterfall"]

  return { resolved, handlers, sequential, parallel, first, waterfall }
}

/**
 * A dispatcher with no plugins at all.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = <H = FlowsHooks>(): Service<H> => make<H>({ plugins: Object.freeze([]), handlers: new Map() })

/**
 * The shared dispatcher, as a service tag.
 *
 * A host that augments `FlowsHooks` shares this tag; augmentation affects the
 * type surface while the runtime catalog still bounds what can resolve.
 *
 * @category context
 * @since 0.1.0
 */
export class Plugins extends Context.Service<Plugins, Service>()("flows/plugin/Plugins") {}

/**
 * Layer providing a dispatcher over an already resolved plugin list.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (resolved: Resolved): Layer.Layer<Plugins> => Layer.succeed(Plugins)(make(resolved))

/**
 * Layer providing a dispatcher with no plugins.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Plugins> = Layer.succeed(Plugins)(makeNoop())
