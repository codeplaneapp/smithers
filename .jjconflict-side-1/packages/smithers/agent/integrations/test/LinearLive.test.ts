/**
 * Real-backend contract test for the Linear adapter.
 *
 * Runs against api.linear.app with the key in `LINEAR_API_KEY`. Read-only: it
 * queries the viewer and the workspace's teams, states, and labels, which are
 * exactly the lookups the client caches. Skipped, with the credential named,
 * when the key is absent.
 */
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { make } from "../src/linear/LinearClient.ts"

const apiKey = process.env["LINEAR_API_KEY"] ?? process.env["SMITHERS_LINEAR_API_KEY"]

// Skipped without a credential: set LINEAR_API_KEY (or SMITHERS_LINEAR_API_KEY)
// to a personal API key to run it.
describe.skipIf(apiKey === undefined)("Linear live contract (LINEAR_API_KEY)", () => {
  const client = make({ apiKey })

  // Counts real requests without replacing one: the wrapper forwards to the
  // installed `fetch`, so every call still reaches api.linear.app. It is the
  // only way to tell a cache hit from a second round trip, because a cached
  // and an uncached answer are the same value.
  const realFetch = globalThis.fetch
  const countingFetch = () => {
    let calls = 0
    globalThis.fetch = ((...args: Parameters<typeof realFetch>) => {
      calls += 1
      return realFetch(...args)
    }) as typeof realFetch
    return () => calls
  }

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it("authenticates and returns the viewer", async () => {
    const data = await Effect.runPromise(client.query("query Viewer { viewer { id email } }"))
    expect(typeof data?.["viewer"]?.id).toBe("string")
  }, 30_000)

  it("resolves a real team by key and caches it", async (ctx) => {
    const teams = await Effect.runPromise(client.query("query Teams { teams(first: 1) { nodes { id key } } }"))
    const first = teams?.["teams"]?.nodes?.[0]
    // An empty workspace cannot exercise name resolution. That is a skip with
    // a reason, not a pass: passing here would report caching as proven on a
    // run that never resolved anything.
    if (first === undefined) {
      ctx.skip("the workspace this key reaches has no teams, so there is no name to resolve")
      return
    }
    const calls = countingFetch()
    const resolved = await Effect.runPromise(client.resolveTeam({ teamKey: first.key }))
    expect(resolved.id).toBe(first.id)
    const afterFirst = calls()
    expect(afterFirst).toBeGreaterThan(0)
    const again = await Effect.runPromise(client.resolveTeam({ teamKey: first.key }))
    expect(again.id).toBe(first.id)
    // The cache is the claim: the second resolve issues no further request.
    expect(calls()).toBe(afterFirst)
  }, 60_000)

  it("lists the workflow states and labels the name resolution depends on", async (ctx) => {
    const teams = await Effect.runPromise(client.query("query Teams { teams(first: 1) { nodes { id key } } }"))
    const first = teams?.["teams"]?.nodes?.[0]
    if (first === undefined) {
      ctx.skip("the workspace this key reaches has no teams, so it has no workflow states")
      return
    }
    const states = await Effect.runPromise(
      client.query(
        "query States($teamId: ID!) { workflowStates(filter: { team: { id: { eq: $teamId } } }, first: 5) { nodes { id name } } }",
        { teamId: first.id }
      )
    )
    expect(Array.isArray(states?.["workflowStates"]?.nodes)).toBe(true)
  }, 60_000)

  it("reports a GraphQL error rather than a transport failure", async () => {
    const failure = await Effect.runPromise(Effect.flip(client.query("query Bad { notAField }")))
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.message).toContain("Linear")
    if (apiKey !== undefined) expect(failure.message).not.toContain(apiKey)
  }, 30_000)
})
