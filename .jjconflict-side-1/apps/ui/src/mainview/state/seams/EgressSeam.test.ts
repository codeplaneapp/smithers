import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { CLOUD_ROUTE_PREFIX } from "@smthrs/rpc/LocalApp"
import { createAppStore } from "../AppStore"
import {
  agentSessionEgressPath,
  createEgressSeam,
  DEGRADED_EGRESS_REFUSAL,
  egressLine,
  loadEgressPage,
  nextEgressCursor,
  parseEgressRow,
  workspaceEgressPath
} from "./EgressSeam"
import type { SeamContext } from "./SeamContext"

/*
 * The sandbox egress audit seam (lane L3). One route shape serves a workspace
 * and an agent session (plue `internal/routes/sandbox_egress_audit.go`): a
 * bare array of `services.SandboxEgressAuditEntry` and a Link header whose
 * `rel="next"` carries an opaque base64 keyset cursor. Every double below is
 * that shape; the parser states what the wire said, and a page it cannot read
 * is an error, never an empty audit.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

/** One row exactly as plue writes it. */
const CALL = {
  occurred_at: "2026-09-02T09:15:00Z",
  host: "api.github.com",
  method: "POST",
  path: "/graphql",
  status: 200,
  allowed: true,
  swapped_secret_names: ["GITHUB_TOKEN"]
}

const SESSION_PATH = "api/repos/will/smithers/agent-sessions/as-1/egress"

type Route = Response | ((url: URL) => Response | Promise<Response>)

const harness = async (
  routes: Record<string, Route>,
  options: { readonly signedIn?: boolean; readonly degraded?: boolean } = {}
) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const urls: Array<string> = []
  const ctx: SeamContext = {
    http: async (input, init) => {
      const stripped = input.startsWith(CLOUD_ROUTE_PREFIX) ? input.slice(CLOUD_ROUTE_PREFIX.length) : input
      const url = new URL(stripped, "https://cloud.invalid/")
      const path = url.pathname.slice(1)
      urls.push(`${init?.method ?? "GET"} ${path}${url.search}`)
      const route = routes[path]
      if (route === undefined) return json(404, { message: `no route ${path}` })
      return typeof route === "function" ? route(url) : route
    },
    baseUrl: "",
    store,
    dispatch: (transition) => store.dispatch(transition),
    actor: () => "user",
    nextOrdinal: () => 0
  }
  if (options.signedIn !== false) {
    await store.dispatch({
      type: "cloud.session.loaded",
      actor: "system",
      state: "signed-in",
      username: "will",
      expiresAt: null,
      scopes: options.degraded === true ? "degraded" : null
    })
  }
  await store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [
      { id: "will/smithers", org: "will", ownerKind: "user", name: "smithers", head: null }
    ]
  })
  return { store, ctx, seam: createEgressSeam(ctx), urls }
}

const messagesOf = (store: Awaited<ReturnType<typeof harness>>["store"]) =>
  [...store.collections.messages.values()].map((message) => message.text)

describe("the egress audit row parser", () => {
  test("plue's row reads as the call it was, with the secret NAMES and no value", () => {
    expect(parseEgressRow(CALL)).toEqual({
      occurredAt: "2026-09-02T09:15:00Z",
      host: "api.github.com",
      method: "POST",
      path: "/graphql",
      status: 200,
      allowed: true,
      swappedSecretNames: ["GITHUB_TOKEN"]
    })
  })

  test("a blocked call keeps its status and reads as blocked", () => {
    expect(parseEgressRow({ ...CALL, allowed: false, status: 403 })).toEqual(
      expect.objectContaining({ allowed: false, status: 403 })
    )
  })

  test("no swapped secrets is an empty list whether plue writes [], null, or nothing", () => {
    for (const names of [[], null, undefined]) {
      expect(parseEgressRow({ ...CALL, swapped_secret_names: names })?.swappedSecretNames).toEqual([])
    }
  })

  test("a row missing a fact it would have to state drops rather than inventing one", () => {
    expect(parseEgressRow({ ...CALL, occurred_at: "" })).toBeNull()
    expect(parseEgressRow({ ...CALL, host: "" })).toBeNull()
    expect(parseEgressRow({ ...CALL, method: undefined })).toBeNull()
    expect(parseEgressRow({ ...CALL, status: "200" })).toBeNull()
    expect(parseEgressRow({ ...CALL, allowed: undefined })).toBeNull()
    expect(parseEgressRow(null)).toBeNull()
    expect(parseEgressRow([CALL])).toBeNull()
  })

  test("an empty path is a real call to the host's root, not a malformed row", () => {
    expect(parseEgressRow({ ...CALL, path: "" })?.path).toBe("")
  })
})

describe("the audit's cursor", () => {
  const path = "/repos/will/smithers/workspaces/ws-1/egress"

  test("the rel=\"next\" link's cursor is the next page's position", () => {
    expect(
      nextEgressCursor(
        `</api${path}?limit=30>; rel="first", </api${path}?limit=30&cursor=eyJpZCI6MX0>; rel="next"`,
        path
      )
    ).toBe("eyJpZCI6MX0")
  })

  test("a last page (first link only) exhausts the cursor", () => {
    expect(nextEgressCursor(`</api${path}?limit=30>; rel="first"`, path)).toBeNull()
    expect(nextEgressCursor(null, path)).toBeNull()
  })

  test("a next link that leaves the route it paginates is not followed", () => {
    expect(nextEgressCursor(`</api/repos/will/smithers/changes?cursor=x>; rel="next"`, path)).toBeNull()
  })
})

describe("one page of an audit", () => {
  test("the page asks for plue's own limit and reads the rows and the cursor", async () => {
    const { ctx, urls } = await harness({
      [SESSION_PATH]: json(200, [CALL], {
        link: `</${SESSION_PATH}?limit=30&cursor=eyJpZCI6MX0>; rel="next"`
      })
    })
    const page = await loadEgressPage(ctx, agentSessionEgressPath("will/smithers", "as-1"))
    expect(urls).toEqual([`GET ${SESSION_PATH}?limit=30`])
    expect(page).toEqual({ rows: [parseEgressRow(CALL)!], nextCursor: "eyJpZCI6MX0" })
  })

  test("a cursor rides the query", async () => {
    const { ctx, urls } = await harness({ [SESSION_PATH]: json(200, []) })
    await loadEgressPage(ctx, agentSessionEgressPath("will/smithers", "as-1"), "eyJpZCI6MX0")
    expect(urls).toEqual([`GET ${SESSION_PATH}?limit=30&cursor=eyJpZCI6MX0`])
  })

  test("a refusal is the server's own message, verbatim", async () => {
    const { ctx } = await harness({ [SESSION_PATH]: json(403, { message: "you do not have access to this repository" }) })
    expect(await loadEgressPage(ctx, agentSessionEgressPath("will/smithers", "as-1"))).toEqual({
      error: "you do not have access to this repository"
    })
  })

  test("rows Smithers cannot read are an error — an empty audit would be the one lie that matters here", async () => {
    const { ctx } = await harness({ [SESSION_PATH]: json(200, [{ host: 12 }]) })
    expect(await loadEgressPage(ctx, agentSessionEgressPath("will/smithers", "as-1"))).toEqual({
      error: "Smithers Cloud answered 1 egress row in a shape Smithers can't read."
    })
  })

  test("the two resources share one path shape", () => {
    expect(workspaceEgressPath("will/smithers", "ws-1")).toBe("/repos/will/smithers/workspaces/ws-1/egress")
    expect(agentSessionEgressPath("will/smithers", "as-1")).toBe("/repos/will/smithers/agent-sessions/as-1/egress")
  })
})

describe("egress.session", () => {
  test("a signed-out session refuses with the sign-in step; a degraded one with the enable wording", async () => {
    const signedOut = await harness({}, { signedIn: false })
    expect(await signedOut.seam.listSessionEgress("as-1")).toBe("Sign in to Smithers Cloud first — /cloud.sign-in.")
    const degraded = await harness({}, { degraded: true })
    expect(await degraded.seam.listSessionEgress("as-1")).toBe(DEGRADED_EGRESS_REFUSAL)
    expect(DEGRADED_EGRESS_REFUSAL).toContain("sign in again to enable")
  })

  test("the agent session's audit answers as a transcript listing, secret names and all", async () => {
    const { store, seam, urls } = await harness({ [SESSION_PATH]: json(200, [CALL]) })
    const result = await seam.listSessionEgress("as-1")
    expect(urls).toEqual([`GET ${SESSION_PATH}?limit=30`])
    expect(result).toEqual({
      value: "2026-09-02T09:15:00Z · POST api.github.com/graphql · 200 · allowed · secrets GITHUB_TOKEN"
    })
    expect(messagesOf(store)).toEqual([
      "2026-09-02T09:15:00Z · POST api.github.com/graphql · 200 · allowed · secrets GITHUB_TOKEN"
    ])
  })

  test("a page with more behind it names the cursor the next call takes", async () => {
    const { seam } = await harness({
      [SESSION_PATH]: json(200, [CALL], { link: `</${SESSION_PATH}?limit=30&cursor=eyJpZCI6MX0>; rel="next"` })
    })
    const result = await seam.listSessionEgress("as-1", "will/smithers")
    expect(typeof result === "object" && "value" in result ? result.value : "").toContain(
      "Older calls remain — /egress.session as-1 will/smithers eyJpZCI6MX0"
    )
  })

  test("a session that called nothing says so", async () => {
    const { seam } = await harness({ [SESSION_PATH]: json(200, []) })
    expect(await seam.listSessionEgress("as-1")).toEqual({ value: "Agent session as-1 made no recorded calls." })
  })

  test("a line never carries a secret's value — only the binding's name", () => {
    expect(egressLine(parseEgressRow(CALL)!)).toBe(
      "2026-09-02T09:15:00Z · POST api.github.com/graphql · 200 · allowed · secrets GITHUB_TOKEN"
    )
    expect(egressLine(parseEgressRow({ ...CALL, swapped_secret_names: [] })!)).toBe(
      "2026-09-02T09:15:00Z · POST api.github.com/graphql · 200 · allowed"
    )
  })
})
