/**
 * Governing plan:
 * `docs/specs/Research/Agent Ecosystem Plan 2026-07-28.md`.
 *
 * @since 0.1.0
 */
import * as Credential from "@smthrs/control/Credential"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import { Clock, Effect, Layer, Redacted, Schema } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as StdError from "./StdError.ts"
import * as WebSearch from "./WebSearch.ts"

const maxResults = 20
const requestTimeoutMs = 30_000
const ExaResult = Schema.Struct({
  title: Schema.optional(Schema.String),
  url: Schema.String,
  text: Schema.optional(Schema.String),
  publishedDate: Schema.optional(Schema.String)
})
const ExaResponse = Schema.Struct({
  results: Schema.Array(ExaResult)
})
const freshnessDays = {
  day: 1,
  week: 7,
  month: 31,
  year: 365
} as const

const failure = (code: StdError.Code, message: string): StdError.StdError => new StdError.StdError({ code, message })

const header = (headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined =>
  headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()]

/**
 * Provides {@link WebSearch.WebSearch} backed by the Exa API, reading its
 * key from the named credential.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  credentialId: string
): Layer.Layer<WebSearch.WebSearch, never, Credential.Credential | HttpClient.HttpClient> =>
  Layer.effect(
    WebSearch.WebSearch,
    Effect.gen(function*() {
      const credentials = yield* Credential.Credential
      const http = yield* HttpClient.HttpClient
      return WebSearch.make({
        search: (input): Effect.Effect<typeof WebSearch.Output.Type, StdError.StdError> =>
          Effect.gen(function*() {
            const reference = yield* credentials.get(credentialId).pipe(Effect.mapError(() =>
              new StdError.StdError({
                code: "provider_unavailable",
                message: "Configured Exa credential is unavailable"
              })
            ))
            const secret = yield* credentials.resolve(reference).pipe(Effect.mapError(() =>
              new StdError.StdError({
                code: "provider_unavailable",
                message: "Configured Exa credential cannot be resolved"
              })
            ))
            const now = yield* Clock.currentTimeMillis
            const request = HttpClientRequest.setHeaders(
              yield* HttpClientRequest.bodyJson(HttpClientRequest.post("https://api.exa.ai/search"), {
                query: input.query,
                numResults: Math.min(input.numResults ?? 8, maxResults),
                ...(input.freshness === undefined
                  ? {}
                  : { startPublishedDate: new Date(now - freshnessDays[input.freshness] * 86_400_000).toISOString() })
              }).pipe(
                Effect.mapError(() =>
                  new StdError.StdError({ code: "request_failed", message: "Exa search request could not be encoded" })
                )
              ),
              { "authorization": `Bearer ${Redacted.value(secret)}`, "content-type": "application/json" }
            )
            const response = yield* http.execute(request).pipe(
              Effect.timeout(requestTimeoutMs),
              Effect.mapError((error) =>
                error._tag === "TimeoutError"
                  ? failure("timeout", "Exa search request timed out")
                  : failure("request_failed", "Exa search request failed")
              )
            )
            const retryAfter = header(response.headers, "retry-after")
            // `Retry-After` is pacing advice, not an outcome: a CDN or proxy
            // may attach it to a perfectly good 200, and reading it alone
            // discarded a decoded result set as a `timeout`. It only tells us
            // the request was refused when the status already says so, so the
            // header is consulted for its wording and the status decides.
            const refused = response.status < 200 || response.status >= 300
            if (response.status === 429 || (refused && retryAfter !== undefined)) {
              return yield* Effect.fail(
                failure(
                  "timeout",
                  retryAfter === undefined
                    ? "Exa search was throttled"
                    : `Exa search was throttled; retry after ${retryAfter}`
                )
              )
            }
            if (response.status === 401 || response.status === 403) {
              return yield* Effect.fail(failure("provider_unavailable", "Exa search authentication was rejected"))
            }
            if (response.status >= 500) {
              return yield* Effect.fail(failure("provider_unavailable", `Exa search returned ${response.status}`))
            }
            if (response.status < 200 || response.status >= 300) {
              return yield* Effect.fail(failure("request_failed", `Exa search returned ${response.status}`))
            }
            const json = yield* response.json.pipe(
              Effect.timeout(requestTimeoutMs),
              Effect.mapError((error) =>
                error._tag === "TimeoutError"
                  ? failure("timeout", "Exa search response timed out")
                  : failure("request_failed", "Exa search response was invalid")
              )
            )
            const body = yield* Schema.decodeUnknownEffect(ExaResponse)(json).pipe(
              Effect.mapError(() =>
                new StdError.StdError({ code: "request_failed", message: "Exa search response was invalid" })
              )
            )
            return {
              results: body.results.slice(0, Math.min(input.numResults ?? 8, maxResults)).map((result) => ({
                title: result.title ?? result.url,
                url: result.url,
                snippet: (result.text ?? "").slice(0, 2_000),
                ...(result.publishedDate === undefined ? {} : { publishedAt: result.publishedDate })
              }))
            }
          })
      })
    })
  )
