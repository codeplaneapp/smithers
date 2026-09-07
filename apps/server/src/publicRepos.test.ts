import { describe, expect, test } from "bun:test"
import worker from "./index"
import { createPublicReposHandler } from "./publicRepos"
import { AVAILABLE_REPOS } from "./publicRepoCatalog"
import type { PublicRepoCatalog } from "./publicRepoCatalog"

/** GitHub metadata for one catalog entry. Stars encode the catalog position so order mistakes are visible. */
const metadataFor = (name: string) => {
  const index = AVAILABLE_REPOS.findIndex((repo) => repo.name === name)
  return {
    full_name: name, private: false,
    stargazers_count: 407 + index * 1000, forks_count: 50 + index, open_issues_count: 4 + index,
    language: "TypeScript", license: { spdx_id: "MIT" },
    permissions: { admin: true }, irrelevant: "never public"
  }
}

const metadata = metadataFor("smithersai/smithers")

const repoName = (req: Request) => new URL(req.url).pathname.replace("/repos/", "")

const answerEach = (req: Request) => Response.json(metadataFor(repoName(req)))

const expectedRepos = (stats: (name: string) => PublicRepoCatalog["repos"][number]["stats"]) =>
  AVAILABLE_REPOS.map((repo) => ({ ...repo, stats: stats(repo.name) }))

const request = (query = "") => new Request(`https://app.test/api/public/repos${query}`, {
  headers: { origin: "https://smithers.sh", cookie: "session=private", authorization: "Bearer private" }
})

const harness = (answer: (req: Request) => Response | Promise<Response> = answerEach) => {
  let now = 1_000
  const requests: Array<Request> = []
  const handler = createPublicReposHandler({
    fetch: async (req) => { requests.push(req); return answer(req) },
    now: () => now,
    cache: () => undefined
  })
  return { handler, requests, advance: (ms: number) => { now += ms } }
}

describe("the curated catalog", () => {
  test("lists Smithers first, then its direct production dependencies, each once", () => {
    expect(AVAILABLE_REPOS.map((repo) => repo.name)).toEqual(["smithersai/smithers", "wevm/incur", "Effect-TS/effect"])
    expect(new Set(AVAILABLE_REPOS.map((repo) => repo.name)).size).toBe(AVAILABLE_REPOS.length)
  })

  test("links every entry to the GitHub repository its stats are fetched from", () => {
    for (const repo of AVAILABLE_REPOS) {
      expect(repo.url).toBe(`https://github.com/${repo.name}`)
      expect(repo.title.length).toBeGreaterThan(0)
    }
  })
})

describe("public available repositories", () => {
  test("serves every approved repo in catalog order with basic stats, without using caller credentials", async () => {
    const { handler, requests } = harness()
    const response = await handler(request("?repo=private/secret&url=https://evil.test"))
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(response.headers.get("cache-control")).toBe("public, max-age=300")
    const catalog = await response.json() as PublicRepoCatalog
    expect(catalog).toEqual({ repos: expectedRepos((name) => {
      const github = metadataFor(name)
      return {
        stars: github.stargazers_count, forks: github.forks_count, openIssuesAndPulls: github.open_issues_count,
        language: "TypeScript", license: "MIT"
      }
    }) })
    expect(catalog.repos[0]).toMatchObject({ name: "smithersai/smithers", stats: { stars: 407 } })
    expect(requests.map((req) => req.url)).toEqual(AVAILABLE_REPOS.map((repo) => `https://api.github.com/repos/${repo.name}`))
    for (const req of requests) {
      expect(req.headers.has("authorization")).toBe(false)
      expect(req.headers.has("cookie")).toBe(false)
      expect(req.redirect).toBe("error")
    }
  })

  test("fetches every repo concurrently, and one failing repo never nulls the others", async () => {
    const pending = new Map<string, (response: Response) => void>()
    const { handler, requests } = harness((req) => new Promise((resolve) => { pending.set(repoName(req), resolve) }))
    const served = handler(request())
    await Promise.resolve()
    expect(requests).toHaveLength(AVAILABLE_REPOS.length)
    expect([...pending.keys()]).toEqual(AVAILABLE_REPOS.map((repo) => repo.name))
    pending.get("Effect-TS/effect")!(answerEach(requests[2]!))
    pending.get("wevm/incur")!(Response.json({ message: "rate limited" }, { status: 403 }))
    pending.get("smithersai/smithers")!(answerEach(requests[0]!))
    const response = await served
    expect(response.headers.get("cache-control")).toBe("public, max-age=30")
    const catalog = await response.json() as PublicRepoCatalog
    expect(catalog.repos.map((repo) => repo.name)).toEqual(AVAILABLE_REPOS.map((repo) => repo.name))
    expect(catalog.repos[0]!.stats?.stars).toBe(407)
    expect(catalog.repos[1]!.stats).toBeNull()
    expect(catalog.repos[2]!.stats?.stars).toBe(2407)
  })

  test("joins concurrent reads, caches for five minutes, and refreshes after expiry", async () => {
    const { handler, requests, advance } = harness()
    await Promise.all([handler(request()), handler(request("?cache-bust=1")), handler(request())])
    expect(requests).toHaveLength(AVAILABLE_REPOS.length)
    advance(299_000)
    expect((await handler(request())).headers.get("cache-control")).toBe("public, max-age=1")
    expect(requests).toHaveLength(AVAILABLE_REPOS.length)
    advance(1_001)
    await handler(request())
    expect(requests).toHaveLength(AVAILABLE_REPOS.length * 2)
  })

  test("the edge cache is reusable across Worker instances and expires", async () => {
    const records = new Map<string, Response>()
    const cache = {
      match: async (req: RequestInfo | URL) => records.get((req as Request).url)?.clone(),
      put: async (req: RequestInfo | URL, response: Response) => { records.set((req as Request).url, response.clone()) }
    }
    let calls = 0
    let now = 1_000
    const deps = { fetch: async (req: Request) => { calls++; return answerEach(req) }, now: () => now, cache: () => cache }
    await createPublicReposHandler(deps)(request())
    const second = await createPublicReposHandler(deps)(request("?different=1"))
    expect(calls).toBe(AVAILABLE_REPOS.length)
    expect((await second.json() as PublicRepoCatalog).repos[0]?.stats?.stars).toBe(407)
    now += 300_001
    await createPublicReposHandler(deps)(request())
    expect(calls).toBe(AVAILABLE_REPOS.length * 2)
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
      expect(await response.json()).toEqual({ repos: expectedRepos(() => null) })
      await handler(request())
      expect(requests).toHaveLength(AVAILABLE_REPOS.length)
      advance(30_001)
      await handler(request())
      expect(requests).toHaveLength(AVAILABLE_REPOS.length * 2)
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
