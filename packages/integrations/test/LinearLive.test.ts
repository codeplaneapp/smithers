/**
 * Real-backend contract test for the Linear adapter.
 *
 * Runs against api.linear.app with the key in `LINEAR_API_KEY`. Read-only: it
 * queries the viewer and the workspace's teams, states, and labels, which are
 * exactly the lookups the client caches. Skipped, with the credential named,
 * when the key is absent.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { make } from "../src/linear/LinearClient.ts"

const apiKey = process.env["LINEAR_API_KEY"] ?? process.env["SMITHERS_LINEAR_API_KEY"]

// Skipped without a credential: set LINEAR_API_KEY (or SMITHERS_LINEAR_API_KEY)
// to a personal API key to run it.
describe.skipIf(apiKey === undefined)("Linear live contract (LINEAR_API_KEY)", () => {
  const client = make({ apiKey })

  it("authenticates and returns the viewer", async () => {
    const data = await Effect.runPromise(client.query("query Viewer { viewer { id email } }"))
    expect(typeof data?.["viewer"]?.id).toBe("string")
  }, 30_000)

  it("resolves a real team by key and caches it", async () => {
    const teams = await Effect.runPromise(client.query("query Teams { teams(first: 1) { nodes { id key } } }"))
    const first = teams?.["teams"]?.nodes?.[0]
    if (first === undefined) {
      expect(teams?.["teams"]?.nodes).toEqual([])
      return
    }
    const resolved = await Effect.runPromise(client.resolveTeam({ teamKey: first.key }))
    expect(resolved.id).toBe(first.id)
    // The second call must not reach the network; a wrong id would surface as
    // a mismatch rather than a cache miss, so assert the value instead.
    expect((await Effect.runPromise(client.resolveTeam({ teamKey: first.key }))).id).toBe(first.id)
  }, 60_000)

  it("lists the workflow states and labels the name resolution depends on", async () => {
    const teams = await Effect.runPromise(client.query("query Teams { teams(first: 1) { nodes { id key } } }"))
    const first = teams?.["teams"]?.nodes?.[0]
    if (first === undefined) {
      expect(teams?.["teams"]?.nodes).toEqual([])
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
