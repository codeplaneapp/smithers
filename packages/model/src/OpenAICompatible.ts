/**
 * Route construction for providers that serve the OpenAI Responses API
 * without its native extensions. The shape is deliberately narrower than
 * {@link OpenAIResponses}: only what every compatible deployment implements.
 *
 * @since 0.1.0
 */
import * as Auth from "./Auth.ts"
import * as Endpoint from "./Endpoint.ts"
import * as Framing from "./Framing.ts"
import * as OpenAIResponses from "./OpenAIResponses.ts"
import * as Route from "./Route.ts"

/**
 * Builds an OpenAI Responses-compatible route without enabling OpenAI-native
 * deferred-tool extensions.
 *
 * ```ts
 * const groq = OpenAICompatible.make({ id: "groq", baseUrl: "https://api.groq.com/openai", apiKey })
 * ```
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = (input: {
  readonly id: string
  readonly baseUrl: string
  readonly apiKey: Auth.Redacted<string>
  readonly headers?: Readonly<Record<string, string>>
}) =>
  Result.map(Endpoint.make({ url: input.baseUrl, path: "/v1/responses" }), (endpoint) =>
    Route.make({
      id: input.id,
      protocol: { ...OpenAIResponses.protocol, supportsDeferred: () => false },
      endpoint,
      auth: Auth.bearer(input.apiKey),
      framing: Framing.sse,
      ...(input.headers === undefined ? {} : { headers: input.headers })
    }))
import * as Result from "effect/Result"
