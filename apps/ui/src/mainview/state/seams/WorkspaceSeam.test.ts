import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { CLOUD_ROUTE_PREFIX } from "smithers-shared/LocalApp"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import type { CloudWorkspaceInput } from "../AppState"
import { createWorkspaceSeam, DEGRADED_WORKSPACE_REFUSAL } from "./WorkspaceSeam"
import type { SeamContext } from "./SeamContext"

/*
 * The workspaces seam (lane citc): the gates (signed-in, never degraded),
 * the list loads that sync the tree copies, open's create-and-watch until
 * the workspace settles, the acts riding the one card, and the terminal's
 * session create-and-settle into a workspace tab. Every route is a double
 * in plue's own wire shape (a bare array from the list routes, the
 * UserWorkspaceRow from the per-user one, the cursor envelope from
 * bookmarks); nothing is faked — an unread auxiliary is an absent field, a
 * 404 mid-watch re-reads the repository's list.
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

/** plue's WorkspaceResponse (the per-repo list, get, create, act answers). */
const WS_RUNNING = {
  id: "ws-1",
  repository_id: 7,
  repo_full_name: "will/smithers",
  name: "review",
  slug: "review",
  target_bookmark: "main",
  status: "running",
  provisioning_stage: null,
  suspended_at: null,
  created_at: "2026-09-01T00:00:00Z"
}

/** plue's UserWorkspaceRow (GET /api/user/workspaces — services/workspace.go): a switcher row, not the DTO. */
const USER_ROW = {
  workspace_id: "ws-1",
  repository_id: 7,
  repository_owner: "will",
  repository_name: "smithers",
  workspace_title: "review",
  state: "running",
  last_accessed_at: null,
  last_activity_at: "2026-09-01T00:00:00Z",
  created_at: "2026-09-01T00:00:00Z",
  sort_timestamp: "2026-09-01T00:00:00Z"
}

const wsRow: CloudWorkspaceInput = {
  id: "ws-1",
  repoId: "will/smithers",
  name: "review",
  targetBookmark: "main",
  status: "running",
  provisioningStage: null,
  suspendedAt: null,
  createdAt: "2026-09-01T00:00:00Z"
}

type Route = Response | ((url: URL) => Response | Promise<Response>)

const harness = async (
  routes: Record<string, Route>,
  options: { readonly signedIn?: boolean; readonly degraded?: boolean } = {}
) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  /** `METHOD path` per request, the query string dropped. */
  const requests: Array<string> = []
  /** The same, with the query string. */
  const urls: Array<string> = []
  /** The store as each of the seam's dispatches left it: what one transition did, before the next. */
  const dispatched: Array<{ readonly type: string; readonly tabs: Array<string>; readonly attached: string | undefined }> = []
  const ctx: SeamContext = {
    http: async (input, init) => {
      const method = init?.method ?? "GET"
      const stripped = input.startsWith(CLOUD_ROUTE_PREFIX) ? input.slice(CLOUD_ROUTE_PREFIX.length) : input
      const url = new URL(stripped, "https://cloud.invalid/")
      const path = url.pathname.slice(1)
      const key = `${method} ${path}`
      requests.push(key)
      urls.push(`${key}${url.search}`)
      const route = routes[key] ?? routes[path]
      if (route === undefined) return json(404, { message: `no route ${key}` })
      return typeof route === "function" ? route(url) : route
    },
    baseUrl: "",
    store,
    dispatch: (transition) => {
      const transaction = store.dispatch(transition)
      dispatched.push({ type: transition.type, tabs: tabsOf(store), attached: payloadOf(store)?.terminalSessionId })
      return transaction
    },
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
      {
        id: "will/smithers",
        org: "will",
        ownerKind: "user",
        name: "smithers",
        head: { bookmark: "main", changeId: "qupxosqw", commitId: "c0ffee1" }
      }
    ]
  })
  return { store, seam: createWorkspaceSeam(ctx, { pollMs: 1 }), requests, urls, dispatched }
}

const seedWorkspace = async (store: AppStore, workspace: CloudWorkspaceInput = wsRow): Promise<void> => {
  await store.dispatch({ type: "workspace.updated", actor: "system", workspace })
}

const seedCard = async (store: AppStore, terminalSessionId?: string): Promise<void> => {
  await store.dispatch({
    type: "card.upsert",
    actor: "user",
    card: {
      id: "workspace-ws-1",
      kind: "workspace",
      title: "review · will/smithers",
      status: "active",
      createdAt: 1,
      ordinal: 0,
      payload: {
        workspaceId: "ws-1",
        repo: "will/smithers",
        name: "review",
        targetBookmark: "main",
        status: "running",
        provisioningStage: null,
        bookmarkHead: null,
        snapshots: [],
        sessions: [],
        ...(terminalSessionId === undefined ? {} : { terminalSessionId })
      }
    }
  })
}

/** A workspace terminal tab as openTerminal opens it. */
const seedWorkspaceTab = async (store: AppStore, sessionId = "sess-1", workspaceId = "ws-1"): Promise<void> => {
  await store.dispatch({
    type: "tab.opened",
    actor: "user",
    tab: {
      id: sessionId,
      kind: "terminal",
      title: "Terminal · review",
      sessionId,
      workspaceId,
      repo: "will/smithers",
      repoKey: `workspace:${workspaceId}`
    }
  })
}

const cardOf = (store: AppStore, workspaceId = "ws-1") => store.collections.cards.get(`workspace-${workspaceId}`)

/** The workspace card's payload, narrowed; undefined when the card is absent. */
const payloadOf = (store: AppStore, workspaceId = "ws-1") => {
  const card = cardOf(store, workspaceId)
  return card?.kind === "workspace" ? card.payload : undefined
}

const workspacesOf = (store: AppStore) => [...store.collections.cloudWorkspaces.values()]
const copiesOf = (store: AppStore) => [...store.collections.workingCopies.values()].filter((copy) => copy.kind === "workspace")
const messagesOf = (store: AppStore) => [...store.collections.messages.values()].map((message) => message.text)
const tabsOf = (store: AppStore) => [...store.collections.tabs.values()].filter((tab) => tab.kind !== "main").map((tab) => tab.id)

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe("workspace seam gates", () => {
  test("a signed-out session refuses every act with the sign-in step", async () => {
    const { seam } = await harness({}, { signedIn: false })
    expect(await seam.listWorkspaces()).toBe("Sign in to Smithers Cloud first — /cloud.sign-in.")
    expect(await seam.openWorkspace("main", "will/smithers")).toBe("Sign in to Smithers Cloud first — /cloud.sign-in.")
    expect(await seam.openTerminal("ws-1")).toBe("Sign in to Smithers Cloud first — /cloud.sign-in.")
  })

  test("a degraded sign-in refuses every act with the enable wording", async () => {
    const { store, seam } = await harness({}, { degraded: true })
    await seedWorkspace(store)
    for (const refusal of [
      await seam.listWorkspaces(),
      await seam.openWorkspace("main", "will/smithers"),
      await seam.viewWorkspace("ws-1"),
      await seam.openTerminal("ws-1"),
      await seam.suspendWorkspace("ws-1"),
      await seam.resumeWorkspace("ws-1"),
      await seam.forkWorkspace("ws-1"),
      await seam.snapshotWorkspace("ws-1"),
      await seam.deleteSnapshot("snap-1", "ws-1"),
      await seam.forkFromSnapshot("snap-1", "ws-1"),
      await seam.templateSnapshot("snap-1", "tpl", "ws-1"),
      await seam.listSessions("ws-1"),
      await seam.destroySession("sess-1", "ws-1"),
      await seam.deleteWorkspace("ws-1", "review")
    ]) {
      expect(refusal).toBe(DEGRADED_WORKSPACE_REFUSAL)
      expect(refusal).toContain("sign in again to enable")
    }
  })
})

describe("workspace seam list", () => {
  /*
   * Critique finding 3: plue's per-user route answers UserWorkspaceRow
   * (workspace_id, repository_owner/name, workspace_title, state), which
   * the DTO parser dropped to zero rows — and then scope-replaced every
   * loaded workspace away.
   */
  test("workspace.list parses plue's per-user rows, asks for 100 a page, syncs the tree copies, and announces", async () => {
    const { store, seam, urls } = await harness({
      "api/user/workspaces": json(200, [
        USER_ROW,
        { ...USER_ROW, workspace_id: "ws-2", workspace_title: "bench", state: "suspended" },
        { broken: true }
      ])
    })
    const result = await seam.listWorkspaces()
    expect(typeof result).toBe("object")
    expect(urls[0]).toBe("GET api/user/workspaces?limit=100")
    expect(workspacesOf(store).map((row) => row.id).sort()).toEqual(["ws-1", "ws-2"])
    expect(copiesOf(store)).toEqual([
      expect.objectContaining({ id: "workspace:ws-1", kind: "workspace", label: "review", state: "running", workspaceId: "ws-1" }),
      expect.objectContaining({ id: "workspace:ws-2", kind: "workspace", label: "bench", state: "suspended", workspaceId: "ws-2" })
    ])
    expect(messagesOf(store).join("\n")).toContain("review (ws-1) · running · will/smithers")
  })

  test("a per-user row keeps the bookmark the collection already knows; a status that moved on drops its stage", async () => {
    const { store, seam } = await harness({
      "api/user/workspaces": json(200, [USER_ROW])
    })
    await seedWorkspace(store, { ...wsRow, status: "starting", provisioningStage: "boot" })
    await seam.listWorkspaces()
    expect(workspacesOf(store)[0]).toEqual(expect.objectContaining({ id: "ws-1", status: "running", targetBookmark: "main", provisioningStage: null }))
  })

  test("a non-empty list Smithers cannot read is an error, and the loaded rows stay", async () => {
    const { store, seam } = await harness({
      "api/user/workspaces": json(200, [{ id: 42, weird: true }, { also: "wrong" }])
    })
    await seedWorkspace(store)
    const refusal = await seam.listWorkspaces()
    expect(typeof refusal).toBe("string")
    expect(refusal).toContain("2 workspace rows in a shape Smithers can't read")
    expect(workspacesOf(store).map((row) => row.id)).toEqual(["ws-1"])
    expect(copiesOf(store).map((copy) => copy.id)).toEqual(["workspace:ws-1"])
  })

  test("an empty list is a fact: the scope empties", async () => {
    const { store, seam } = await harness({
      "api/user/workspaces": json(200, [])
    })
    await seedWorkspace(store)
    const result = await seam.listWorkspaces()
    expect(result).toEqual({ value: "No cloud workspaces." })
    expect(workspacesOf(store)).toEqual([])
  })

  test("a repo-scoped list replaces only that repository's rows", async () => {
    const { store, seam, urls } = await harness({
      "api/repos/will/smithers/workspaces": json(200, [WS_RUNNING])
    })
    await store.dispatch({
      type: "workspace.updated",
      actor: "system",
      workspace: { ...wsRow, id: "ws-other", repoId: "plue/plue", name: "other" }
    })
    const result = await seam.listWorkspaces("will/smithers")
    expect(typeof result).toBe("object")
    expect(urls[0]).toBe("GET api/repos/will/smithers/workspaces?limit=100")
    expect(workspacesOf(store).map((row) => row.id).sort()).toEqual(["ws-1", "ws-other"])
  })

  test("both list routes follow the Link header's next page until it is exhausted", async () => {
    /*
     * plue writes its list links in the legacy page/per_page form; the
     * per-user route's own parser reads only cursor/limit, so the seam
     * re-issues the next page as an offset cursor — which both routes take.
     */
    const pageOf = (url: URL, rows: Array<Record<string, unknown>>, path: string): Response => {
      const offset = Number(url.searchParams.get("cursor") ?? 0)
      const limit = Number(url.searchParams.get("limit"))
      const slice = rows.slice(offset, offset + limit)
      const lastPage = Math.ceil(rows.length / limit)
      const page = offset / limit + 1
      const links = [`<${path}?page=1&per_page=${limit}>; rel="first"`, `<${path}?page=${lastPage}&per_page=${limit}>; rel="last"`]
      if (page < lastPage) links.push(`<${path}?page=${page + 1}&per_page=${limit}>; rel="next"`)
      return json(200, slice, { link: links.join(", "), "x-total-count": String(rows.length) })
    }
    const userRows = Array.from({ length: 130 }, (_, index) => ({ ...USER_ROW, workspace_id: `ws-${index}`, workspace_title: `w${index}` }))
    const repoRows = Array.from({ length: 101 }, (_, index) => ({ ...WS_RUNNING, id: `ws-${index}`, name: `w${index}` }))
    const { store, seam, urls } = await harness({
      "api/user/workspaces": (url) => pageOf(url, userRows, "/api/user/workspaces"),
      "api/repos/will/smithers/workspaces": (url) => pageOf(url, repoRows, "/api/repos/will/smithers/workspaces")
    })
    await seam.listWorkspaces()
    expect(workspacesOf(store).length).toBe(130)
    expect(urls).toEqual(["GET api/user/workspaces?limit=100", "GET api/user/workspaces?limit=100&cursor=100"])
    urls.length = 0
    await seam.listWorkspaces("will/smithers")
    expect(workspacesOf(store).length).toBe(101)
    expect(urls).toEqual(["GET api/repos/will/smithers/workspaces?limit=100", "GET api/repos/will/smithers/workspaces?limit=100&cursor=100"])
  })

  test("a next link that leaves the route is not followed", async () => {
    const { store, seam, urls } = await harness({
      "api/user/workspaces": json(200, [USER_ROW], { link: "</api/user/repos?page=2&per_page=100>; rel=\"next\"" })
    })
    await seam.listWorkspaces()
    expect(urls).toEqual(["GET api/user/workspaces?limit=100"])
    expect(workspacesOf(store).length).toBe(1)
  })

  /*
   * Critique finding 2 (tabs): a workspace the list no longer carries takes
   * its terminal tabs with it, in the same transaction as the row.
   */
  test("a scope replace closes the terminal tabs of the workspaces it dropped", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces": json(200, [{ ...WS_RUNNING, id: "ws-2", name: "bench" }])
    })
    await seedWorkspace(store)
    await seedWorkspace(store, { ...wsRow, id: "ws-2", name: "bench" })
    await seedWorkspaceTab(store, "sess-1", "ws-1")
    await seedWorkspaceTab(store, "sess-2", "ws-2")
    expect(store.session().activeTabId).toBe("sess-2")
    await seam.listWorkspaces("will/smithers")
    expect(workspacesOf(store).map((row) => row.id)).toEqual(["ws-2"])
    expect(tabsOf(store)).toEqual(["sess-2"])
  })
})

describe("workspace seam open", () => {
  test("open creates with the repository's head bookmark, renders the card, and watches until settled", async () => {
    let polls = 0
    const { store, seam, requests } = await harness({
      "POST api/repos/will/smithers/workspaces": json(201, { ...WS_RUNNING, status: "pending", provisioning_stage: "allocating" }),
      "api/repos/will/smithers/bookmarks": json(200, { items: [{ name: "main", target_change_id: "qupxosqw", target_commit_id: "c0ffee1" }], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, [{ id: "snap-1", name: "golden", created_at: "2026-08-01T00:00:00Z" }]),
      "api/repos/will/smithers/workspace/sessions": json(200, []),
      "api/repos/will/smithers/workspaces/ws-1": () => {
        polls += 1
        return json(200, polls < 2 ? { ...WS_RUNNING, status: "starting" } : WS_RUNNING)
      }
    })
    const result = await seam.openWorkspace()
    expect(typeof result).toBe("object")
    // The create carried the repository's head bookmark as the source.
    expect(requests[0]).toBe("POST api/repos/will/smithers/workspaces")
    const card = cardOf(store)
    expect(card).toEqual(
      expect.objectContaining({
        kind: "workspace",
        title: "review · will/smithers",
        payload: expect.objectContaining({
          workspaceId: "ws-1",
          repo: "will/smithers",
          name: "review",
          targetBookmark: "main",
          bookmarkHead: { changeId: "qupxosqw", commitId: "c0ffee1" },
          snapshots: [{ id: "snap-1", name: "golden", createdAt: "2026-08-01T00:00:00Z" }],
          sessions: []
        })
      })
    )
    // The card never lags the collection, whichever landed last — the act's answer or the watch's first poll.
    expect(payloadOf(store)?.status).toBe(workspacesOf(store)[0]?.status)
    // The watch settles the row and the card, then stops.
    await wait(30)
    expect(workspacesOf(store)[0]).toEqual(expect.objectContaining({ id: "ws-1", status: "running" }))
    expect(payloadOf(store)?.status).toBe("running")
    const getPolls = requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1").length
    await wait(20)
    expect(requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1").length).toBe(getPolls)
    // Never a kind, an uptime, or a workspace head.
    expect(JSON.stringify(cardOf(store))).not.toContain("uptime")
    expect(JSON.stringify(cardOf(store))).not.toContain("workspaceHead")
  })

  /*
   * Critique finding 6: the aux loads finished after the watch's first
   * poll had settled the row, and the final render wrote the create's
   * `pending` back over the card while the tree read `running`.
   */
  test("a poll that settles before the auxiliaries load wins: card, tree, and collection agree and no watch remains", async () => {
    const delayed = (body: unknown) => async () => {
      await wait(30)
      return json(200, body)
    }
    const { store, seam, requests } = await harness({
      "POST api/repos/will/smithers/workspaces": json(202, { ...WS_RUNNING, status: "pending", provisioning_stage: "allocating" }),
      "api/repos/will/smithers/workspaces/ws-1": json(200, WS_RUNNING),
      "api/repos/will/smithers/bookmarks": delayed({ items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": delayed([]),
      "api/repos/will/smithers/workspace/sessions": delayed([])
    })
    const result = await seam.openWorkspace()
    expect(typeof result).toBe("object")
    expect(workspacesOf(store)[0]?.status).toBe("running")
    expect(copiesOf(store)[0]?.state).toBe("running")
    expect(payloadOf(store)?.status).toBe("running")
    expect(payloadOf(store)?.provisioningStage).toBeNull()
    const polls = requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1").length
    await wait(20)
    expect(requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1").length).toBe(polls)
  })

  test("view renders the collection's status when a poll advanced it during the auxiliaries", async () => {
    let gets = 0
    const delayed = (body: unknown) => async () => {
      await wait(30)
      return json(200, body)
    }
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces/ws-1": () => {
        gets += 1
        return json(200, gets === 1 ? { ...WS_RUNNING, status: "starting", provisioning_stage: "boot" } : WS_RUNNING)
      },
      "api/repos/will/smithers/bookmarks": delayed({ items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": delayed([]),
      "api/repos/will/smithers/workspace/sessions": delayed([])
    })
    await seedWorkspace(store, { ...wsRow, status: "starting", provisioningStage: "boot" })
    const result = await seam.viewWorkspace("ws-1")
    expect(typeof result).toBe("object")
    expect(payloadOf(store)?.status).toBe(workspacesOf(store)[0]?.status)
    expect(payloadOf(store)?.status).toBe("running")
  })

  test("open names an explicit bookmark and an explicit repo", async () => {
    const { seam, requests } = await harness({
      "POST api/repos/will/smithers/workspaces": json(201, WS_RUNNING),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    const result = await seam.openWorkspace("dev", "will/smithers")
    expect(typeof result).toBe("object")
    expect(requests[0]).toBe("POST api/repos/will/smithers/workspaces")
  })

  test("open without a target is an honest choice", async () => {
    const { store, seam } = await harness({})
    await store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [
        { id: "a/a", org: "a", ownerKind: "user", name: "a", head: null },
        { id: "b/b", org: "b", ownerKind: "user", name: "b", head: null }
      ]
    })
    const refusal = await seam.openWorkspace()
    expect(typeof refusal).toBe("string")
    expect(refusal).toContain("name one as owner/repo")
  })
})

describe("workspace seam acts", () => {
  test("suspend posts and renders the settled row; a failure rides the card", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/suspend": json(200, { ...WS_RUNNING, status: "suspended" })
    })
    await seedWorkspace(store)
    const result = await seam.suspendWorkspace("ws-1")
    expect(typeof result).toBe("object")
    expect(workspacesOf(store)[0]?.status).toBe("suspended")
    expect(copiesOf(store)[0]?.state).toBe("suspended")
    expect(payloadOf(store)?.status).toBe("suspended")
  })

  test("suspend failure keeps the refusal on the card", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/suspend": json(500, { message: "driver exploded" })
    })
    await seedWorkspace(store)
    const refusal = await seam.suspendWorkspace("ws-1")
    expect(refusal).toBe("driver exploded")
    expect(payloadOf(store)?.error).toBe("driver exploded")
    expect(workspacesOf(store)[0]?.status).toBe("running")
  })

  test("a bare act resolves the active workspace copy", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/suspend": json(200, { ...WS_RUNNING, status: "suspended" })
    })
    await seedWorkspace(store)
    await seedWorkspace(store, { ...wsRow, id: "ws-2", name: "bench" })
    await store.dispatch({ type: "repo.selected", actor: "user", id: "will/smithers#workspace:ws-1" })
    const result = await seam.suspendWorkspace()
    expect(typeof result).toBe("object")
    expect(workspacesOf(store).find((row) => row.id === "ws-1")?.status).toBe("suspended")
  })

  test("a bare act with several loaded and none active is an honest choice", async () => {
    const { store, seam } = await harness({})
    await seedWorkspace(store)
    await seedWorkspace(store, { ...wsRow, id: "ws-2", name: "bench" })
    const refusal = await seam.suspendWorkspace()
    expect(typeof refusal).toBe("string")
    expect(refusal).toContain("name a workspace id")
  })

  test("fork renders the fork's own card", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/fork": json(201, { ...WS_RUNNING, id: "ws-9", name: "review-fork" })
    })
    await seedWorkspace(store)
    const result = await seam.forkWorkspace("ws-1", "review-fork")
    expect(typeof result).toBe("object")
    expect(workspacesOf(store).map((row) => row.id).sort()).toEqual(["ws-1", "ws-9"])
    expect(cardOf(store, "ws-9")?.title).toBe("review-fork · will/smithers")
  })

  /*
   * Critique finding 5: the typed-name gate lived only in the card's
   * chrome; the flow deleted on one click. The name now rides the payload
   * and the seam refuses a mismatch, whoever invoked.
   */
  test("delete refuses unless the workspace's name is typed back, and never calls plue for a mismatch", async () => {
    const { store, seam, requests } = await harness({
      "DELETE api/repos/will/smithers/workspaces/ws-1": json(204, null),
      "api/repos/will/smithers/workspaces": json(200, [])
    })
    await seedWorkspace(store)
    for (const typed of ["", "revie", "Review", "ws-1"]) {
      const refusal = await seam.deleteWorkspace("ws-1", typed)
      expect(typeof refusal).toBe("string")
      expect(refusal).toContain("needs its name typed back exactly")
      expect(refusal).toContain("/workspace.delete ws-1 review")
    }
    expect(requests).toEqual([])
    expect(workspacesOf(store).map((row) => row.id)).toEqual(["ws-1"])
  })

  test("delete with the name removes the card, the row, the copy, and the terminal tab together, then refreshes the list", async () => {
    const { store, seam, requests } = await harness({
      "DELETE api/repos/will/smithers/workspaces/ws-1": json(204, null),
      "api/repos/will/smithers/workspaces": json(200, [])
    })
    await seedWorkspace(store)
    await seedCard(store, "sess-1")
    await seedWorkspaceTab(store)
    const result = await seam.deleteWorkspace("ws-1", "review")
    expect(typeof result).toBe("object")
    expect(requests[0]).toBe("DELETE api/repos/will/smithers/workspaces/ws-1")
    expect(requests[1]).toBe("GET api/repos/will/smithers/workspaces")
    expect(workspacesOf(store)).toEqual([])
    expect(copiesOf(store)).toEqual([])
    expect(cardOf(store)).toBeUndefined()
    expect(tabsOf(store)).toEqual([])
    expect(store.session().activeTabId).toBe("main")
  })
})

describe("workspace seam snapshots", () => {
  test("snapshot takes one and refreshes the card's list", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces/ws-1/snapshot": json(201, { id: "snap-2", name: "checkpoint", created_at: null }),
      "api/repos/will/smithers/workspace-snapshots": json(200, [
        { id: "snap-1", name: "golden", created_at: null },
        { id: "snap-2", name: "checkpoint", created_at: null }
      ])
    })
    await seedWorkspace(store)
    const result = await seam.snapshotWorkspace("ws-1", "checkpoint")
    expect(typeof result).toBe("object")
    const payload = payloadOf(store)
    expect(payload?.snapshots.map((snapshot) => snapshot.id)).toEqual(["snap-1", "snap-2"])
  })

  test("fork from a snapshot creates a workspace on the snapshot's image", async () => {
    const { store, seam, requests } = await harness({
      "POST api/repos/will/smithers/workspaces": json(201, { ...WS_RUNNING, id: "ws-7", name: "golden-copy", target_bookmark: null })
    })
    await seedWorkspace(store)
    const result = await seam.forkFromSnapshot("snap-1", "ws-1")
    expect(typeof result).toBe("object")
    expect(requests[0]).toBe("POST api/repos/will/smithers/workspaces")
    expect(workspacesOf(store).map((row) => row.id).sort()).toEqual(["ws-1", "ws-7"])
    expect(cardOf(store, "ws-7")?.title).toBe("golden-copy · will/smithers")
  })

  test("template snapshots from the snapshot's own workspace", async () => {
    const { store, seam, requests } = await harness({
      "api/repos/will/smithers/workspace-snapshots/snap-1": json(200, { id: "snap-1", name: "golden", workspace_id: "ws-1", created_at: null }),
      "POST api/repos/will/smithers/workspace-snapshots": json(201, { id: "tpl-1", name: "base-image", created_at: null }),
      "api/repos/will/smithers/workspace-snapshots": json(200, [{ id: "tpl-1", name: "base-image", created_at: null }])
    })
    await seedWorkspace(store)
    const result = await seam.templateSnapshot("snap-1", "base-image", "ws-1")
    expect(typeof result).toBe("object")
    expect(requests).toContain("GET api/repos/will/smithers/workspace-snapshots/snap-1")
    expect(requests).toContain("POST api/repos/will/smithers/workspace-snapshots")
    const payload = payloadOf(store)
    expect(payload?.snapshots).toEqual([{ id: "tpl-1", name: "base-image", createdAt: null }])
  })

  test("delete snapshot refreshes the card", async () => {
    const { store, seam } = await harness({
      "DELETE api/repos/will/smithers/workspace-snapshots/snap-1": json(204, null),
      "api/repos/will/smithers/workspace-snapshots": json(200, [])
    })
    await seedWorkspace(store)
    const result = await seam.deleteSnapshot("snap-1", "ws-1")
    expect(typeof result).toBe("object")
    const payload = payloadOf(store)
    expect(payload?.snapshots).toEqual([])
  })
})

describe("workspace seam terminal", () => {
  test("a suspended workspace refuses honestly and says how to fix it", async () => {
    const { store, seam } = await harness({})
    await seedWorkspace(store, { ...wsRow, status: "suspended" })
    const refusal = await seam.openTerminal("ws-1")
    expect(typeof refusal).toBe("string")
    expect(refusal).toContain("suspended")
    expect(refusal).toContain("/workspace.resume")
    expect(tabsOf(store)).toEqual([])
  })

  test("open creates a session, waits for running, and opens the workspace tab", async () => {
    let polls = 0
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspace/sessions": json(201, { id: "sess-1", status: "pending", workspace_id: "ws-1", created_at: null }),
      "api/repos/will/smithers/workspace/sessions/sess-1": () => {
        polls += 1
        return json(200, { id: "sess-1", status: polls < 2 ? "pending" : "running", workspace_id: "ws-1", created_at: null })
      },
      "api/repos/will/smithers/workspace/sessions": json(200, [{ id: "sess-1", status: "running", workspace_id: "ws-1", created_at: null }])
    })
    await seedWorkspace(store)
    const result = await seam.openTerminal("ws-1")
    expect(typeof result).toBe("object")
    expect(polls).toBeGreaterThanOrEqual(2)
    const tab = store.collections.tabs.get("sess-1")
    expect(tab).toEqual(
      expect.objectContaining({
        id: "sess-1",
        kind: "terminal",
        sessionId: "sess-1",
        workspaceId: "ws-1",
        repo: "will/smithers",
        repoKey: "workspace:ws-1"
      })
    )
    // A workspace terminal carries no local cwd.
    expect(tab?.kind === "terminal" ? tab.cwd : "x").toBeUndefined()
    const payload = payloadOf(store)
    expect(payload?.terminalSessionId).toBe("sess-1")
    expect(payload?.facet).toBe("terminal")
    expect(payload?.sessions).toEqual([{ id: "sess-1", status: "running", createdAt: null }])
  })

  test("a live attached session re-attaches instead of creating", async () => {
    const { store, seam, requests } = await harness({
      "api/repos/will/smithers/workspace/sessions/sess-1": json(200, { id: "sess-1", status: "running", workspace_id: "ws-1", created_at: null })
    })
    await seedWorkspace(store)
    await seedCard(store, "sess-1")
    const result = await seam.openTerminal("ws-1")
    expect(typeof result).toBe("object")
    expect(requests).not.toContain("POST api/repos/will/smithers/workspace/sessions")
    expect(store.collections.tabs.get("sess-1")).toBeDefined()
  })

  test("destroy session detaches the card that pointed at it and closes its tab in the same transaction", async () => {
    const { store, seam, dispatched } = await harness({
      "POST api/repos/will/smithers/workspace/sessions/sess-1/destroy": json(204, null),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seedWorkspace(store)
    await seedCard(store, "sess-1")
    await seedWorkspaceTab(store, "sess-1")
    await seedWorkspaceTab(store, "sess-2")
    const result = await seam.destroySession("sess-1", "ws-1")
    expect(typeof result).toBe("object")
    const payload = payloadOf(store)
    expect(payload?.terminalSessionId).toBeUndefined()
    expect(payload?.sessions).toEqual([])
    expect(tabsOf(store)).toEqual(["sess-2"])
    // The one transition did both: as it left the store, the tab was gone AND the card no longer pointed at the session.
    const destroyed = dispatched.find((entry) => entry.type === "workspace.session.destroyed")
    expect(destroyed).toEqual({ type: "workspace.session.destroyed", tabs: ["sess-2"], attached: undefined })
    expect(dispatched[0]?.type).toBe("workspace.session.destroyed")
  })
})

describe("workspace seam watch", () => {
  test("a 404 mid-watch re-reads the repository's list and the row leaves", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces": json(201, { ...WS_RUNNING, status: "pending" }),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, []),
      "api/repos/will/smithers/workspaces/ws-1": json(404, { message: "gone" }),
      "api/repos/will/smithers/workspaces": json(200, [])
    })
    await seam.openWorkspace()
    await wait(30)
    expect(workspacesOf(store)).toEqual([])
    expect(copiesOf(store)).toEqual([])
  })

  test("the watch stops when the cloud session signs out", async () => {
    const { store, seam, requests } = await harness({
      "POST api/repos/will/smithers/workspaces": json(201, { ...WS_RUNNING, status: "pending" }),
      "api/repos/will/smithers/bookmarks": json(200, { items: [], next_cursor: "" }),
      "api/repos/will/smithers/workspace-snapshots": json(200, []),
      "api/repos/will/smithers/workspace/sessions": json(200, []),
      "api/repos/will/smithers/workspaces/ws-1": json(200, { ...WS_RUNNING, status: "pending" })
    })
    await seam.openWorkspace()
    await wait(10)
    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-out", username: null, expiresAt: null, scopes: null })
    await wait(5)
    const polls = requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1").length
    await wait(30)
    expect(requests.filter((key) => key === "GET api/repos/will/smithers/workspaces/ws-1").length).toBe(polls)
  })
})

describe("workspace tabs and the cloud session", () => {
  /* Critique finding 4 (renderer half): sign-out closes every workspace terminal tab with the session record. */
  test("a signed-out session record closes the workspace terminal tabs and only those", async () => {
    const { store } = await harness({})
    await seedWorkspace(store)
    await seedWorkspaceTab(store, "sess-1")
    await store.dispatch({
      type: "tab.opened",
      actor: "user",
      tab: { id: "local-1", kind: "terminal", title: "Terminal", sessionId: "local-1", cwd: "/tmp/x" }
    })
    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-out", username: null, expiresAt: null, scopes: null })
    expect(tabsOf(store)).toEqual(["local-1"])
  })
})

describe("workspace seam facets", () => {
  test("setFacet renders the facet and refreshes what it shows", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspace-snapshots": json(200, [{ id: "snap-1", name: "golden", created_at: null }])
    })
    await seedWorkspace(store)
    const refusal = await seam.setFacet("ws-1", "snapshots")
    expect(refusal).toBeUndefined()
    const payload = payloadOf(store)
    expect(payload?.facet).toBe("snapshots")
    expect(payload?.snapshots).toEqual([{ id: "snap-1", name: "golden", createdAt: null }])
  })
})
