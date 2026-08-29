import * as HttpClient from "@smthrs/kernel/HttpClient"
import { Effect, Layer } from "effect"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { toMarkdown, toText } from "../src/internal/Html.ts"
import * as WebFetch from "../src/WebFetch.ts"

const responseLayer = (
  body: BodyInit,
  headers: Readonly<Record<string, string>>
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status: 200, headers }))
      )
    )
  )

describe("WebFetch", () => {
  it("declares bounded HTTP retrieval with all supported render formats", () => {
    expect(WebFetch.capabilities).toEqual(["net:get:*"])
    expect(toText("<h1>Article</h1><script>ignored()</script><p>Hello &amp; goodbye.</p>")).toBe(
      "Article\nHello & goodbye."
    )
    expect(toMarkdown("<h1>Article</h1><p>Hello <strong>world</strong>.</p>")).toBe("# Article\n\nHello **world**.")
  })

  it("fetches a recorded HTML response through the kernel client", async () => {
    const html = readFileSync(new URL("./fixtures/webfetch/article.html", import.meta.url), "utf8")
    const output = await Effect.runPromise(
      WebFetch.run({ url: "https://example.test/article", format: "markdown" }).pipe(
        Effect.provide(responseLayer(html, { "content-type": "text/html" }))
      )
    )
    expect(output).toMatchObject({
      url: "https://example.test/article",
      status: 200,
      contentType: "text/html",
      content: "# Article\n\nHello **world**."
    })
  })

  it("stops streaming once a response exceeds the byte cap", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        WebFetch.run({ url: "https://example.test/large" }).pipe(
          Effect.provide(responseLayer("x".repeat(5 * 1024 * 1024 + 1), { "content-type": "text/plain" }))
        )
      )
    )
    expect(failure).toMatchObject({
      code: "response_too_large"
    })
  })
})
