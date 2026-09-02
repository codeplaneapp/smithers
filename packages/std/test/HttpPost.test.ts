import * as HttpClient from "@smthrs/kernel/HttpClient"
import { Cause, Effect, Exit, Layer } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as HttpPost from "../src/HttpPost.ts"
import { MAX_OUTPUT_BYTES } from "../src/internal/Text.ts"

const responseStub = (body: BodyInit, status = 200) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request)
        return HttpClientResponse.fromWeb(request, new Response(body, { status }))
      })
    )
  )
  return { layer, requests }
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  return exit.cause.reasons.find(Cause.isFailReason)?.error
}

describe("HttpPost", () => {
  it("returns HTTP error statuses as successful values with their body", async () => {
    const stub = responseStub("server detail", 500)
    const result = await Effect.runPromise(
      HttpPost.run({ url: "https://example.test/failure", body: "{}" }).pipe(Effect.provide(stub.layer))
    )

    expect(result).toEqual({ status: 500, body: "server detail", truncated: false })
  })

  it("truncates display output with exact UTF-8 byte accounting", async () => {
    const source = `${"x".repeat(MAX_OUTPUT_BYTES - 1)}😀`
    const stub = responseStub(source)
    const result = await Effect.runPromise(
      HttpPost.run({ url: "https://example.test/large", body: "{}" }).pipe(Effect.provide(stub.layer))
    )

    expect(result.body).toBe("x".repeat(MAX_OUTPUT_BYTES - 1))
    expect(result).toMatchObject({
      truncated: true,
      notice: `Showing ${MAX_OUTPUT_BYTES - 1} of ${MAX_OUTPUT_BYTES + 3} bytes; output was truncated.`
    })
  })

  it("refuses a response that exceeds the bounded capture before decoding", async () => {
    const stub = responseStub("x".repeat(5 * 1024 * 1024 + 1))
    const exit = await Effect.runPromise(
      Effect.exit(
        HttpPost.run({ url: "https://example.test/too-large", body: "{}" }).pipe(Effect.provide(stub.layer))
      )
    )

    expect(failureOf(exit)).toMatchObject({ code: "response_too_large" })
  })

  it("defaults content-type, sends the body, and lets a colliding header override it", async () => {
    const defaults = responseStub("ok")
    await Effect.runPromise(
      HttpPost.run({ url: "https://example.test/default", body: "{\"ok\":true}" }).pipe(
        Effect.provide(defaults.layer)
      )
    )
    expect(defaults.requests[0]?.headers["content-type"]).toBe("application/json")
    expect(defaults.requests[0]?.body._tag).toBe("Uint8Array")
    if (defaults.requests[0]?.body._tag === "Uint8Array") {
      expect(new TextDecoder().decode(defaults.requests[0].body.body)).toBe("{\"ok\":true}")
    }

    const collision = responseStub("ok")
    await Effect.runPromise(
      HttpPost.run({
        url: "https://example.test/collision",
        body: "payload",
        contentType: "application/json",
        headers: { "content-type": "text/plain", "x-recorded": "yes" }
      }).pipe(Effect.provide(collision.layer))
    )
    expect(collision.requests[0]?.headers["content-type"]).toBe("text/plain")
    expect(collision.requests[0]?.headers["x-recorded"]).toBe("yes")
  })

  it.each([
    ["file", "file:///etc/passwd"],
    ["data", "data:text/plain,hello"],
    ["ftp", "ftp://example.test/file"],
    ["protocol-relative", "//example.test/file"],
    ["malformed", "http://[::1"],
    ["userinfo", "https://user:pass@example.test/private"]
  ])("rejects %s URLs before dispatch", async (_kind, url) => {
    const stub = responseStub("unexpected")
    const exit = await Effect.runPromise(
      Effect.exit(HttpPost.run({ url, body: "{}" }).pipe(Effect.provide(stub.layer)))
    )

    expect(failureOf(exit)).toMatchObject({ code: "invalid_input", path: url })
    expect(stub.requests).toHaveLength(0)
  })

  it.each([
    ["http", "http://example.test/resource"],
    ["https", "https://example.test/resource"],
    ["IPv6", "http://[::1]/resource"]
  ])("dispatches ordinary %s URLs", async (_kind, url) => {
    const stub = responseStub("ok")
    const result = await Effect.runPromise(HttpPost.run({ url, body: "{}" }).pipe(Effect.provide(stub.layer)))

    expect(result.body).toBe("ok")
    expect(stub.requests).toHaveLength(1)
  })
})
