import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { CLOUD_ROUTE_PREFIX } from "smithers-shared/LocalApp"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { createRepositoriesSeam } from "./RepositoriesSeam"
import type { SeamContext } from "./SeamContext"

/*
 * The repositories seam (lane piper step 2): /api/user/repos + /api/user/orgs
 * classify and list, one bookmarks call per repo fills the default bookmark's
 * head, and /api/user/workspaces feeds the cloud working copies — a 403 there
 * (the degraded legacy token) answers an empty list, honestly. plue#445's
 * `owner_type` and `default_bookmark_head` short-circuit the per-repo call
 * the moment they land. Nothing is faked: an unread head is `head: null`.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const REPOS = [
  { owner: "will", name: "smithers", full_name: "will/smithers", default_bookmark: "main" },
  { owner: "plue", name: "plue", full_name: "plue/plue", default_bookmark: "main" },
  // No default bookmark: no head call, head stays null.
  { owner: "will", name: "scratch", full_name: "will/scratch", default_bookmark: null },
  // Malformed rows drop.
  { name: "broken" },
  null
]

const harness = async (
  route: (path: string) => Response,
  options: { readonly workspaces?: Response } = {}
) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<string> = []
  const ctx: SeamContext = {
    http: async (input) => {
      requests.push(input)
      const path = input.startsWith(CLOUD_ROUTE_PREFIX) ? input.slice(CLOUD_ROUTE_PREFIX.length) : input
      if (path === "api/user/workspaces" && options.workspaces !== undefined) return options.workspaces
      return route(path)
    },
    baseUrl: "",
    store,
    dispatch: store.dispatch,
    actor: () => "user",
    nextOrdinal: () => 0
  }
  return { store, seam: createRepositoriesSeam(ctx), requests }
}

const backend = (path: string): Response => {
  switch (path) {
    case "api/user/repos":
      return json(200, REPOS)
    case "api/user/orgs":
      return json(200, [{ login: "plue" }])
    case "api/repos/will/smithers/bookmarks":
      return json(200, [
        { name: "main", target_change_id: "qupxosqw", target_commit_id: "c0ffee1" },
        { name: "dev", target_change_id: "zzzzzzzz", target_commit_id: "deadbeef" }
      ])
    case "api/repos/plue/plue/bookmarks":
      return json(500, { message: "boom" })
    default:
      return json(404, { message: `no route ${path}` })
  }
}

const repos = (store: AppStore) => [...store.collections.repositories.values()].sort((a, b) => a.id.localeCompare(b.id))
const copies = (store: AppStore) => [...store.collections.workingCopies.values()]

describe("repositories seam", () => {
  test("loads the inventory: owners classified, heads from the default bookmark, workspaces as copies", async () => {
    const { store, seam, requests } = await harness(backend, {
      workspaces: json(200, [
        { id: "ws-1", repo_full_name: "will/smithers", name: "review", status: "running" },
        { id: "ws-2", repo_full_name: "will/smithers", name: "broken-row" }
      ])
    })
    const refusal = await seam.loadRepositories()
    expect(refusal).toBeUndefined()

    expect(repos(store)).toEqual([
      expect.objectContaining({ id: "plue/plue", org: "plue", ownerKind: "org", name: "plue", head: null }),
      expect.objectContaining({ id: "will/scratch", org: "will", ownerKind: "user", head: null }),
      expect.objectContaining({
        id: "will/smithers",
        org: "will",
        ownerKind: "user",
        name: "smithers",
        head: { bookmark: "main", changeId: "qupxosqw", commitId: "c0ffee1" }
      })
    ])
    // No mirror field exists anywhere on the row.
    expect(JSON.stringify(repos(store))).not.toContain("mirror")

    // Workspaces: both rows land; the one without a status carries no state.
    expect(copies(store)).toEqual([
      expect.objectContaining({
        id: "workspace:ws-1",
        repoId: "will/smithers",
        kind: "workspace",
        label: "review",
        workspaceId: "ws-1",
        state: "running"
      }),
      expect.objectContaining({
        id: "workspace:ws-2",
        repoId: "will/smithers",
        kind: "workspace",
        label: "broken-row",
        workspaceId: "ws-2"
      })
    ])

    // One bookmarks call per headed repo; none for the headless ones.
    const bookmarkCalls = requests.filter((request) => request.includes("/bookmarks"))
    expect(bookmarkCalls.sort()).toEqual([
      `${CLOUD_ROUTE_PREFIX}api/repos/plue/plue/bookmarks`,
      `${CLOUD_ROUTE_PREFIX}api/repos/will/smithers/bookmarks`
    ])
  })

  test("a degraded token's 403 on workspaces answers an empty list, not an error", async () => {
    const { store, seam } = await harness(backend, {
      workspaces: json(403, { error: "insufficient token scope" })
    })
    const refusal = await seam.loadRepositories()
    expect(refusal).toBeUndefined()
    expect(repos(store)).toHaveLength(3)
    expect(copies(store)).toEqual([])
  })

  test("plue#445's wire fields replace the per-repo bookmarks call", async () => {
    const withHead = (path: string): Response =>
      path === "api/user/repos"
        ? json(200, [{
          owner: "will",
          name: "smithers",
          full_name: "will/smithers",
          default_bookmark: "main",
          owner_type: "User",
          default_bookmark_head: { change_id: "newchange", commit_id: "newcommit" }
        }])
        : path === "api/user/orgs"
        ? json(200, [])
        : json(404, {})
    const { store, seam, requests } = await harness(withHead, { workspaces: json(403, {}) })
    const refusal = await seam.loadRepositories()
    expect(refusal).toBeUndefined()
    expect(repos(store)).toEqual([
      expect.objectContaining({
        id: "will/smithers",
        ownerKind: "user",
        head: { bookmark: "main", changeId: "newchange", commitId: "newcommit" }
      })
    ])
    expect(requests.filter((request) => request.includes("/bookmarks"))).toEqual([])
  })

  test("a failed repos read is an honest error and dispatches nothing", async () => {
    const { store, seam } = await harness(() => json(401, { message: "bad credentials" }))
    const refusal = await seam.loadRepositories()
    expect(refusal).toBe("bad credentials")
    expect(repos(store)).toEqual([])
  })

  test("a kept head survives a later answer that carries none", async () => {
    const { store, seam } = await harness(backend, { workspaces: json(403, {}) })
    await seam.loadRepositories()
    // A second load where the bookmarks call now fails: the head stays.
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "will/smithers", org: "will", ownerKind: "user", name: "smithers", head: null }]
    })
    expect(store.collections.repositories.get("will/smithers")?.head).toEqual({
      bookmark: "main",
      changeId: "qupxosqw",
      commitId: "c0ffee1"
    })
  })
})
