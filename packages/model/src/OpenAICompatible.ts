/**
 * Route construction for providers that serve the OpenAI Responses API
 * without its native extensions. The shape is deliberately narrower than
 * {@link OpenAIResponses}: only what every compatible deployment implements.
 *
 * @since 0.1.0
 */
import * as Result from "effect/Result"
import * as Auth from "./Auth.ts"
import * as Endpoint from "./Endpoint.ts"
import * as Framing from "./Framing.ts"
import type { ModelError } from "./ModelError.ts"
import * as OpenAIResponses from "./OpenAIResponses.ts"
import * as Route from "./Route.ts"

/**
 * Builds an OpenAI Responses-compatible route without enabling OpenAI-native
 * deferred-tool extensions.
 *
 * `baseUrl` is the provider origin WITHOUT `/v1`, which this constructor
 * appends along with `/responses`.
 *
 * ```ts
 * const groq = OpenAICompatible.make({ id: "groq", baseUrl: "https://api.groq.com/openai", apiKey })
 * ```
 *
 * @deprecated Use `Route.openaiResponsesCompatible`, which is the same
 * constructor under a name that says which protocol it targets. This one and
 * `Route.openaiCompatible` share a shape but build opposite protocols from
 * differently-rooted base URLs, which is how one provider ended up configured
 * two ways in this repository.
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = (input: {
  readonly id: string
  readonly baseUrl: string
  readonly apiKey: Auth.Redacted<string>
  readonly headers?: Readonly<Record<string, string>>
}): Result.Result<
  Route.Route<
    OpenAIResponses.Body,
    string,
    Parameters<typeof OpenAIResponses.protocol.stream.step>[1],
    ReturnType<typeof OpenAIResponses.protocol.stream.initial>
  >,
  ModelError
> =>
  Result.map(Endpoint.make({ url: input.baseUrl, path: "/v1/responses" }), (endpoint) =>
    Route.make({
      id: input.id,
      protocol: { ...OpenAIResponses.protocol, supportsDeferred: () => false },
      endpoint,
      auth: Auth.bearer(input.apiKey),
      framing: Framing.sse,
      ...(input.headers === undefined ? {} : { headers: input.headers })
    }))
