/**
 * Governing plan:
 * `docs/specs/Research/Agent Ecosystem Plan 2026-07-28.md`.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import { Context, Effect, Layer, Schema } from "effect"
import { capability, envelope } from "./internal/Declaration.ts"
import * as StdError from "./StdError.ts"

/**
 * The registry name of the `websearch` flow.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const name = "websearch"
/**
 * The one-line description the model sees for the `websearch` flow.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const description = "Search the web through a configured provider and return normalized results."
/**
 * What the `websearch` flow accepts.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  query: Schema.NonEmptyString.annotate({ description: "Search query" }),
  numResults: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))).annotate({
    description: "Maximum number of results, from 1 through 20; defaults to 8"
  }),
  freshness: Schema.optional(Schema.Literals(["day", "week", "month", "year"])).annotate({
    description: "Optional age limit for published results"
  })
})
/**
 * One search hit, normalized across providers.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Result = Schema.Struct({
  title: Schema.String.annotate({ description: "Result title" }),
  url: Schema.String.annotate({ description: "Absolute result URL" }),
  snippet: Schema.String.annotate({ description: "Provider-normalized result excerpt" }),
  publishedAt: Schema.optional(Schema.String).annotate({
    description: "Provider publication timestamp when available"
  })
})
/**
 * What the `websearch` flow returns.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Output = Schema.Struct({ results: Schema.Array(Result) })
/**
 * The declared effect envelope of the `websearch` flow, before any input is known.
 *
 * @category effects
 * @since 0.1.0
 */
export const effects = envelope({ tier: "sealed", mode: "expected", reads: [], writes: [] })
/**
 * Narrows {@link effects} to what this particular input actually touches.
 *
 * @category effects
 * @since 0.1.0
 */
export const effectsFor = (_input: typeof Input.Type) => effects
/**
 * The authority the `websearch` flow requires.
 *
 * @category capabilities
 * @since 0.1.0
 */
export const capabilities = [capability("net:post", "*")]
/**
 * The `websearch` flow declaration: schemas, capabilities, and effects, with the
 * implementation attached separately.
 *
 * @category flows
 * @since 0.1.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

/**
 * The provider seam a web search is served through.
 *
 * @category services
 * @since 0.1.0
 */
export interface WebSearch {
  readonly search: (input: typeof Input.Type) => Effect.Effect<typeof Output.Type, StdError.StdError>
}
/**
 * The {@link WebSearch} service tag.
 *
 * @category services
 * @since 0.1.0
 */
export const WebSearch: Context.Service<WebSearch, WebSearch> = Context.Service("/std/WebSearch")
/**
 * Builds a {@link WebSearch} from an implementation of its one method.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (service: WebSearch): WebSearch => WebSearch.of(service)
/**
 * A {@link WebSearch} that fails every search with `provider_unavailable`,
 * for an environment with no provider configured.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): WebSearch =>
  make({
    search: () =>
      Effect.fail(
        new StdError.StdError({ code: "provider_unavailable", message: "No web search provider is configured" })
      )
  })
/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<WebSearch> = Layer.succeed(WebSearch, makeNoop())
/**
 * Runs the `websearch` flow: searches the web through the configured provider.
 *
 * @category handlers
 * @since 0.1.0
 */
export const run = Effect.fn("WebSearch.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, WebSearch> {
  const provider = yield* WebSearch
  return yield* provider.search(input)
})
