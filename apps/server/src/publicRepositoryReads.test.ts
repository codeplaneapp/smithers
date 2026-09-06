import { describe, expect, test } from "bun:test"
import { createPublicRepositoryReader, isPublicRepositoryRead } from "./publicRepositoryReads"
import worker from "./index"

describe("anonymous repository reads", () => {
  test("admits public document reads and excludes writes, account data, and workspace credentials", () => {
    for (const suffix of ["", "/contents/src/index.ts", "/topics", "/bookmarks", "/issues", "/issues/1/comments", "/changes/abc/diff"]) {
      expect(isPublicRepositoryRead("GET", `/api/repos/smithersai/smithers${suffix}`)).toBe(true)
    }
    for (const path of ["/api/user/repos", "/api/billing/balance", "/api/admin/errors", "/api/repos/a/b/workspaces", "/api/repos/a/b/workspaces/1/ssh", "/api/repos/a/b/gateway", "/api/repos/a/b/secrets", "/api/repos/a/../issues"]) {
      expect(isPublicRepositoryRead("GET", path)).toBe(false)
    }
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(isPublicRepositoryRead(method, "/api/repos/a/b/issues")).toBe(false)
    }
  })

  test("fetches through the app's Cloud backend without credentials and caches public answers", async () => {
    const seen: Array<Request> = []
    const records = new Map<string, Response>()
    const read = createPublicRepositoryReader({
      fetch: async (request) => { seen.push(request); return Response.json([{ name: "README.md", type: "file" }]) },
      cache: () => ({
        match: async (key) => records.get((key as Request).url)?.clone(),
        put: async (key, response) => { records.set((key as Request).url, response.clone()) }
      })
    })
    const url = new URL("https://app.test/api/repos/smithersai/smithers/contents?ref=main")
    const first = await read(url, "https://cloud.test")
    const second = await read(url, "https://cloud.test")
    expect(await first.json()).toEqual(await second.json())
    expect(first.headers.get("cache-control")).toBe("public, max-age=60")
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe("https://cloud.test/api/repos/smithersai/smithers/contents?ref=main")
    expect(seen[0]!.headers.has("authorization")).toBe(false)
    expect(seen[0]!.headers.has("cookie")).toBe(false)
  })

  test("a private repository's refusal is neither converted to data nor cached", async () => {
    let cached = false
    const read = createPublicRepositoryReader({
      fetch: async () => Response.json({ message: "repository not found" }, { status: 404 }),
      cache: () => ({ match: async () => undefined, put: async () => { cached = true } })
    })
    const response = await read(new URL("https://app.test/api/repos/owner/private"), "https://cloud.test")
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ message: "repository not found" })
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(cached).toBe(false)
  })

  test("the app's direct and Cloud-prefixed read routes work without a session, but writes require one", async () => {
    const original = globalThis.fetch
    const requests: Array<Request> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      if (request.url.startsWith("https://identity.test/")) {
        return request.headers.get("cookie") === "smithers_session=not-admitted"
          ? Response.json({ login: "visitor", allowlisted: false, admin: false })
          : new Response(null, { status: 401 })
      }
      return Response.json({ full_name: "smithersai/smithers", private: false })
    }) as typeof fetch
    const env = {
      ASSETS: { fetch: async () => new Response("app") },
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
    }
    try {
      for (const prefix of ["/api", "/api/cloud/api"]) {
        const response = await worker.fetch(new Request(`https://app.test${prefix}/repos/smithersai/smithers`), env)
        expect(response.status).toBe(200)
        expect((await response.json() as { full_name: string }).full_name).toBe("smithersai/smithers")
      }
      expect(requests).toHaveLength(2)
      expect(requests.every((request) => request.url.startsWith("https://cloud.test/") && !request.headers.has("authorization"))).toBe(true)
      for (const session of ["expired", "not-admitted"]) {
        const response = await worker.fetch(new Request("https://app.test/api/repos/smithersai/smithers", {
          headers: { cookie: `smithers_session=${session}` }
        }), env)
        expect(response.status).toBe(200)
      }
      const write = await worker.fetch(new Request("https://app.test/api/repos/smithersai/smithers/issues", { method: "POST" }), env)
      expect(write.status).toBe(401)
      const cloudRequests = requests.filter((request) => request.url.startsWith("https://cloud.test/"))
      expect(cloudRequests).toHaveLength(4)
      expect(cloudRequests.every((request) => !request.headers.has("cookie") && !request.headers.has("authorization"))).toBe(true)
    } finally { globalThis.fetch = original }
  })
})
