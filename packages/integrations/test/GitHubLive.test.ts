/**
 * Real-backend contract test for the GitHub adapter.
 *
 * Runs against api.github.com with the token in `GITHUB_TOKEN`. There is no
 * fixture server here on purpose: the fixture suites prove the client's
 * behavior, and this suite proves the wire contract it assumes is still the
 * one GitHub serves. Skipped, with the credential named, when the token is
 * absent.
 *
 * A read-only token is enough. Nothing here writes.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { make } from "../src/github/GitHubClient.ts"

const token = process.env["GITHUB_TOKEN"] ?? process.env["SMITHERS_GITHUB_TOKEN"]

// Skipped without a credential: set GITHUB_TOKEN (or SMITHERS_GITHUB_TOKEN) to
// a token with public read access to run it.
describe.skipIf(token === undefined)("GitHub live contract (GITHUB_TOKEN)", () => {
  const client = make({ token })

  it("authenticates and returns the viewer", async () => {
    const viewer = await Effect.runPromise(client.request<{ login?: unknown }>("GET", "/user"))
    expect(typeof viewer.login).toBe("string")
  }, 30_000)

  it("reports the rate-limit headers the retry policy reads", async () => {
    const limits = await Effect.runPromise(
      client.request<{ resources?: { core?: { limit?: unknown; remaining?: unknown; reset?: unknown } } }>(
        "GET",
        "/rate_limit"
      )
    )
    const core = limits.resources?.core
    expect(typeof core?.limit).toBe("number")
    expect(typeof core?.remaining).toBe("number")
    expect(typeof core?.reset).toBe("number")
  }, 30_000)

  it("paginates a real Link header", async () => {
    const items = await Effect.runPromise(
      client.paginate("/repos/microsoft/TypeScript/issues", { perPage: 5, maxPages: 2 })
    )
    expect(items.length).toBeGreaterThan(5)
  }, 60_000)

  it("classifies a real 404 as a non-retryable delivery failure", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(client.request("GET", "/repos/smithersai/this-repository-does-not-exist-9f2a"))
    )
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.details).toMatchObject({ status: 404, retryable: false })
    if (token !== undefined) expect(JSON.stringify(failure.details)).not.toContain(token)
  }, 30_000)
})
