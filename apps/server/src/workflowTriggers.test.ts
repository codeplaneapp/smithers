import { describe, expect, test } from "bun:test"
import { WORKFLOW_TRIGGERS_PATH } from "@smthrs/rpc/AgentApiRoutes"
import worker from "./index"
import type { WorkerEnv } from "./index"
import { TRIGGERS_UNAVAILABLE_REASON } from "./workflowTriggers"
import type { WorkflowTriggersBody } from "./workflowTriggers"

/*
 * The dispatchers route: what the triggers.list card reads. The gateway
 * relays no trigger procedure yet, so the contract under test is the honest
 * one: a session-gated 200 carrying empty trigger AND webhook lists AND the
 * reason naming both gaps, with no call to Smithers Cloud at all, never a
 * fabricated row and never a 404.
 */

const env: WorkerEnv = {
  ASSETS: { fetch: async () => new Response("app") },
  IDENTITY_UPSTREAM_URL: "https://identity.test",
  IDENTITY_SERVICE_TOKEN: "svc",
  SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
}

const request = (query: string, init: RequestInit = {}): Request =>
  new Request(`https://mvp.test${WORKFLOW_TRIGGERS_PATH}${query}`, {
    ...init,
    headers: { cookie: "smithers_session=sealed", ...(init.headers ?? {}) }
  })

/** Every outbound fetch the Worker makes, with the identity seam answering as configured. */
const withUpstreams = async (
  identity: () => Response,
  run: (seen: ReadonlyArray<string>) => Promise<void>
): Promise<void> => {
  const seen: Array<string> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    seen.push(url)
    if (url.includes("/api/identity/validate")) return identity()
    return new Response("404 page not found\n", { status: 404 })
  }) as unknown as typeof fetch
  try {
    await run(seen)
  } finally {
    globalThis.fetch = original
  }
}

const validated = () =>
  new Response(JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: [] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })

describe("GET /api/workflow/triggers", () => {
  test("a signed-in read answers empty trigger and webhook lists with their reason and never asks Smithers Cloud", async () => {
    await withUpstreams(validated, async (seen) => {
      const response = await worker.fetch(request("?repo=smithersai/smithers"), env)
      expect(response.status).toBe(200)
      const body = (await response.json()) as WorkflowTriggersBody
      expect(body).toEqual({
        status: "ok",
        repo: "smithersai/smithers",
        triggers: [],
        webhooks: [],
        reason: TRIGGERS_UNAVAILABLE_REASON
      })
      /* The reason names the export each list is waiting on, so nobody reads the empty webhook list as "no webhooks". */
      expect(body.reason).toContain("List { _tag: \"triggers\" }")
      expect(body.reason).toContain("Channels.list")
      expect(seen.every((url) => url.includes("identity.test"))).toBe(true)
    })
  })

  test("the repository is required and must be owner/repo", async () => {
    await withUpstreams(validated, async () => {
      for (const query of ["", "?repo=", "?repo=smithers", "?repo=../etc/passwd", "?repo=a/b/c"]) {
        const response = await worker.fetch(request(query), env)
        expect(`${query} -> ${response.status}`).toBe(`${query} -> 400`)
        const body = (await response.json()) as { message: string }
        expect(body.message).toContain("owner/repo")
      }
    })
  })

  test("an anonymous read is refused before anything is read", async () => {
    await withUpstreams(() => new Response("{}", { status: 401 }), async () => {
      const response = await worker.fetch(request("?repo=smithersai/smithers"), env)
      expect(response.status).toBe(401)
    })
  })

  test("only GET is served", async () => {
    await withUpstreams(validated, async (seen) => {
      const response = await worker.fetch(request("?repo=smithersai/smithers", { method: "POST" }), env)
      expect(response.status).toBe(405)
      expect(seen).toHaveLength(0)
    })
  })

  test("with no identity seam the route says so instead of inventing a list", async () => {
    const response = await worker.fetch(request("?repo=smithersai/smithers"), { ASSETS: env.ASSETS })
    expect(response.status).toBe(501)
  })
})
