import * as Result from "effect/Result"
import { describe, expect, it } from "vitest"
import * as Endpoint from "../src/Endpoint.ts"

const make = (options: Endpoint.MakeOptions): Endpoint.Endpoint => Result.getOrThrow(Endpoint.make(options))

const failureMessage = (options: Endpoint.MakeOptions): string => {
  const result = Endpoint.make(options)
  expect(Result.isFailure(result)).toBe(true)
  return Result.isFailure(result) ? result.failure.message : ""
}

describe("Endpoint", () => {
  it("joins paths and renders sorted query pairs deterministically", () => {
    const endpoint = make({
      url: "https://example.test/v1/",
      path: "/responses",
      query: [["z", "last"], ["a", "two"], ["a", "one"]]
    })

    expect(endpoint).toEqual({
      method: "POST",
      url: "https://example.test/v1/responses",
      query: [["a", "one"], ["a", "two"], ["z", "last"]]
    })
    expect(Endpoint.render(endpoint)).toBe("https://example.test/v1/responses?a=one&a=two&z=last")
  })

  it("rejects embedded userinfo credentials", () => {
    expect(failureMessage({ url: "https://user:password@example.test" })).toMatch(/credentials/)
  })

  it("rejects credential-looking query parameters", () => {
    expect(failureMessage({ url: "https://example.test/?key=secret" })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://example.test/?api_key=secret" })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://example.test", query: [["token", "secret"]] })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://example.test", query: [["signature", "secret"]] })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://example.test/?password=secret" })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://example.test", query: { sig: "secret" } })).toMatch(/credentials/)
  })

  it("rejects an unparseable URL, a fragment, and a path carrying its own query", () => {
    expect(failureMessage({ url: "not a url" })).toBe("Invalid endpoint URL: not a url")
    expect(failureMessage({ url: "" })).toBe("Invalid endpoint URL: ")
    expect(failureMessage({ url: "https://example.test/#section" })).toMatch(/fragments/)
    expect(failureMessage({ url: "https://example.test", path: "/v1?debug=1" })).toMatch(
      /must not contain query strings or fragments/
    )
    expect(failureMessage({ url: "https://example.test", path: "/v1#frag" })).toMatch(
      /must not contain query strings or fragments/
    )
    expect(failureMessage({ url: "https://user@example.test" })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://:password@example.test" })).toMatch(/credentials/)
  })

  it("accepts record query input and merges it with the URL's own pairs", () => {
    expect(make({ url: "https://example.test/?b=url", query: { a: "record" } })).toEqual({
      method: "POST",
      url: "https://example.test/",
      query: [["a", "record"], ["b", "url"]]
    })
  })

  it("orders equal names by value and keeps identical pairs stable", () => {
    const endpoint = make({
      url: "https://example.test",
      query: [["b", "2"], ["a", "9"], ["a", "1"], ["a", "9"], ["c", "3"]]
    })

    expect(endpoint.query).toEqual([["a", "1"], ["a", "9"], ["a", "9"], ["b", "2"], ["c", "3"]])
    expect(Endpoint.render(endpoint)).toBe("https://example.test/?a=1&a=9&a=9&b=2&c=3")
  })

  it("treats an absent, empty, and slash-heavy path the same way", () => {
    expect(make({ url: "https://example.test/v1" }).url).toBe("https://example.test/v1")
    expect(make({ url: "https://example.test/v1", path: "" }).url).toBe("https://example.test/v1")
    expect(make({ url: "https://example.test/v1//", path: "//responses" }).url).toBe(
      "https://example.test/v1/responses"
    )
  })

  it("renders an endpoint without query pairs and one whose values need escaping", () => {
    const bare = make({ url: "https://example.test/v1/responses" })
    expect(bare.query).toEqual([])
    expect(Endpoint.render(bare)).toBe("https://example.test/v1/responses")

    const escaped = make({ url: "https://example.test", query: [["q", "a b&c"]] })
    expect(Endpoint.render(escaped)).toBe("https://example.test/?q=a+b%26c")
  })
})
