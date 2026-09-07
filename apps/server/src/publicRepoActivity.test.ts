import { describe, expect, test } from "bun:test"
import worker from "./index"
import { ACTIVITY_WINDOW_MS, activitySentence, createPublicRepoActivityHandler, parsePublicRepoActivityPath } from "./publicRepoActivity"
import type { PublicRepoActivity } from "./publicRepoActivity"

const NOW = Date.parse("2026-09-07T12:00:00Z")
const MIRROR = "https://cloud.test/api/repos/smithers-canary/smithers"
const DAY = 24 * 60 * 60 * 1000

const at = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString()

interface FakeChange {
  readonly change_id: string
  readonly commit_id: string
  readonly timestamp: string
  readonly parent_change_ids: ReadonlyArray<string>
}

/** A linear chain, newest first; `head` is the newest change id. */
const chain = (prefix: string, days: ReadonlyArray<number>, tail: string | null): Array<FakeChange> =>
  days.map((daysAgo, index) => ({
    change_id: `${prefix}${index}`,
    commit_id: `sha-${prefix}${index}`,
    timestamp: at(daysAgo),
    parent_change_ids: index + 1 < days.length ? [`${prefix}${index + 1}`] : tail === null ? [] : [tail]
  }))

/**
 * A mirror for one week: 12 commits on main inside the window over an older
 * base, a side bookmark with 2 commits inside the window that main does not
 * reach, 3 landing requests and 5 issues opened inside the window and one of
 * each opened before it.
 */
const mirror = () => {
  const main = chain("m", [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6.5, 9, 30], null)
  const side = chain("s", [1, 2], "m3")
  const changes = [...side, ...main]
  const landings = [{ number: 4, created_at: at(1) }, { number: 3, created_at: at(3) }, { number: 2, created_at: at(6) }, { number: 1, created_at: at(20) }]
  const issues = [5, 4, 3, 2, 1].map((number) => ({ number, created_at: at(number) })).concat([{ number: 0, created_at: at(8) }])
  return {
    changes,
    documents: {
      "": { default_bookmark: "main", full_name: "smithers-canary/smithers" },
      "/git/refs": [
        { ref: "refs/heads/side", object: { sha: "sha-s0", type: "commit" } },
        { ref: "refs/heads/main", object: { sha: "sha-m0", type: "commit" } }
      ],
      "/changes": { items: changes },
      "/landings": landings,
      "/issues": issues
    } as Record<string, unknown>
  }
}

type Answer = (path: string, url: URL) => Response | undefined

const harness = (answer?: Answer, documents: Record<string, unknown> = mirror().documents) => {
  let now = NOW
  const requests: Array<Request> = []
  const handler = createPublicRepoActivityHandler({
    fetch: async (request) => {
      requests.push(request)
      const url = new URL(request.url)
      if (!url.href.startsWith(MIRROR)) return Response.json({ message: "not the mirror" }, { status: 404 })
      const path = url.pathname.slice(new URL(MIRROR).pathname.length)
      const custom = answer?.(path, url)
      if (custom !== undefined) return custom
      return path in documents ? Response.json(documents[path]) : Response.json({ message: "not found" }, { status: 404 })
    },
    now: () => now,
    cache: () => undefined
  })
  const request = (path = "/api/public/repos/smithersai/smithers/activity", init?: RequestInit) =>
    handler(new Request(`https://app.test${path}`, { headers: { origin: "https://smithers.sh", cookie: "session=private" }, ...init }), "https://cloud.test")
  return { handler, request, requests, advance: (ms: number) => { now += ms } }
}

describe("the activity sentence", () => {
  test("names each count with its own number and verb", () => {
    expect(activitySentence({ commits: 12, pullRequests: 3, issues: 5 }, "main"))
      .toBe("In the last 7 days, 12 commits landed on main, 3 pull requests were opened, and 5 issues were filed.")
    expect(activitySentence({ commits: 1, pullRequests: 1, issues: 1 }, "main"))
      .toBe("In the last 7 days, 1 commit landed on main, 1 pull request was opened, and 1 issue was filed.")
    expect(activitySentence({ commits: 0, pullRequests: 0, issues: 0 }, "trunk"))
      .toBe("In the last 7 days, no commits landed on trunk, no pull requests were opened, and no issues were filed.")
  })

  test("drops a count the mirror could not answer and says so after the sentence", () => {
    expect(activitySentence({ commits: 2, pullRequests: null, issues: 0 }, "main"))
      .toBe("In the last 7 days, 2 commits landed on main and no issues were filed. Pull request activity is not available.")
    expect(activitySentence({ commits: null, pullRequests: null, issues: 4 }, null))
      .toBe("In the last 7 days, 4 issues were filed. Commit activity is not available. Pull request activity is not available.")
    expect(activitySentence({ commits: null, pullRequests: null, issues: null }, null))
      .toBe("Recent activity is not available.")
  })

  test("is one sentence, no em dashes, deterministic for equal counts", () => {
    const first = activitySentence({ commits: 7, pullRequests: 2, issues: 1 }, "main")
    expect(first).toBe(activitySentence({ commits: 7, pullRequests: 2, issues: 1 }, "main"))
    expect(first).not.toContain("\u2014")
  })
})

describe("GET /api/public/repos/<owner>/<name>/activity", () => {
  test("recognizes the route for a catalog spelling and rejects other paths", () => {
    expect(parsePublicRepoActivityPath("/api/public/repos/smithersai/smithers/activity")).toBe("smithersai/smithers")
    expect(parsePublicRepoActivityPath("/api/public/repos/SmithersAI/Smithers/activity/")).toBe("SmithersAI/Smithers")
    for (const path of ["/api/public/repos", "/api/public/repos/smithersai/smithers", "/api/public/repos/a/../activity", "/api/repos/smithersai/smithers/activity"]) {
      expect(parsePublicRepoActivityPath(path)).toBeUndefined()
    }
  })

  test("counts the week from the mirror's own feeds: commits on the default bookmark, landings, and issues", async () => {
    const { request, requests } = harness()
    const response = await request()
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=300")
    const body = await response.json() as PublicRepoActivity
    expect(body).toEqual({
      sentence: "In the last 7 days, 12 commits landed on main, 3 pull requests were opened, and 5 issues were filed.",
      counts: { commits: 12, pullRequests: 3, issues: 5 },
      since: new Date(NOW - ACTIVITY_WINDOW_MS).toISOString()
    })
    // Every read is the credential-free mirror read; GitHub is never called.
    expect(requests.length).toBeGreaterThan(0)
    for (const upstream of requests) {
      expect(upstream.url.startsWith(MIRROR)).toBe(true)
      expect(upstream.headers.has("authorization")).toBe(false)
      expect(upstream.headers.has("cookie")).toBe(false)
    }
    expect(requests.map((upstream) => new URL(upstream.url).pathname.slice(new URL(MIRROR).pathname.length)).sort())
      .toEqual(["", "/changes", "/git/refs", "/issues", "/landings"])
  })

  test("a feed the mirror cannot answer yields the honest partial sentence and a short cache", async () => {
    const { request } = harness((path) => path === "/landings" ? Response.json({ message: "not found" }, { status: 404 }) : undefined)
    const response = await request()
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=30")
    const body = await response.json() as PublicRepoActivity
    expect(body.counts).toEqual({ commits: 12, pullRequests: null, issues: 5 })
    expect(body.sentence).toBe("In the last 7 days, 12 commits landed on main and 5 issues were filed. Pull request activity is not available.")
  })

  test("a malformed feed is unavailable, never a zero", async () => {
    for (const bad of [() => new Response("not json"), () => Response.json({ items: [{ change_id: "x" }] }), () => { throw new Error("offline") }]) {
      const { request } = harness((path) => path === "/changes" ? bad() : undefined)
      const body = await (await request()).json() as PublicRepoActivity
      expect(body.counts).toEqual({ commits: null, pullRequests: 3, issues: 5 })
      expect(body.sentence).toBe("In the last 7 days, 3 pull requests were opened and 5 issues were filed. Commit activity is not available.")
    }
    const { request } = harness(undefined, { ...mirror().documents, "": { default_bookmark: "" } })
    expect(((await (await request()).json()) as PublicRepoActivity).sentence)
      .toBe("In the last 7 days, 3 pull requests were opened and 5 issues were filed. Commit activity is not available.")
  })

  test("follows the mirror's next link until a page falls outside the window, and stops at the bound", async () => {
    const { changes, documents } = mirror()
    const pageOf = (items: ReadonlyArray<unknown>, cursor: number | undefined) =>
      Response.json({ items }, cursor === undefined ? {} : { headers: { link: `</api/repos/smithers-canary/smithers/changes?limit=100>; rel="first", </api/repos/smithers-canary/smithers/changes?cursor=${cursor}&limit=100>; rel="next"` } })
    // 100 inside-window changes on a side bookmark push main's chain onto the second page.
    const filler = Array.from({ length: 100 }, (_, index) => ({
      change_id: `f${index}`, commit_id: `sha-f${index}`, timestamp: at(0.25), parent_change_ids: index === 99 ? [] : [`f${index + 1}`]
    }))
    const { request, requests } = harness((path, url) => {
      if (path !== "/changes") return undefined
      const cursor = url.searchParams.get("cursor")
      if (cursor === null) return pageOf(filler, 100)
      if (cursor === "100") return pageOf(changes, undefined)
      return Response.json({ message: "no such page" }, { status: 404 })
    }, documents)
    const body = await (await request()).json() as PublicRepoActivity
    expect(body.counts.commits).toBe(12)
    expect(requests.filter((upstream) => new URL(upstream.url).pathname.endsWith("/changes")).map((upstream) => new URL(upstream.url).search))
      .toEqual(["?limit=100", "?limit=100&cursor=100"])

    // A window the bound cannot close is unavailable rather than undercounted.
    const endless = harness((path, url) => path === "/changes" ? pageOf(filler, Number(url.searchParams.get("cursor") ?? "0") + 100) : undefined, documents)
    const partial = await (await endless.request()).json() as PublicRepoActivity
    expect(partial.counts.commits).toBeNull()
    expect(endless.requests.filter((upstream) => new URL(upstream.url).pathname.endsWith("/changes"))).toHaveLength(20)
  })

  test("a repository outside the catalog is 404 and reaches no upstream", async () => {
    const { request, requests } = harness()
    for (const path of ["/api/public/repos/example/other/activity", "/api/public/repos/smithersai/smithers-docs/activity"]) {
      const response = await request(path)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ message: "Repository is not in the public catalog." })
    }
    expect(requests).toHaveLength(0)
  })

  test("a cache hit skips the upstream for five minutes and joins concurrent reads", async () => {
    const { request, requests, advance } = harness()
    await Promise.all([request(), request("/api/public/repos/SmithersAI/Smithers/activity"), request("/api/public/repos/smithersai/smithers/activity?bust=1")])
    const first = requests.length
    expect(first).toBe(5)
    advance(299_000)
    expect((await request()).headers.get("cache-control")).toBe("public, max-age=1")
    expect(requests).toHaveLength(first)
    advance(1_001)
    await request()
    expect(requests).toHaveLength(first * 2)
  })

  test("the edge cache is reusable across Worker instances and expires", async () => {
    const records = new Map<string, Response>()
    const cache = {
      match: async (req: RequestInfo | URL) => records.get((req as Request).url)?.clone(),
      put: async (req: RequestInfo | URL, response: Response) => { records.set((req as Request).url, response.clone()) }
    }
    const { documents } = mirror()
    let calls = 0
    let now = NOW
    const deps = {
      fetch: async (req: Request) => {
        calls++
        const path = new URL(req.url).pathname.slice(new URL(MIRROR).pathname.length)
        return path in documents ? Response.json(documents[path]) : Response.json({}, { status: 404 })
      },
      now: () => now,
      cache: () => cache
    }
    const url = "https://app.test/api/public/repos/smithersai/smithers/activity"
    await createPublicRepoActivityHandler(deps)(new Request(url), "https://cloud.test")
    const second = await createPublicRepoActivityHandler(deps)(new Request(`${url}?different=1`), "https://cloud.test")
    expect(calls).toBe(5)
    expect(((await second.json()) as PublicRepoActivity).counts.commits).toBe(12)
    expect([...records.keys()]).toEqual([url])
    now += 300_001
    await createPublicRepoActivityHandler(deps)(new Request(url), "https://cloud.test")
    expect(calls).toBe(10)
  })

  test("preflight and unsupported writes do not touch the mirror", async () => {
    const { request, requests } = harness()
    const options = await request(undefined, { method: "OPTIONS" })
    expect(options.status).toBe(204)
    const post = await request(undefined, { method: "POST" })
    expect(post.status).toBe(405)
    expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS")
    expect(requests).toHaveLength(0)
    const head = await request(undefined, { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
  })

  test("the Worker serves the route before the same-origin guard and reads the configured Cloud origin", async () => {
    const original = globalThis.fetch
    const seen: Array<string> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      seen.push(request.url)
      return Response.json({ message: "not found" }, { status: 404 })
    }) as typeof fetch
    try {
      const env = { ASSETS: { fetch: async () => new Response("app") }, SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" }
      const response = await worker.fetch(new Request("https://app.test/api/public/repos/smithersai/smithers/activity", {
        headers: { origin: "https://smithers.sh" }
      }), env as never)
      expect(response.status).toBe(200)
      expect(((await response.json()) as PublicRepoActivity).sentence).toBe("Recent activity is not available.")
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((url) => url.startsWith(MIRROR))).toBe(true)
      const missing = await worker.fetch(new Request("https://app.test/api/public/repos/example/other/activity"), env as never)
      expect(missing.status).toBe(404)
    } finally { globalThis.fetch = original }
  })
})
