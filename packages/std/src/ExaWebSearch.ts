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
const ExaResult = Schema.Struct({
  title: Schema.optional(Schema.String),
  url: Schema.String,
  text: Schema.optional(Schema.String),
  publishedDate: Schema.optional(Schema.String)
})
const ExaResponse = Schema.Struct({
  results: Schema.optional(Schema.Array(ExaResult))
})
const freshnessDays = {
  day: 1,
  week: 7,
  month: 31,
  year: 365
} as const

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
              Effect.mapError(() =>
                new StdError.StdError({ code: "request_failed", message: "Exa search request failed" })
              )
            )
            const json = yield* response.json.pipe(
              Effect.mapError(() =>
                new StdError.StdError({ code: "request_failed", message: "Exa search response was invalid" })
              )
            )
            const body = yield* Schema.decodeUnknownEffect(ExaResponse)(json).pipe(
              Effect.mapError(() =>
                new StdError.StdError({ code: "request_failed", message: "Exa search response was invalid" })
              )
            )
            return {
              results: (body.results ?? []).slice(0, Math.min(input.numResults ?? 8, maxResults)).map((result) => ({
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
