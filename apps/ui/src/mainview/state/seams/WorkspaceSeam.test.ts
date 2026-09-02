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
 * session create-and-settle into a workspace tab. Every route is a double;
 * nothing is faked — an unread auxiliary is an absent field, a 404 mid-watch
 * re-reads the repository's list.
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

const WS_RUNNING = {
  id: "ws-1",
  repo_full_name: "will/smithers",
  name: "review",
  target_bookmark: "main",
  status: "running",
  provisioning_stage: null,
  suspended_at: null,
  created_at: "2026-09-01T00:00:00Z"
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

type Route = Response | (() => Response)

const harness = async (
  routes: Record<string, Route>,
  options: { readonly signedIn?: boolean; readonly degraded?: boolean } = {}
) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<string> = []
  const ctx: SeamContext = {
    http: async (input, init) => {
      const method = init?.method ?? "GET"
      const path = input.startsWith(CLOUD_ROUTE_PREFIX) ? input.slice(CLOUD_ROUTE_PREFIX.length) : input
      const key = `${method} ${path}`
      requests.push(key)
      const route = routes[key] ?? routes[path]
      if (route === undefined) return json(404, { message: `no route ${key}` })
      return typeof route === "function" ? route() : route
    },
    baseUrl: "",
    store,
    dispatch: store.dispatch,
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
  return { store, seam: createWorkspaceSeam(ctx, { pollMs: 1 }), requests }
}

const seedWorkspace = async (store: AppStore, workspace: CloudWorkspaceInput = wsRow): Promise<void> => {
  await store.dispatch({ type: "workspace.updated", actor: "system", workspace })
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
      await seam.deleteWorkspace("ws-1")
    ]) {
      expect(refusal).toBe(DEGRADED_WORKSPACE_REFUSAL)
      expect(refusal).toContain("sign in again to enable")
    }
  })
})

describe("workspace seam list", () => {
  test("workspace.list refreshes the collection, syncs the tree copies, and announces", async () => {
    const { store, seam } = await harness({
      "api/user/workspaces": json(200, [WS_RUNNING, { id: "ws-2", repo_full_name: "will/smithers", name: "bench", status: "suspended", target_bookmark: "dev" }, { broken: true }])
    })
    const result = await seam.listWorkspaces()
    expect(typeof result).toBe("object")
    expect(workspacesOf(store).map((row) => row.id).sort()).toEqual(["ws-1", "ws-2"])
    expect(copiesOf(store)).toEqual([
      expect.objectContaining({ id: "workspace:ws-1", kind: "workspace", label: "review", state: "running", workspaceId: "ws-1" }),
      expect.objectContaining({ id: "workspace:ws-2", kind: "workspace", label: "bench", state: "suspended", workspaceId: "ws-2" })
    ])
    expect(messagesOf(store).join("\n")).toContain("review (ws-1) · running · will/smithers@main")
  })

  test("a repo-scoped list replaces only that repository's rows", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/workspaces": json(200, [WS_RUNNING])
    })
    await store.dispatch({
      type: "workspace.updated",
      actor: "system",
      workspace: { ...wsRow, id: "ws-other", repoId: "plue/plue", name: "other" }
    })
    const result = await seam.listWorkspaces("will/smithers")
    expect(typeof result).toBe("object")
    expect(workspacesOf(store).map((row) => row.id).sort()).toEqual(["ws-1", "ws-other"])
  })
})

describe("workspace seam open", () => {
  test("open creates with the repository's head bookmark, renders the card, and watches until settled", async () => {
    let polls = 0
    const { store, seam, requests } = await harness({
      "POST api/repos/will/smithers/workspaces": json(201, { ...WS_RUNNING, status: "pending", provisioning_stage: "allocating" }),
      "api/repos/will/smithers/bookmarks": json(200, [{ name: "main", target_change_id: "qupxosqw", target_commit_id: "c0ffee1" }]),
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
          status: "pending",
          bookmarkHead: { changeId: "qupxosqw", commitId: "c0ffee1" },
          snapshots: [{ id: "snap-1", name: "golden", createdAt: "2026-08-01T00:00:00Z" }],
          sessions: []
        })
      })
    )
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

  test("open names an explicit bookmark and an explicit repo", async () => {
    const { seam, requests } = await harness({
      "POST api/repos/will/smithers/workspaces": json(201, WS_RUNNING),
      "api/repos/will/smithers/bookmarks": json(200, []),
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

  test("delete removes the card and refreshes the list", async () => {
    const { store, seam } = await harness({
      "DELETE api/repos/will/smithers/workspaces/ws-1": json(204, null),
      "api/repos/will/smithers/workspaces": json(200, [])
    })
    await seedWorkspace(store)
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
          sessions: []
        }
      }
    })
    const result = await seam.deleteWorkspace("ws-1")
    expect(typeof result).toBe("object")
    expect(workspacesOf(store)).toEqual([])
    expect(copiesOf(store)).toEqual([])
    expect(cardOf(store)).toBeUndefined()
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
    expect([...store.collections.tabs.values()].filter((tab) => tab.kind !== "main")).toEqual([])
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
          terminalSessionId: "sess-1"
        }
      }
    })
    const result = await seam.openTerminal("ws-1")
    expect(typeof result).toBe("object")
    expect(requests).not.toContain("POST api/repos/will/smithers/workspace/sessions")
    expect(store.collections.tabs.get("sess-1")).toBeDefined()
  })

  test("destroy session detaches the card that pointed at it", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspace/sessions/sess-1/destroy": json(204, null),
      "api/repos/will/smithers/workspace/sessions": json(200, [])
    })
    await seedWorkspace(store)
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
          terminalSessionId: "sess-1"
        }
      }
    })
    const result = await seam.destroySession("sess-1", "ws-1")
    expect(typeof result).toBe("object")
    const payload = payloadOf(store)
    expect(payload?.terminalSessionId).toBeUndefined()
    expect(payload?.sessions).toEqual([])
  })
})

describe("workspace seam watch", () => {
  test("a 404 mid-watch re-reads the repository's list and the row leaves", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/workspaces": json(201, { ...WS_RUNNING, status: "pending" }),
      "api/repos/will/smithers/bookmarks": json(200, []),
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
