import * as Credential from "@smthrs/control/Credential"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import { Effect, Layer, Redacted } from "effect"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as ExaWebSearch from "../src/ExaWebSearch.ts"
import * as WebSearch from "../src/WebSearch.ts"

describe("WebSearch", () => {
  it("uses a provider service and keeps credentials outside flow input", async () => {
    const provider = WebSearch.make({
      search: () => Effect.succeed({ results: [{ title: "Result", url: "https://example.com", snippet: "Recorded" }] })
    })
    const output = await Effect.runPromise(
      WebSearch.run({ query: "recorded" }).pipe(Effect.provide(Layer.succeed(WebSearch.WebSearch, provider)))
    )
    expect(output.results).toEqual([{ title: "Result", url: "https://example.com", snippet: "Recorded" }])
    expect(Object.keys(WebSearch.Input.fields)).not.toContain("credential")
  })

  it("fails with the stable missing-provider error", async () => {
    const cause = await Effect.runPromiseExit(
      WebSearch.run({ query: "missing" }).pipe(Effect.provide(WebSearch.layerNoop))
    )
    expect(cause._tag).toBe("Failure")
  })

  it("normalizes a recorded Exa response using a named credential", async () => {
    const body = readFileSync(new URL("./fixtures/websearch/exa-success.json", import.meta.url), "utf8")
    const requests: Array<Readonly<{ readonly url: string; readonly headers: Readonly<Record<string, string>> }>> = []
    const reference = { id: "exa", name: "Exa" }
    const credentials = Credential.Credential.of({
      list: () => Effect.succeed([reference]),
      get: () => Effect.succeed(reference),
      create: () => Effect.succeed(reference),
      resolve: () => Effect.succeed(Redacted.make("recorded-secret")),
      rotate: () => Effect.succeed(reference),
      revoke: () => Effect.void
    })
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request)
        return HttpClientResponse.fromWeb(
          request,
          new Response(body, { status: 200, headers: { "content-type": "application/json" } })
        )
      })
    )
    const providerLayer = ExaWebSearch.layer("exa").pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(Credential.Credential, credentials),
          Layer.succeed(HttpClient.HttpClient, http)
        )
      )
    )
    const output = await Effect.runPromise(
      WebSearch.run({ query: "recorded", numResults: 1 }).pipe(Effect.provide(providerLayer))
    )

    expect(output.results).toEqual([{
      title: "Recorded result",
      url: "https://example.com/recorded",
      snippet: "Recorded fixture result.",
      publishedAt: "2026-01-01T00:00:00.000Z"
    }])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://api.exa.ai/search")
    expect(requests[0]?.headers.authorization).toBe("Bearer recorded-secret")
  })
})
