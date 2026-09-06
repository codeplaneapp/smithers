import { describe, expect, test } from "bun:test"
import worker from "./index"
import { createPublicReposHandler } from "./publicRepos"
import type { PublicRepoCatalog } from "./publicRepoCatalog"

const metadata = {
  full_name: "smithersai/smithers", private: false,
  stargazers_count: 407, forks_count: 50, open_issues_count: 4,
  language: "TypeScript", license: { spdx_id: "MIT" },
  permissions: { admin: true }, irrelevant: "never public"
}

const request = (query = "") => new Request(`https://app.test/api/public/repos${query}`, {
  headers: { origin: "https://smithers.sh", cookie: "session=private", authorization: "Bearer private" }
})

const harness = (answer: () => Response | Promise<Response> = () => Response.json(metadata)) => {
  let now = 1_000
  const requests: Array<Request> = []
  const handler = createPublicReposHandler({
    fetch: async (req) => { requests.push(req); return answer() },
    now: () => now,
    cache: () => undefined
  })
  return { handler, requests, advance: (ms: number) => { now += ms } }
}

describe("public available repositories", () => {
  test("serves only the approved repo and basic stats, without using caller credentials", async () => {
    const { handler, requests } = harness()
    const response = await handler(request("?repo=private/secret&url=https://evil.test"))
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(response.headers.get("cache-control")).toBe("public, max-age=300")
    expect(await response.json()).toEqual({ repos: [{
      name: "smithersai/smithers", title: "Smithers", url: "https://github.com/smithersai/smithers",
      stats: { stars: 407, forks: 50, openIssuesAndPulls: 4, language: "TypeScript", license: "MIT" }
    }] })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("https://api.github.com/repos/smithersai/smithers")
    expect(requests[0]!.headers.has("authorization")).toBe(false)
    expect(requests[0]!.headers.has("cookie")).toBe(false)
    expect(requests[0]!.redirect).toBe("error")
  })

  test("joins concurrent reads, caches for five minutes, and refreshes after expiry", async () => {
    const { handler, requests, advance } = harness()
    await Promise.all([handler(request()), handler(request("?cache-bust=1")), handler(request())])
    expect(requests).toHaveLength(1)
    advance(299_000)
    expect((await handler(request())).headers.get("cache-control")).toBe("public, max-age=1")
    expect(requests).toHaveLength(1)
    advance(1_001)
    await handler(request())
    expect(requests).toHaveLength(2)
  })

  test("the edge cache is reusable across Worker instances and expires", async () => {
    const records = new Map<string, Response>()
    const cache = {
      match: async (req: RequestInfo | URL) => records.get((req as Request).url)?.clone(),
      put: async (req: RequestInfo | URL, response: Response) => { records.set((req as Request).url, response.clone()) }
    }
    let calls = 0
    let now = 1_000
    const deps = { fetch: async () => { calls++; return Response.json(metadata) }, now: () => now, cache: () => cache }
    await createPublicReposHandler(deps)(request())
    const second = await createPublicReposHandler(deps)(request("?different=1"))
    expect(calls).toBe(1)
    expect((await second.json() as PublicRepoCatalog).repos[0]?.stats?.stars).toBe(407)
    now += 300_001
    await createPublicReposHandler(deps)(request())
    expect(calls).toBe(2)
  })

  test("outages and invalid or private metadata never invent counts or remove availability", async () => {
    for (const answer of [
      () => Response.json({ message: "rate limited" }, { status: 403 }),
      () => Response.json({ ...metadata, private: true }),
      () => Response.json({ ...metadata, full_name: "another/repo" }),
      () => Response.json({ ...metadata, stargazers_count: -1 }),
      () => new Response("not json"),
      () => { throw new Error("offline") }
    ]) {
      const { handler, requests, advance } = harness(answer)
      const response = await handler(request())
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("public, max-age=30")
      expect(await response.json()).toEqual({ repos: [{
        name: "smithersai/smithers", title: "Smithers", url: "https://github.com/smithersai/smithers", stats: null
      }] })
      await handler(request())
      expect(requests).toHaveLength(1)
      advance(30_001)
      await handler(request())
      expect(requests).toHaveLength(2)
    }
  })

  test("preflight and unsupported writes do not touch the backend", async () => {
    const { handler, requests } = harness()
    const options = await handler(new Request(request(), { method: "OPTIONS" }))
    expect(options.status).toBe(204)
    const write = await handler(new Request(request(), { method: "POST" }))
    expect(write.status).toBe(405)
    expect(requests).toHaveLength(0)
  })

  test("the Worker exposes only this catalog across origins, while write routes remain gated", async () => {
    const env = { ASSETS: { fetch: async () => new Response("app") }, IDENTITY_UPSTREAM_URL: "https://identity.test" }
    const options = await worker.fetch(new Request(request(), { method: "OPTIONS" }), env)
    expect(options.status).toBe(204)
    const write = await worker.fetch(new Request("https://app.test/api/repos/smithersai/smithers/issues", {
      method: "POST", headers: { origin: "https://smithers.sh" }
    }), env)
    expect(write.status).toBe(403)
  })
})
