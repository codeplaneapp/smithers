/**
 * HTTP POST flow declaration and portable handler.
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
 * Registry name for the http-post flow.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const name = "http-post"

/**
 * Model-facing description of the http-post flow.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const description =
  "Post a text body to an absolute URL and return the response; this is irreversible because the remote side may already have acted."

/**
 * Input schema for the http-post flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  url: Schema.String.annotate({ description: "Absolute http or https URL to post to" }),
  body: Schema.String.annotate({ description: "Request body sent verbatim" }),
  contentType: Schema.optional(Schema.String).annotate({
    description: "Request content type; defaults to application/json"
  }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Additional request headers"
  })
})

/**
 * Output schema for the http-post flow.
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
 * Static effect envelope for the http-post flow.
 *
 * @category effects
 * @since 0.1.0
 */
export const effects = envelope({ tier: "irreversible", mode: "expected", reads: [], writes: [] })

/**
 * Narrows the http-post effect envelope for one decoded input.
 *
 * Network reach is expressed as a capability rather than a path envelope, so
 * a post has nothing left to narrow.
 *
 * @category effects
 * @since 0.1.0
 */
export const effectsFor = (_input: typeof Input.Type) => effects

/**
 * Capabilities required by the http-post flow.
 *
 * @category capabilities
 * @since 0.1.0
 */
export const capabilities = [capability("net:post", "*")]

/**
 * Declaration-only http-post flow.
 *
 * @category flows
 * @since 0.1.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

const isAbsolute = (url: string): boolean => {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

const requestError = (url: string, error: unknown): StdError.StdError =>
  new StdError.StdError({
    code: "request_failed",
    message: `Request failed: ${url}${error instanceof Error ? ` (${error.message})` : ""}`
  })

/**
 * Posts a body through the permission-aware kernel HTTP client.
 *
 * @category handlers
 * @since 0.1.0
 */
export const run = Effect.fn("HttpPost.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, HttpClient.HttpClient> {
  if (!isAbsolute(input.url)) {
    return yield* Effect.fail(
      new StdError.StdError({ code: "invalid_input", message: `Not an absolute URL: ${input.url}` })
    )
  }
  const client = yield* HttpClient.HttpClient
  const request = HttpClientRequest.post(input.url).pipe(
    HttpClientRequest.setHeaders({
      "content-type": input.contentType ?? "application/json",
      ...input.headers
    }),
    HttpClientRequest.bodyText(input.body)
  )
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
