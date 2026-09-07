import { describe, expect, test } from "bun:test"
import { catalogRepository, openRequestedRepo, paramRepo, pathRepo, requestedRepo, withoutRepoParam } from "./RepoLink"
import { createAppStore } from "./state/AppStore"
import { createTabsController } from "./state/controller/tabs"
import type { ControllerContext } from "./state/controller/context"

/*
 * A repository's app lives at `/owner/name`; the landing page's older "Open in
 * Smithers" link lands on `/?repo=owner/name`. The visitor should arrive with
 * that repository already selected, and only when the public catalog carries
 * it: the URL is anyone's to type.
 */

const catalog = {
  repos: [
    { name: "smithersai/smithers", title: "Smithers", url: "https://github.com/smithersai/smithers", stats: null }
  ]
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const fixture = async () => {
  const data = new Map<string, string>()
  const store = await createAppStore({
    kind: "localStorage",
    storage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key)
    }
  })
  const tabs = createTabsController({
    store,
    services: {},
    commandActor: "user",
    repositories: { available: false }
  } as unknown as ControllerContext)
  return { store, controller: { store, selectRepo: tabs.selectRepo } }
}

describe("paramRepo", () => {
  test("reads an owner/name from the repo parameter", () => {
    expect(paramRepo("?repo=smithersai/smithers")).toBe("smithersai/smithers")
    expect(paramRepo("?auth=failed&repo=smithersai/smithers")).toBe("smithersai/smithers")
  })

  test("ignores an absent, empty, or malformed value", () => {
    expect(paramRepo("")).toBeNull()
    expect(paramRepo("?repo=")).toBeNull()
    expect(paramRepo("?repo=smithers")).toBeNull()
    expect(paramRepo("?repo=../../etc")).toBeNull()
    expect(paramRepo("?repo=https://github.com/smithersai/smithers")).toBeNull()
  })
})

describe("pathRepo", () => {
  test("reads an owner/name from a two-segment path", () => {
    expect(pathRepo("/smithersai/smithers")).toBe("smithersai/smithers")
    expect(pathRepo("/SmithersAI/smithers.js")).toBe("SmithersAI/smithers.js")
  })

  test("answers null for the root, one segment, a trailing slash, or deeper paths", () => {
    expect(pathRepo("/")).toBeNull()
    expect(pathRepo("")).toBeNull()
    expect(pathRepo("/smithersai")).toBeNull()
    expect(pathRepo("/smithersai/")).toBeNull()
    expect(pathRepo("/smithersai/smithers/")).toBeNull()
    expect(pathRepo("/smithersai/smithers/issues")).toBeNull()
    expect(pathRepo("/w/ws-1/b/main/f/frame-1")).toBeNull()
    expect(pathRepo("/a%20b/c")).toBeNull()
  })
})

describe("requestedRepo", () => {
  test("the path names the repository", () => {
    expect(requestedRepo({ pathname: "/smithersai/smithers", search: "" })).toBe("smithersai/smithers")
  })

  test("the path wins over the repo parameter", () => {
    expect(requestedRepo({ pathname: "/smithersai/smithers", search: "?repo=someone/else" })).toBe("smithersai/smithers")
  })

  test("the repo parameter is read at the root only", () => {
    expect(requestedRepo({ pathname: "/", search: "?repo=smithersai/smithers" })).toBe("smithersai/smithers")
    expect(requestedRepo({ pathname: "/w/ws-1/b/main/f/frame-1", search: "?repo=smithersai/smithers" })).toBeNull()
    expect(requestedRepo({ pathname: "/smithersai", search: "?repo=smithersai/smithers" })).toBeNull()
  })

  test("nothing is requested at the root without the parameter", () => {
    expect(requestedRepo({ pathname: "/", search: "" })).toBeNull()
    expect(requestedRepo({ pathname: "/", search: "?auth=failed" })).toBeNull()
  })
})

describe("catalogRepository", () => {
  test("matches the catalog spelling case-insensitively", () => {
    expect(catalogRepository(catalog, "SmithersAI/Smithers")).toEqual({
      id: "smithersai/smithers",
      org: "smithersai",
      name: "smithers"
    })
  })

  test("answers null for a name outside the catalog or a malformed catalog", () => {
    expect(catalogRepository(catalog, "someone/else")).toBeNull()
    expect(catalogRepository({ repos: "nope" }, "smithersai/smithers")).toBeNull()
    expect(catalogRepository(null, "smithersai/smithers")).toBeNull()
  })
})

describe("withoutRepoParam", () => {
  test("drops only the repo parameter and keeps the rest of the location", () => {
    expect(withoutRepoParam({ pathname: "/", search: "?repo=smithersai/smithers", hash: "" })).toBe("/")
    expect(withoutRepoParam({ pathname: "/app", search: "?tab=main&repo=a/b", hash: "#top" })).toBe("/app?tab=main#top")
  })

  test("keeps the repository path in the address bar", () => {
    expect(withoutRepoParam({ pathname: "/smithersai/smithers", search: "", hash: "" })).toBe("/smithersai/smithers")
    expect(withoutRepoParam({ pathname: "/smithersai/smithers", search: "?repo=someone/else", hash: "" })).toBe(
      "/smithersai/smithers"
    )
  })
})

describe("openRequestedRepo", () => {
  test("a catalog repository becomes the active selection", async () => {
    const { store, controller } = await fixture()
    const requests: Array<string> = []
    const http = async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return jsonResponse(catalog)
    }
    expect(await openRequestedRepo(controller, http, "SmithersAI/Smithers")).toBeUndefined()
    expect(requests).toEqual(["/api/public/repos"])
    expect(store.session().activeRepoKey).toBe("smithersai/smithers")
    expect(store.collections.repositories.get("smithersai/smithers")).toMatchObject({
      org: "smithersai",
      name: "smithers",
      head: null,
      // Provenance: the row is readable signed out, and the chat opens on it.
      catalog: true
    })
  })

  test("a name outside the catalog is refused and selects nothing", async () => {
    const { store, controller } = await fixture()
    const refusal = await openRequestedRepo(controller, async () => jsonResponse(catalog), "someone/else")
    expect(refusal).toBe("someone/else is not in the public repository catalog.")
    expect(store.session().activeRepoKey ?? null).toBeNull()
    expect(store.collections.repositories.size).toBe(0)
  })

  test("an unreachable catalog is a refusal, not a selection", async () => {
    const { store, controller } = await fixture()
    expect(await openRequestedRepo(controller, async () => jsonResponse({}, 503), "smithersai/smithers")).toMatch(/HTTP 503/)
    expect(await openRequestedRepo(controller, async () => { throw new Error("offline") }, "smithersai/smithers")).toMatch(/offline/)
    expect(store.session().activeRepoKey ?? null).toBeNull()
  })

  test("the cloud inventory already loaded stays beside the catalog row", async () => {
    const { store, controller } = await fixture()
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "acme/widgets", org: "acme", ownerKind: "org", name: "widgets", head: null }]
    })
    await openRequestedRepo(controller, async () => jsonResponse(catalog), "smithersai/smithers")
    expect([...store.collections.repositories.keys()].sort()).toEqual(["acme/widgets", "smithersai/smithers"])
    expect(store.collections.repositories.get("acme/widgets")?.ownerKind).toBe("org")
    expect(store.session().activeRepoKey).toBe("smithersai/smithers")
  })
})
