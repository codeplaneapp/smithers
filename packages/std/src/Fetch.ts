/**
 * HTTP GET flow declaration and portable handler.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { capability, envelope } from "./internal/Declaration.ts"
import { MAX_OUTPUT_BYTES, notice, truncateBytes } from "./internal/Text.ts"
import * as StdError from "./StdError.ts"

/**
 * Registry name for the fetch flow.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const name = "fetch"

/**
 * Model-facing description of the fetch flow.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const description =
  "Get an absolute URL and return its status and text body; long bodies are truncated with a notice. Use http-post to send data."

/**
 * Input schema for the fetch flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  url: Schema.String.annotate({ description: "Absolute http or https URL to retrieve" }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Additional request headers"
  })
})

/**
 * Output schema for the fetch flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Output = Schema.Struct({
  status: Schema.Number.annotate({ description: "HTTP status code, including error statuses" }),
  body: Schema.String.annotate({ description: "Response body as text" }),
  truncated: Schema.Boolean.annotate({ description: "Whether the body exceeded the display budget" }),
  notice: Schema.optional(Schema.String.annotate({ description: "Truncation disclosure" }))
})

/**
 * Static effect envelope for the fetch flow.
 *
 * A retrieval leaves no durable state behind, so it is sealed even though it
 * leaves the machine.
 *
 * @category effects
 * @since 0.1.0
 */
export const effects = envelope({ tier: "sealed", mode: "expected", reads: [], writes: [] })

/**
 * Narrows the fetch effect envelope for one decoded input.
 *
 * Network reach is expressed as a capability rather than a path envelope, so
 * a retrieval has nothing left to narrow.
 *
 * @category effects
 * @since 0.1.0
 */
export const effectsFor = (_input: typeof Input.Type) => effects

/**
 * Capabilities required by the fetch flow.
 *
 * @category capabilities
 * @since 0.1.0
 */
export const capabilities = [capability("net:get", "*")]

/**
 * Declaration-only fetch flow.
 *
 * @category flows
 * @since 0.1.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return undefined
  }
}

const requestError = (url: string, error: unknown): StdError.StdError =>
  new StdError.StdError({
    code: "request_failed",
    message: `Request failed: ${url}${error instanceof Error ? ` (${error.message})` : ""}`
  })

/**
 * Retrieves a URL through the permission-aware kernel HTTP client.
 *
 * Error statuses are ordinary results; only transport, permission, and body
 * decoding failures use the typed error channel.
 *
 * @category handlers
 * @since 0.1.0
 */
export const run = Effect.fn("Fetch.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, HttpClient.HttpClient> {
  if (hostOf(input.url) === undefined) {
    return yield* Effect.fail(
      new StdError.StdError({ code: "invalid_input", message: `Not an absolute URL: ${input.url}` })
    )
  }
  const client = yield* HttpClient.HttpClient
  const request = input.headers === undefined
    ? HttpClientRequest.get(input.url)
    : HttpClientRequest.setHeaders(HttpClientRequest.get(input.url), input.headers)
  const response = yield* client.execute(request).pipe(
    Effect.mapError((error) => requestError(input.url, error))
  )
  const text = yield* response.text.pipe(Effect.mapError((error) => requestError(input.url, error)))
  const rendered = truncateBytes(text, MAX_OUTPUT_BYTES, { keep: "head" })
  return {
    status: response.status,
    body: rendered.text,
    truncated: rendered.truncated,
    ...(rendered.truncated
      ? { notice: notice("bytes", MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES + rendered.droppedBytes) }
      : {})
  }
})
