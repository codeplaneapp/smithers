/**
 * The metadata-only projection of a discovered flow, and its lazy loader.
 *
 * @since 0.1.0
 */
import type * as Flow from "@smthrs/core/Flow"
import { isFlow } from "@smthrs/core/Flow"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import { FsError } from "./FsError.ts"

/**
 * How a route's body is stored on disk.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Kind = "module" | "markdown" | "skill"

/**
 * A path-derived command route.
 *
 * Everything here comes from registry discovery, which never evaluates a flow
 * module. Materializing the flow is {@link load}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Route {
  readonly name: string
  readonly segments: ReadonlyArray<string>
  readonly kind: Kind
  readonly sourcePath: string
  readonly description: Option.Option<string>
  readonly input: Descriptor.SchemaRef
  readonly output: Descriptor.SchemaRef
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Descriptor.EffectDeclaration
  readonly modelInvocable: boolean
  readonly placement: Option.Option<Descriptor.Placement>
  readonly ui: Option.Option<string>
}

/**
 * The name of a route, as a `/`-joined path.
 *
 * Applications that generate a typed route manifest widen this through
 * declaration merging; the portable default is any string.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Name = string

/**
 * The decoded input accepted by a named route.
 *
 * @category utility types
 * @since 0.1.0
 * @slop
 */
export type Input<_N extends Name> = unknown

/**
 * The decoded output returned by a named route.
 *
 * @category utility types
 * @since 0.1.0
 * @slop
 */
export type Output<_N extends Name> = unknown

const loadFailed = (route: Route, cause: unknown): FsError =>
  new FsError({
    code: "load_failed",
    method: "Route.load",
    description: `Could not load the flow module for "${route.name}"`,
    cause
  })

/**
 * Materializes the flow behind a route.
 *
 * Only module routes can be materialized here. Markdown and skill bodies are
 * loaded by the registry, which owns frontmatter and prompt parsing; routing
 * them through this adapter would duplicate that contract.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const load = (route: Route): Effect.Effect<Flow.Any, FsError> =>
  Effect.gen(function*() {
    if (route.kind !== "module") {
      return yield* Effect.fail(
        new FsError({
          code: "unsupported_body",
          method: "Route.load",
          description: `Route "${route.name}" has a ${route.kind} body, which the registry loader owns`
        })
      )
    }
    const module = yield* Effect.tryPromise({
      try: () => import(/* @vite-ignore */ route.sourcePath) as Promise<{ readonly default?: unknown }>,
      catch: (cause) => loadFailed(route, cause)
    })
    const value = module.default
    if (!isFlow(value)) {
      return yield* Effect.fail(
        new FsError({
          code: "load_failed",
          method: "Route.load",
          description: `Module for "${route.name}" does not default-export a flow`
        })
      )
    }
    return value
  })
