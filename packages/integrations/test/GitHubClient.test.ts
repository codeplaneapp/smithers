import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { isIntegrationError } from "../src/core/IntegrationError.ts"
import { DEFAULT_API_BASE_URL, resolve } from "../src/github/Config.ts"
import { isRateLimitResponse, make, nextPageUrl, retryAfterMs } from "../src/github/GitHubClient.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"

const TOKEN = "ghp-fixture-token"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const client = (extra: { readonly maxRetries?: number } = {}) =>
  make({ token: TOKEN, apiBaseUrl: (fixture as Fixture).origin, ...extra })

describe("GitHub config", () => {
  it("prefers explicit values, then SMITHERS_GITHUB_TOKEN, then GITHUB_TOKEN", () => {
    const env = {
      SMITHERS_GITHUB_TOKEN: "smithers",
      GITHUB_TOKEN: "github",
      SMITHERS_GITHUB_API_BASE_URL: "https://ghe.example/api/v3",
      SMITHERS_GITHUB_WEBHOOK_SECRET: "hook"
    }
    expect(resolve({ token: "explicit" }, env).token).toBe("explicit")
    expect(resolve({}, env).token).toBe("smithers")
    expect(resolve({}, { GITHUB_TOKEN: "github" }).token).toBe("github")
    expect(resolve({}, env).apiBaseUrl).toBe("https://ghe.example/api/v3")
    expect(resolve({}, env).webhookSecret).toBe("hook")
    expect(resolve({}, {}).apiBaseUrl).toBe(DEFAULT_API_BASE_URL)
    expect(resolve({}, {}).maxRetries).toBe(3)
  })

  it("ignores a blank value and trims what it keeps", () => {
    expect(resolve({ token: "   " }, { GITHUB_TOKEN: " padded " }).token).toBe("padded")
  })
})

describe("nextPageUrl", () => {
  it("reads the rel=next target", () => {
    expect(
      nextPageUrl("<https://api.github.com/x?page=2>; rel=\"next\", <https://api.github.com/x?page=9>; rel=\"last\"")
    )
      .toBe("https://api.github.com/x?page=2")
  })

  it("returns null when there is no next page", () => {
    expect(nextPageUrl(null)).toBeNull()
    expect(nextPageUrl("")).toBeNull()
    expect(nextPageUrl("<https://api.github.com/x?page=1>; rel=\"prev\"")).toBeNull()
  })
})

describe("rate-limit detection", () => {
  it("counts a 429, an exhausted 403, and a secondary-limit 403", () => {
    expect(isRateLimitResponse(429, new Headers(), null)).toBe(true)
    expect(isRateLimitResponse(403, new Headers({ "x-ratelimit-remaining": "0" }), null)).toBe(true)
    expect(isRateLimitResponse(403, new Headers(), { message: "You have exceeded a secondary rate limit" })).toBe(true)
    expect(isRateLimitResponse(403, new Headers(), { message: "abuse detection" })).toBe(true)
  })

  it("does not count an ordinary 403 or a 404", () => {
    expect(isRateLimitResponse(403, new Headers({ "x-ratelimit-remaining": "42" }), { message: "Forbidden" }))
      .toBe(false)
    expect(isRateLimitResponse(404, new Headers(), { message: "Not Found" })).toBe(false)
  })

  // A 403 whose body is not JSON, or is JSON without a `message` string, is an
  // ordinary refusal. Reading it as a secondary limit would retry a request
  // GitHub has already decided about.
  it("does not count a 403 whose body names nothing", () => {
    for (const body of [null, "Forbidden", 403, { message: 403 }, {}]) {
      expect(isRateLimitResponse(403, new Headers(), body)).toBe(false)
    }
  })

  it("honors Retry-After and x-ratelimit-reset, capped at one minute", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "5" }))).toBe(5000)
    expect(retryAfterMs(new Headers({ "retry-after": "600" }))).toBe(60_000)
    expect(retryAfterMs(new Headers({ "retry-after": "soon" }))).toBeNull()
    expect(retryAfterMs(new Headers({ "x-ratelimit-reset": "1010" }), 1_000_000)).toBe(10_000)
    expect(retryAfterMs(new Headers({ "x-ratelimit-reset": "900" }), 1_000_000)).toBeNull()
    expect(retryAfterMs(new Headers())).toBeNull()
  })
})

describe("GitHubClient over a real HTTP server", () => {
  it("sends the bearer token, the API version, and a JSON body", async () => {
    fixture = await startFixture((_request, response) => json(response, 201, { id: 7, url: "https://x" }))
    const created = await Effect.runPromise(
      client().request("POST", "/repos/o/r/issues/1/comments", { body: "hello" })
    )
    expect(created).toEqual({ id: 7, url: "https://x" })
    const [sent] = fixture.requests
    expect(sent?.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
    expect(sent?.headers["x-github-api-version"]).toBe("2022-11-28")
    expect(sent?.headers["content-type"]).toBe("application/json")
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({ body: "hello" })
  })

  it("appends query parameters and skips undefined ones", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, []))
    await Effect.runPromise(
      client().request("GET", "/search/issues", undefined, {
        query: { q: "is:open", page: 2, draft: false, skip: undefined }
      })
    )
    const url = new URL(`${fixture.origin}${fixture.requests[0]?.url}`)
    expect(url.searchParams.get("q")).toBe("is:open")
    expect(url.searchParams.get("page")).toBe("2")
    expect(url.searchParams.get("draft")).toBe("false")
    expect(url.searchParams.has("skip")).toBe(false)
  })

  it("decodes a response through a schema and fails loudly when it does not match", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { number: 12, title: "t" }))
    const schema = Schema.Struct({ number: Schema.Number, title: Schema.String })
    expect(await Effect.runPromise(client().request("GET", "/issues/12", undefined, { schema })))
      .toEqual({ number: 12, title: "t" })

    await fixture.close()
    fixture = await startFixture((_request, response) => json(response, 200, { number: "twelve" }))
    const exit = await Effect.runPromise(
      Effect.exit(client().request("GET", "/issues/12", undefined, { schema }))
    )
    expect(exit._tag).toBe("Failure")
  })

  it("follows Link rel=next and concatenates the pages", async () => {
    fixture = await startFixture((request, response) => {
      const page = new URL(`http://x${request.url}`).searchParams.get("page") ?? "1"
      if (page === "1") {
        json(response, 200, [{ id: 1 }, { id: 2 }], {
          link: `<${(fixture as Fixture).origin}/repos/o/r/hooks?page=2>; rel="next"`
        })
        return
      }
      json(response, 200, [{ id: 3 }])
    })
    const page = await Effect.runPromise(client().paginate("/repos/o/r/hooks"))
    expect(page.items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    expect(page.truncated).toBe(false)
    expect(new URL(`http://x${fixture.requests[0]?.url}`).searchParams.get("per_page")).toBe("100")
  })

  // A truncated list read as a complete one is how a reconciliation plans work
  // for resources it simply did not see, so the cap has to be reported.
  it("stops at maxPages and says the answer is truncated", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, [{ id: 1 }], { link: `<${(fixture as Fixture).origin}/x?page=9>; rel="next"` })
    )
    const page = await Effect.runPromise(client().paginate("/x", { perPage: 1, maxPages: 2 }))
    expect(page.items).toHaveLength(2)
    expect(page.truncated).toBe(true)
    expect(fixture.requests).toHaveLength(2)
  })

  it("refuses a page budget that is not a finite bound", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, []))
    for (const options of [{ maxPages: Number.POSITIVE_INFINITY }, { maxPages: 0 }, { perPage: 1000 }]) {
      const failure = await Effect.runPromise(Effect.flip(client().paginate("/x", options)))
      expect(failure.reason).toBe("invalid-config")
    }
    expect(fixture.requests).toHaveLength(0)
  })

  it("wraps a single object page rather than dropping it", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { id: 1 }))
    expect((await Effect.runPromise(client().paginate("/x"))).items).toEqual([{ id: 1 }])
  })

  it("retries a 429 that names its own delay, then succeeds", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 429, { message: "rate limited" }, { "retry-after": "0" })
        return
      }
      json(response, 200, { ok: true })
    })
    expect(await Effect.runPromise(client().request("GET", "/x"))).toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it("retries a 5xx and gives up with the last failure once the budget is spent", async () => {
    fixture = await startFixture((_request, response) => json(response, 503, { message: "unavailable" }))
    const exit = await Effect.runPromise(Effect.exit(client({ maxRetries: 1 }).request("GET", "/x")))
    expect(exit._tag).toBe("Failure")
    expect(fixture.requests).toHaveLength(2)
  })

  // GitHub may have committed the write and lost the answer, so repeating a
  // POST posts a second comment. The action's tier says irreversible; the
  // client has to mean it.
  it("issues an unsafe write exactly once when the server errors", async () => {
    fixture = await startFixture((_request, response) => json(response, 502, { message: "bad gateway" }))
    for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
      const before = fixture.requests.length
      const failure = await Effect.runPromise(Effect.flip(client().request(method, "/repos/o/r/x", { a: 1 })))
      expect(fixture.requests.length - before).toBe(1)
      expect(failure.details).toMatchObject({ outcomeUnknown: true, retryable: false })
      expect(failure.message).toContain("outcome unknown")
    }
  })

  it("issues an unsafe write exactly once when the transport fails", async () => {
    fixture = await startFixture((_request, response) => {
      response.destroy()
    })
    const failure = await Effect.runPromise(Effect.flip(client().request("POST", "/x", { a: 1 })))
    expect(fixture.requests).toHaveLength(1)
    expect(failure.details).toMatchObject({ outcomeUnknown: true, retryable: false })
  })

  it("joins a path that carries no leading slash", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true }))
    await Effect.runPromise(client().request("GET", "repos/o/r"))
    expect(fixture.requests[0]?.url).toBe("/repos/o/r")
  })

  // `Retry-After` is the provider saying when, and honoring it is the whole
  // point of reading the header: a retry that ignores it walks straight back
  // into the same limit.
  it("waits the interval a rate limit asked for before repeating", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 429, { message: "rate limited" }, { "retry-after": "0.05" })
        return
      }
      json(response, 200, { ok: true })
    })
    const startedAt = Date.now()
    expect(await Effect.runPromise(client().request("GET", "/x"))).toEqual({ ok: true })
    expect(calls).toBe(2)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50)
  })

  // A rate limit is a refusal, not an ambiguous outcome: the request was not
  // performed, so repeating it is safe for any verb.
  it("still retries a rate-limited write, because it was refused rather than applied", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 429, { message: "rate limited" }, { "retry-after": "0" })
        return
      }
      json(response, 201, { ok: true })
    })
    expect(await Effect.runPromise(client().request("POST", "/x", { a: 1 }))).toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it("repeats an unsafe write when the caller opts in", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls < 3) {
        json(response, 502, { message: "bad gateway" })
        return
      }
      json(response, 201, { ok: true })
    })
    expect(
      await Effect.runPromise(client().request("POST", "/x", { a: 1 }, { retryUnsafeWrites: true }))
    ).toEqual({ ok: true })
    expect(calls).toBe(3)
  })

  // `new URL("httpx")` throws a bare TypeError, which used to escape the
  // declared IntegrationError channel as a defect.
  it("fails invalid-config for a path that is not a URL rather than dying", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    const failure = await Effect.runPromise(Effect.flip(client().request("GET", "httpx")))
    expect(failure.reason).toBe("invalid-config")
    expect(fixture.requests).toHaveLength(0)
  })

  it("refuses a retry budget that is not a finite bound", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    expect(() => client({ maxRetries: Number.POSITIVE_INFINITY })).toThrow(/maxRetries/)
  })

  // A read is repeatable by definition, so its failure must never claim the
  // outcome is in doubt.
  it("never marks a read's failure outcome-unknown", async () => {
    fixture = await startFixture((_request, response) => json(response, 502, { message: "bad gateway" }))
    const failure = await Effect.runPromise(Effect.flip(client({ maxRetries: 1 }).request("GET", "/x")))
    expect(failure.details).toMatchObject({ outcomeUnknown: false, retryable: true })
    expect(fixture.requests).toHaveLength(2)
  })

  // The boundary that matters: the budget was spent exactly, and the last page
  // had no successor, so the answer is complete rather than truncated.
  it("reports a walk that ends exactly on the budget as complete", async () => {
    fixture = await startFixture((request, response) => {
      const page = new URL(`http://x${request.url}`).searchParams.get("page") ?? "1"
      if (page === "1") {
        json(response, 200, [{ id: 1 }], { link: `<${(fixture as Fixture).origin}/x?page=2>; rel="next"` })
        return
      }
      json(response, 200, [{ id: 2 }])
    })
    const page = await Effect.runPromise(client().paginate("/x", { perPage: 1, maxPages: 2 }))
    expect(page.items).toEqual([{ id: 1 }, { id: 2 }])
    expect(page.truncated).toBe(false)
    expect(fixture.requests).toHaveLength(2)
  })

  it("does not retry a 404", async () => {
    fixture = await startFixture((_request, response) => json(response, 404, { message: "Not Found" }))
    const exit = await Effect.runPromise(Effect.exit(client().request("GET", "/x")))
    expect(exit._tag).toBe("Failure")
    expect(fixture.requests).toHaveLength(1)
  })

  it("classifies a failure with the status, the path, and no token", async () => {
    fixture = await startFixture((_request, response) => json(response, 404, { message: "Not Found" }))
    const failure = await Effect.runPromise(
      Effect.flip(client().request("GET", "/repos/o/r/issues/9"))
    )
    expect(isIntegrationError(failure)).toBe(true)
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.details).toMatchObject({ status: 404, path: "/repos/o/r/issues/9", retryable: false })
    expect(JSON.stringify(failure.details)).not.toContain(TOKEN)
    expect(failure.message).not.toContain(TOKEN)
  })

  // The token is on every request, so a URL that leaves the configured origin
  // would hand it to someone else. A redirected `rel=next` is the realistic
  // way that happens.
  it("refuses a request URL that leaves the configured API origin", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    const failure = await Effect.runPromise(
      Effect.flip(client().request("GET", "https://evil.example/steal"))
    )
    expect(failure.message).toContain("is not the configured GitHub API origin")
    expect(fixture.requests).toHaveLength(0)
  })

  it("refuses a rel=next page on a foreign origin", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, [{ id: 1 }], { link: "<https://evil.example/page2>; rel=\"next\"" })
    )
    const failure = await Effect.runPromise(Effect.flip(client().paginate("/x")))
    expect(failure.message).toContain("is not the configured GitHub API origin")
  })

  it("returns a non-JSON body as text rather than failing", async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("plain")
    })
    expect(await Effect.runPromise(client().request("GET", "/x"))).toBe("plain")
  })

  it("returns null for an empty body", async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(204)
      response.end()
    })
    expect(await Effect.runPromise(client().request("DELETE", "/x"))).toBeNull()
  })

  it("uses statusText when the error body carries no message", async () => {
    fixture = await startFixture((_request, response) => json(response, 418, { detail: "teapot" }))
    const failure = await Effect.runPromise(Effect.flip(client().request("GET", "/x")))
    expect(failure.message).toContain("418")
  })

  it("interrupting the fiber aborts the request in flight", async () => {
    let closed = false
    fixture = await startFixture((_request, response) => {
      response.on("close", () => {
        closed = true
      })
      // Never answers: the only way out is the interrupt.
    })
    // `Effect.timeout` interrupts the effect it wraps, which is the same
    // interruption a cancelled run delivers.
    const exit = await Effect.runPromise(
      Effect.exit(Effect.timeout(client().request("GET", "/hang"), "50 millis"))
    )
    expect(exit._tag).toBe("Failure")
    await Effect.runPromise(Effect.sleep("100 millis"))
    expect(closed).toBe(true)
  })

  // A caller that passes its own environment must not have an ambient
  // GITHUB_TOKEN decide which account a call runs as.
  it("omits the Authorization header when the supplied environment has no token", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    await Effect.runPromise(make({ apiBaseUrl: fixture.origin }, {}).request("GET", "/x"))
    expect(fixture.requests[0]?.headers["authorization"]).toBeUndefined()
  })
})

describe("a body that cannot be serialized", () => {
  // The throw used to happen inside the transport attempt, where every failure
  // is a lost answer, so a request that was never sent was reported as a write
  // whose outcome nobody knows.
  it("is caller input, not an unknown write outcome", async () => {
    fixture = await startFixture((_request, response) => json(response, 201, {}))
    const cyclic: Record<string, unknown> = {}
    cyclic["self"] = cyclic
    const failure = await Effect.runPromise(Effect.flip(client().request("POST", "/x", cyclic)))
    expect(failure.reason).toBe("invalid-config")
    expect(failure.details).toMatchObject({ outcomeUnknown: false, retryable: false })
    expect(fixture.requests).toHaveLength(0)
  })
})
