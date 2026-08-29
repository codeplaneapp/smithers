import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_API_BASE_URL, resolve } from "../src/linear/Config.ts"
import { make, normalizePriority, retryDelayMs } from "../src/linear/LinearClient.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"

const API_KEY = "lin_api_fixture"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const client = () => make({ apiKey: API_KEY, apiBaseUrl: (fixture as Fixture).origin })

const operation = (body: string): string => {
  const parsed = JSON.parse(body) as { query: string }
  return /(?:query|mutation)\s+(\w+)/.exec(parsed.query)?.[1] ?? "unknown"
}

const TEAM = { id: "team-eng-id", key: "ENG", name: "Engineering" }
const STATES = [{ id: "state-todo", name: "Todo" }, { id: "state-progress", name: "In Progress" }]
const LABELS = [{ id: "label-bug", name: "Bug" }, { id: "label-infra", name: "Infra" }]
const ISSUE = {
  id: "issue-uuid",
  identifier: "ENG-1",
  title: "t",
  url: "https://linear.app/x",
  team: { id: TEAM.id, key: "ENG" }
}

/** A GraphQL fixture that answers the operations the client actually sends. */
const graphql = async (overrides: Partial<Record<string, unknown>> = {}) =>
  startFixture((request, response) => {
    const name = operation(request.body)
    if (Object.hasOwn(overrides, name)) {
      json(response, 200, { data: overrides[name] })
      return
    }
    switch (name) {
      case "TeamByKey":
        return json(response, 200, { data: { teams: { nodes: [TEAM] } } })
      case "WorkflowStates":
        return json(response, 200, { data: { workflowStates: { nodes: STATES } } })
      case "IssueLabels":
        return json(response, 200, { data: { issueLabels: { nodes: LABELS } } })
      case "Issue":
        return json(response, 200, { data: { issue: ISSUE } })
      case "IssueCreate":
        return json(response, 200, { data: { issueCreate: { success: true, issue: ISSUE } } })
      case "IssueUpdate":
        return json(response, 200, { data: { issueUpdate: { success: true, issue: ISSUE } } })
      case "CommentCreate":
        return json(response, 200, {
          data: {
            commentCreate: {
              success: true,
              comment: { id: "c1", body: "hi", issue: { id: ISSUE.id, identifier: "ENG-1" } }
            }
          }
        })
      default:
        return json(response, 200, { data: {} })
    }
  })

describe("Linear config", () => {
  it("prefers explicit values over the environment", () => {
    const env = {
      SMITHERS_LINEAR_API_KEY: "env-key",
      SMITHERS_LINEAR_WEBHOOK_SECRET: "env-secret",
      SMITHERS_LINEAR_API_BASE_URL: "https://linear.test/graphql"
    }
    expect(resolve({ apiKey: "explicit" }, env).apiKey).toBe("explicit")
    expect(resolve({}, env)).toEqual({
      apiKey: "env-key",
      webhookSecret: "env-secret",
      apiBaseUrl: "https://linear.test/graphql"
    })
    expect(resolve({}, {}).apiBaseUrl).toBe(DEFAULT_API_BASE_URL)
  })
})

describe("normalizePriority", () => {
  it("maps Linear's vocabulary", () => {
    expect(normalizePriority("none")).toBe(0)
    expect(normalizePriority("urgent")).toBe(1)
    expect(normalizePriority("HIGH" as "high")).toBe(2)
    expect(normalizePriority("normal")).toBe(3)
    expect(normalizePriority("medium")).toBe(3)
    expect(normalizePriority("low")).toBe(4)
    expect(normalizePriority(2)).toBe(2)
    expect(normalizePriority(undefined)).toBeUndefined()
  })

  it("refuses a number outside 0-4 and an unknown name", () => {
    expect(() => normalizePriority(5)).toThrow(/expected 0-4/)
    expect(() => normalizePriority(-1)).toThrow(/expected 0-4/)
    expect(() => normalizePriority(1.5)).toThrow(/expected 0-4/)
    expect(() => normalizePriority("critical" as "high")).toThrow(/Unknown Linear priority/)
  })
})

describe("retryDelayMs", () => {
  it("honors Retry-After and the reset header, capped at 30 seconds", () => {
    expect(retryDelayMs(new Headers({ "retry-after": "2" }))).toBe(2000)
    expect(retryDelayMs(new Headers({ "retry-after": "600" }))).toBe(30_000)
    expect(retryDelayMs(new Headers({ "retry-after": "soon" }))).toBeUndefined()
    expect(retryDelayMs(new Headers({ "x-ratelimit-requests-reset": "1005" }), 1000)).toBe(5)
    expect(retryDelayMs(new Headers({ "x-ratelimit-requests-reset": "500" }), 1000)).toBe(0)
    expect(retryDelayMs(new Headers())).toBeUndefined()
  })
})

describe("LinearClient over a real HTTP server", () => {
  it("sends the API key raw in Authorization and never elsewhere", async () => {
    fixture = await graphql()
    await Effect.runPromise(client().resolveTeam({ teamKey: "ENG" }))
    const [sent] = fixture.requests
    expect(sent?.headers["authorization"]).toBe(API_KEY)
    expect(sent?.body).not.toContain(API_KEY)
  })

  it("fails with credentials-missing when no key is configured", async () => {
    fixture = await graphql()
    const failure = await Effect.runPromise(
      Effect.flip(make({ apiBaseUrl: fixture.origin }, {}).query("query X { x }"))
    )
    expect(failure.reason).toBe("credentials-missing")
    expect(fixture.requests).toHaveLength(0)
  })

  it("caches a team lookup per client", async () => {
    fixture = await graphql()
    const linear = client()
    await Effect.runPromise(linear.resolveTeam({ teamKey: "ENG" }))
    await Effect.runPromise(linear.resolveTeam({ teamKey: "eng" }))
    expect(fixture.requests.filter((request) => operation(request.body) === "TeamByKey")).toHaveLength(1)
  })

  it("passes an explicit team id through without a lookup", async () => {
    fixture = await graphql()
    expect(await Effect.runPromise(client().resolveTeam({ teamId: "team-x" }))).toEqual({
      id: "team-x",
      key: undefined
    })
    expect(fixture.requests).toHaveLength(0)
  })

  it("requires a team and reports an unknown key", async () => {
    fixture = await graphql({ TeamByKey: { teams: { nodes: [] } } })
    expect((await Effect.runPromise(Effect.flip(client().resolveTeam({})))).message).toContain("pass teamId or teamKey")
    expect((await Effect.runPromise(Effect.flip(client().resolveTeam({ teamKey: "  " })))).message)
      .toContain("pass teamId or teamKey")
    expect((await Effect.runPromise(Effect.flip(client().resolveTeam({ teamKey: "NOPE" })))).message)
      .toContain("team with key \"NOPE\" not found")
  })

  it("resolves a state name case-insensitively and caches the list", async () => {
    fixture = await graphql()
    const linear = client()
    expect(await Effect.runPromise(linear.resolveStateId(TEAM.id, "in progress"))).toBe("state-progress")
    await Effect.runPromise(linear.resolveStateId(TEAM.id, "Todo"))
    expect(fixture.requests.filter((request) => operation(request.body) === "WorkflowStates")).toHaveLength(1)
  })

  it("names the states it knows when one is missing", async () => {
    fixture = await graphql()
    const failure = await Effect.runPromise(Effect.flip(client().resolveStateId(TEAM.id, "Shipped")))
    expect(failure.message).toContain("\"Shipped\" not found")
    expect(failure.details).toMatchObject({ known: ["Todo", "In Progress"] })
  })

  it("resolves label names and reports every missing one at once", async () => {
    fixture = await graphql()
    const linear = client()
    expect(await Effect.runPromise(linear.resolveLabelIds(TEAM.id, ["bug", "Infra"])))
      .toEqual(["label-bug", "label-infra"])
    const failure = await Effect.runPromise(Effect.flip(linear.resolveLabelIds(TEAM.id, ["Bug", "Nope", "Other"])))
    expect(failure.message).toContain("Nope, Other")
    expect(fixture.requests.filter((request) => operation(request.body) === "IssueLabels")).toHaveLength(1)
  })

  it("creates an issue, resolving the team, state, and labels by name", async () => {
    fixture = await graphql()
    const issue = await Effect.runPromise(
      client().createIssue({
        teamKey: "ENG",
        title: "Broken build",
        description: "d",
        priority: "high",
        stateName: "In Progress",
        labels: ["Bug"],
        assigneeId: "user-1",
        projectId: "project-1",
        estimate: 3,
        dueDate: "2026-01-01"
      })
    )
    expect(issue.identifier).toBe("ENG-1")
    const created = fixture.requests.find((request) => operation(request.body) === "IssueCreate")
    expect(JSON.parse(created?.body ?? "{}").variables.input).toEqual({
      title: "Broken build",
      description: "d",
      assigneeId: "user-1",
      projectId: "project-1",
      estimate: 3,
      dueDate: "2026-01-01",
      priority: 2,
      stateId: "state-progress",
      labelIds: ["label-bug"],
      teamId: TEAM.id
    })
  })

  it("passes explicit state and label ids through unresolved", async () => {
    fixture = await graphql()
    await Effect.runPromise(
      client().createIssue({
        teamId: TEAM.id,
        title: "t",
        stateId: "state-x",
        labelIds: ["label-x"]
      })
    )
    expect(fixture.requests.map((request) => operation(request.body))).toEqual(["IssueCreate"])
  })

  it("reports a mutation that did not return an issue", async () => {
    fixture = await graphql({ IssueCreate: { issueCreate: { success: false } } })
    const failure = await Effect.runPromise(Effect.flip(client().createIssue({ teamId: TEAM.id, title: "t" })))
    expect(failure.message).toContain("issueCreate did not return an issue")
  })

  it("resolves an ENG-123 identifier to a UUID before mutating", async () => {
    fixture = await graphql()
    await Effect.runPromise(client().updateIssue("ENG-1", { title: "renamed" }))
    const updated = fixture.requests.find((request) => operation(request.body) === "IssueUpdate")
    expect(JSON.parse(updated?.body ?? "{}").variables.id).toBe("issue-uuid")
  })

  it("updates by UUID without a lookup when no names need resolving", async () => {
    fixture = await graphql()
    await Effect.runPromise(client().updateIssue("issue-uuid", { title: "renamed" }))
    expect(fixture.requests.map((request) => operation(request.body))).toEqual(["IssueUpdate"])
  })

  it("looks the issue up for its team when a state name needs resolving", async () => {
    fixture = await graphql()
    await Effect.runPromise(client().updateIssue("issue-uuid", { stateName: "Todo" }))
    expect(fixture.requests.map((request) => operation(request.body)))
      .toEqual(["Issue", "WorkflowStates", "IssueUpdate"])
  })

  it("refuses to resolve a name when the issue carries no team", async () => {
    fixture = await graphql({ Issue: { issue: { ...ISSUE, team: null } } })
    const linear = client()
    expect((await Effect.runPromise(Effect.flip(linear.updateIssue("issue-uuid", { stateName: "Todo" })))).message)
      .toContain("requires the issue's team")
    expect((await Effect.runPromise(Effect.flip(linear.updateIssue("issue-uuid", { labels: ["Bug"] })))).message)
      .toContain("requires the issue's team")
  })

  it("reports an update and a comment that did not come back", async () => {
    fixture = await graphql({
      IssueUpdate: { issueUpdate: { success: false } },
      CommentCreate: { commentCreate: { success: false } }
    })
    expect((await Effect.runPromise(Effect.flip(client().updateIssue("issue-uuid", { title: "t" })))).message)
      .toContain("issueUpdate did not return an issue")
    expect((await Effect.runPromise(Effect.flip(client().commentOnIssue("issue-uuid", "hi")))).message)
      .toContain("commentCreate did not return a comment")
  })

  it("comments on an issue by identifier and by UUID", async () => {
    fixture = await graphql()
    const linear = client()
    expect((await Effect.runPromise(linear.commentOnIssue("ENG-1", "hi"))).id).toBe("c1")
    expect(fixture.requests.map((request) => operation(request.body))).toEqual(["Issue", "CommentCreate"])
    await Effect.runPromise(linear.commentOnIssue("issue-uuid", "hi"))
    expect(fixture.requests.map((request) => operation(request.body)).slice(2)).toEqual(["CommentCreate"])
  })

  it("reports a missing issue", async () => {
    fixture = await graphql({ Issue: { issue: null } })
    expect((await Effect.runPromise(Effect.flip(client().getIssue("ENG-9")))).message).toContain("\"ENG-9\" not found")
  })

  it("surfaces a GraphQL error list", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { errors: [{ message: "Entity not found" }, { message: "Access denied" }] })
    )
    const failure = await Effect.runPromise(Effect.flip(client().query("query X { x }")))
    expect(failure.message).toContain("Entity not found; Access denied")
  })

  it("surfaces an errorless non-2xx response", async () => {
    fixture = await startFixture((_request, response) => json(response, 400, { errors: [{ message: "bad" }] }))
    const failure = await Effect.runPromise(Effect.flip(client().query("query X { x }")))
    expect(failure.message).toContain("responded 400")
    expect(failure.details).toMatchObject({ status: 400 })
  })

  it("reports a non-JSON body", async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" })
      response.end("<html>maintenance</html>")
    })
    const failure = await Effect.runPromise(Effect.flip(client().query("query X { x }")))
    expect(failure.reason).toBe("decode-failed")
  })

  it("reports a transport failure", async () => {
    const closed = await startFixture((_request, response) => {
      response.end()
    })
    const origin = closed.origin
    await closed.close()
    const failure = await Effect.runPromise(
      Effect.flip(make({ apiKey: API_KEY, apiBaseUrl: origin }).query("query X { x }"))
    )
    expect(failure.message).toContain("network error")
  })

  it("retries a 429 that names its delay, then succeeds", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 429, { errors: [] }, { "retry-after": "0" })
        return
      }
      json(response, 200, { data: { ok: true } })
    })
    expect(await Effect.runPromise(client().query("query X { x }"))).toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it("gives up after five attempts on a persistent 5xx", async () => {
    fixture = await startFixture((_request, response) => json(response, 503, {}, { "retry-after": "0" }))
    const failure = await Effect.runPromise(Effect.flip(client().query("query X { x }")))
    expect(failure.message).toContain("after 5 attempts")
    expect(fixture.requests).toHaveLength(5)
  })

  it("interrupting the fiber aborts the request in flight", async () => {
    let closed = false
    fixture = await startFixture((_request, response) => {
      response.on("close", () => {
        closed = true
      })
    })
    const exit = await Effect.runPromise(
      Effect.exit(Effect.timeout(client().query("query X { x }"), "50 millis"))
    )
    expect(exit._tag).toBe("Failure")
    await Effect.runPromise(Effect.sleep("100 millis"))
    expect(closed).toBe(true)
  })
})
