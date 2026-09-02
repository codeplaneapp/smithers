import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { CLOUD_ROUTE_PREFIX } from "smithers-shared/LocalApp"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import {
  createChangeSeam,
  DEGRADED_CHANGE_REFUSAL,
  NO_INTERDIFF_REFUSAL,
  NO_RESOLVE_REFUSAL,
  NO_REVERT_REFUSAL,
  NO_REVISIONS_REFUSAL,
  NO_SPLIT_REFUSAL
} from "./ChangeSeam"
import type { SeamContext } from "./SeamContext"

/*
 * The changes seam (lane change, ADR 0003): the change card carries every
 * read; land rides the carrying landing request (queued) or the changeset
 * (synchronous, 409 re-reads); resolve/revert/split-ready and rev-pinned
 * reads refuse with the ADR's wording because their routes do not exist.
 * A degraded sign-in reads freely but cannot dispatch an agent.
 * Every route is a double; nothing is faked.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

/* A route factory: a Response's body is consumed once, so shared fixtures must build a fresh one per call. */
const json = (status: number, body: unknown): (() => Response) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const CHANGE = {
  change_id: "qupxosqw",
  commit_id: "a03f5f",
  description: "Add the split flow\n\nLong body.",
  author_name: "will",
  author_email: "will@example.com",
  timestamp: "2026-09-01T10:00:00Z",
  has_conflict: true,
  is_empty: false,
  parent_change_ids: ["mzxvbnmk"]
}

const DIFF = {
  change_id: "qupxosqw",
  file_diffs: [
    {
      path: "src/app.ts",
      change_type: "modified",
      patch: "@@ -1 +1 @@\n-old\n+new",
      is_binary: false,
      additions: 1,
      deletions: 1
    },
    {
      path: "docs/guide.md",
      change_type: "added",
      patch: "@@ -0,0 +1 @@\n+hello",
      is_binary: false,
      additions: 1,
      deletions: 0
    }
  ]
}

const LANDING = {
  number: 42,
  state: "open",
  change_ids: ["mzxvbnmk", "qupxosqw"],
  stack_size: 2,
  target_bookmark: "main",
  conflict_status: "none"
}

/** The four routes a `change.view` touches for a repo with no org and no landing. */
const viewRoutes: Record<string, Route> = {
  "api/repos/will/smithers/changes/qupxosqw": json(200, CHANGE),
  "api/repos/will/smithers/changes/qupxosqw/conflicts": json(200, [
    { file_path: "src/app.ts", conflict_type: "content", resolution_status: "unresolved" }
  ]),
  "api/repos/will/smithers/changes/qupxosqw/diff": json(200, DIFF),
  "api/repos/will/smithers/landings?limit=100": json(200, { items: [LANDING] }),
  "api/repos/will/smithers/commits/a03f5f/statuses?limit=100": json(200, {
    statuses: [
      { context: "build", status: "success", created_at: "2026-09-01T09:59:00Z" },
      { context: "build", status: "pending", created_at: "2026-09-01T09:00:00Z" },
      { context: "lint", status: "pending", created_at: "2026-09-01T09:59:00Z" }
    ]
  }),
  "api/repos/will/smithers/landings/42/reviews?limit=100": json(200, {
    reviews: [{ id: 1, reviewer_id: 9, type: "approve", body: "ship it", state: "active", created_at: "2026-09-01T10:01:00Z" }]
  }),
  "api/repos/will/smithers/landings/42/comments?limit=100": json(200, {
    comments: [{ id: 3, path: "src/app.ts", line: 12, side: "new", body: "why this?", created_at: "2026-09-01T10:02:00Z", user_id: 9 }]
  })
}

type Route = () => Response

const harness = async (
  routes: Record<string, Route>,
  options: { readonly signedIn?: boolean; readonly degraded?: boolean; readonly ownerKind?: "user" | "org" } = {}
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
      if (route === undefined) return json(404, { message: `no route ${key}` })()
      return route()
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
        ownerKind: options.ownerKind ?? "user",
        name: "smithers",
        head: { bookmark: "main", changeId: "qupxosqw", commitId: "c0ffee1" }
      }
    ]
  })
  return { store, seam: createChangeSeam(ctx), requests }
}

const textOf = (result: unknown): string | undefined =>
  typeof result === "string" ? result : (result as { value?: string } | null | undefined)?.value

const changeCardOf = (store: AppStore) => store.collections.cards.get("change-will/smithers-qupxosqw")
const diffCardOf = (store: AppStore) => store.collections.cards.get("diff-will/smithers-qupxosqw")

/** The change card's payload, narrowed; undefined when the card is absent. */
const payloadOf = (store: AppStore) => {
  const card = changeCardOf(store)
  return card?.kind === "change" ? card.payload : undefined
}

const diffPayloadOf = (store: AppStore) => {
  const card = diffCardOf(store)
  return card?.kind === "diff" ? card.payload : undefined
}

describe("createChangeSeam", () => {
  test("change.view loads the change row, every auxiliary, and renders the card", async () => {
    const { store, seam } = await harness(viewRoutes)
    const result = await seam.viewChange("qupxosqw")

    expect(textOf(result)).toBe("Change qupxosqw on will/smithers — the card tracks it.")
    const row = store.collections.changes.get("will/smithers#qupxosqw")
    expect(row?.changeId).toBe("qupxosqw")
    expect(row?.commitId).toBe("a03f5f")
    expect(row?.hasConflict).toBe(true)
    expect(row?.parentChangeIds).toEqual(["mzxvbnmk"])

    const payload = payloadOf(store)
    expect(payload?.repo).toBe("will/smithers")
    expect(payload?.description).toBe("Add the split flow\n\nLong body.")
    expect(payload?.commitId).toBe("a03f5f")
    expect(payload?.currentSeq).toBeNull()
    expect(payload?.revisions).toEqual([])
    expect(payload?.authorName).toBe("will")
    expect(payload?.repos).toEqual([{ repo: "will/smithers", additions: 2, deletions: 1 }])
    expect(payload?.diff?.from).toBe("parent")
    expect(payload?.diff?.to).toBe("current")
    expect(payload?.diff?.files).toHaveLength(2)
    expect(payload?.checks).toEqual([
      { context: "build", state: "success" },
      { context: "lint", state: "pending" }
    ])
    expect(payload?.reviews).toEqual([{ author: null, type: "approve", body: "ship it", commitId: null }])
    expect(payload?.threads).toHaveLength(1)
    expect(payload?.threads?.[0]?.state).toBeNull()
    expect(payload?.conflicts).toEqual([{ path: "src/app.ts", state: "unresolved" }])
    expect(payload?.stack).toEqual({
      landingNumber: 42,
      state: "open",
      position: 2,
      size: 2,
      targetBookmark: "main",
      conflictStatus: "none"
    })
    expect(payload?.changeset).toBeNull()
    const card = changeCardOf(store)
    expect(card?.title).toBe("qupxosqw · Add the split flow")
    expect(card?.status).toBe("active")
  })

  test("change.view with a rev refuses — the revision history doesn't exist yet (plue#450)", async () => {
    const { seam, requests } = await harness({})
    expect(textOf(await seam.viewChange("qupxosqw", 2))).toBe(NO_REVISIONS_REFUSAL)
    expect(requests).toEqual([])
  })

  test("change.view requires a signed-in session", async () => {
    const { seam, requests } = await harness({}, { signedIn: false })
    expect(textOf(await seam.viewChange("qupxosqw"))).toBe("Sign in to Smithers Cloud first — /cloud.sign-in.")
    expect(requests).toEqual([])
  })

  test("a degraded sign-in reads a change freely", async () => {
    const { store, seam } = await harness(viewRoutes, { degraded: true })
    const result = await seam.viewChange("qupxosqw")
    expect(textOf(result)).toBe("Change qupxosqw on will/smithers — the card tracks it.")
    expect(payloadOf(store)?.commitId).toBe("a03f5f")
  })

  test("change.view leaves an absent answer as an absent field when an auxiliary 404s", async () => {
    const { store, seam } = await harness({ "api/repos/will/smithers/changes/qupxosqw": json(200, CHANGE) })
    await seam.viewChange("qupxosqw")
    const payload = payloadOf(store)
    expect(payload?.diff).toBeNull()
    expect(payload?.checks).toBeNull()
    expect(payload?.reviews).toBeNull()
    expect(payload?.stack).toBeNull()
    expect(payload?.conflicts).toEqual([])
  })

  test("change.diff renders the diff card pinned at the change's commit; conflicted files lead", async () => {
    const { store, seam } = await harness({
      "api/repos/will/smithers/changes/qupxosqw": json(200, CHANGE),
      "api/repos/will/smithers/changes/qupxosqw/conflicts": json(200, [
        { file_path: "docs/guide.md", conflict_type: "content", resolution_status: "unresolved" }
      ]),
      "api/repos/will/smithers/changes/qupxosqw/diff": json(200, DIFF)
    })
    const result = await seam.diffChange("qupxosqw")

    expect(textOf(result)).toBe("Diff of qupxosqw (parent → current) — 2 files.")
    const payload = diffPayloadOf(store)
    expect(payload?.repo).toBe("will/smithers")
    expect(payload?.from).toBe("parent")
    expect(payload?.to).toBe("current")
    expect(payload?.pin).toEqual({ changeId: "qupxosqw", seq: null, commitId: "a03f5f" })
    expect(payload?.files[0]?.path).toBe("docs/guide.md")
    expect(payload?.files[0]?.conflicted).toBe(true)
    expect(payload?.files[1]?.conflicted).toBeUndefined()
  })

  test("change.diff on a single file keeps that file's hunk inline regardless of size", async () => {
    const bigPatch = Array.from({ length: 500 }, (_, index) => `+line ${index}`).join("\n")
    const { store, seam } = await harness({
      "api/repos/will/smithers/changes/qupxosqw": json(200, CHANGE),
      "api/repos/will/smithers/changes/qupxosqw/conflicts": json(200, []),
      "api/repos/will/smithers/changes/qupxosqw/diff": json(200, {
        change_id: "qupxosqw",
        file_diffs: [
          { path: "src/big.ts", change_type: "modified", patch: bigPatch, is_binary: false, additions: 500, deletions: 0 }
        ]
      })
    })
    const result = await seam.diffChange("qupxosqw", undefined, undefined, "src/big.ts")
    expect(diffPayloadOf(store)?.files[0]?.patch).toBe(bigPatch)
    expect(textOf(result)).toContain("1 file")
  })

  test("change.diff marks an oversized hunk by reference, not inline", async () => {
    const bigPatch = Array.from({ length: 500 }, (_, index) => `+line ${index}`).join("\n")
    const { store, seam } = await harness({
      "api/repos/will/smithers/changes/qupxosqw": json(200, CHANGE),
      "api/repos/will/smithers/changes/qupxosqw/conflicts": json(200, []),
      "api/repos/will/smithers/changes/qupxosqw/diff": json(200, {
        change_id: "qupxosqw",
        file_diffs: [
          { path: "src/big.ts", change_type: "modified", patch: bigPatch, is_binary: false, additions: 500, deletions: 0 }
        ]
      })
    })
    await seam.diffChange("qupxosqw")
    const file = diffPayloadOf(store)?.files[0]
    expect(file?.patch).toBeUndefined()
    expect(file?.patchLines).toBe(500)
  })

  test("change.diff between two revisions refuses — the interdiff doesn't exist (plue#451)", async () => {
    const { seam, requests } = await harness({})
    expect(textOf(await seam.diffChange("qupxosqw", "1", "3"))).toBe(NO_INTERDIFF_REFUSAL)
    expect(requests).toEqual([])
  })

  test("change.land queues the carrying landing request and re-reads", async () => {
    const { store, seam, requests } = await harness({
      ...viewRoutes,
      "PUT api/repos/will/smithers/landings/42/land": json(202, { status: "queued" })
    })
    const result = await seam.landChange("qupxosqw")

    expect(textOf(result)).toBe("Landing request #42 is queued — the card tracks it.")
    expect(requests).toContain("PUT api/repos/will/smithers/landings/42/land")
    expect(payloadOf(store)?.stack?.landingNumber).toBe(42)
  })

  test("change.land without a carrying landing request says so and names the way out", async () => {
    const { seam } = await harness({
      "api/repos/will/smithers/landings?limit=100": json(200, { items: [] })
    })
    expect(textOf(await seam.landChange("qupxosqw"))).toBe(
      "No landing request carries qupxosqw on will/smithers — /prs.create opens one."
    )
  })

  test("change.land lands the changeset through its own route when one carries the change", async () => {
    const changeset = {
      id: 7,
      organization: "will",
      description: "atom",
      state: "pending",
      failure_reason: null,
      change_id: "qupxosqw",
      commit_id: "a03f5f",
      target_bookmark: "main",
      members: []
    }
    const { seam, requests } = await harness(
      {
        "api/orgs/will/changesets": json(200, { changesets: [changeset] }),
        "POST api/orgs/will/changesets/7/land": json(200, { ...changeset, state: "landed" }),
        ...viewRoutes
      },
      { ownerKind: "org" }
    )
    const result = await seam.landChange("qupxosqw")

    expect(textOf(result)).toBe("Changeset 7 landed — every member bookmark moved together.")
    expect(requests).toContain("POST api/orgs/will/changesets/7/land")
    expect(requests.some((request) => request.startsWith("PUT /repos/"))).toBe(false)
  })

  test("change.land on a failed changeset re-reads and renders the failure reason", async () => {
    const changeset = {
      id: 7,
      organization: "will",
      description: "atom",
      state: "pending",
      failure_reason: null,
      change_id: "qupxosqw",
      commit_id: "a03f5f",
      target_bookmark: "main",
      members: []
    }
    const { store, seam } = await harness(
      {
        "api/orgs/will/changesets": json(200, { changesets: [changeset] }),
        "POST api/orgs/will/changesets/7/land": json(409, { message: "changeset land failed: bookmark moved" }),
        ...viewRoutes
      },
      { ownerKind: "org" }
    )
    const result = await seam.landChange("qupxosqw")

    expect(textOf(result)).toBe("changeset land failed: bookmark moved")
    expect(payloadOf(store)?.changeset?.state).toBe("pending")
  })

  test("change.split-ready refuses — the ready members aren't recorded (plue#452)", async () => {
    const changeset = {
      id: 7,
      organization: "will",
      description: "atom",
      state: "pending",
      failure_reason: null,
      change_id: "qupxosqw",
      commit_id: "a03f5f",
      target_bookmark: "main",
      members: []
    }
    const { seam } = await harness(
      { "api/orgs/will/changesets": json(200, { changesets: [changeset] }) },
      { ownerKind: "org" }
    )
    expect(textOf(await seam.splitReady("qupxosqw"))).toBe(NO_SPLIT_REFUSAL)
  })

  test("change.split-ready without a changeset says so", async () => {
    const { seam } = await harness({})
    expect(textOf(await seam.splitReady("qupxosqw"))).toBe(
      "Split ready members applies to a changeset — qupxosqw on will/smithers belongs to none."
    )
  })

  test("change.resolve refuses a degraded sign-in with the enable wording", async () => {
    const { seam, requests } = await harness({}, { degraded: true })
    expect(textOf(await seam.resolveConflict("qupxosqw", "src/app.ts"))).toBe(DEGRADED_CHANGE_REFUSAL)
    expect(requests).toEqual([])
  })

  test("change.resolve refuses honestly — the route doesn't exist (plue#455)", async () => {
    const { seam, requests } = await harness({})
    expect(textOf(await seam.resolveConflict("qupxosqw", "src/app.ts"))).toBe(NO_RESOLVE_REFUSAL)
    expect(requests).toEqual([])
  })

  test("change.revert refuses on an unlanded change", async () => {
    const { seam } = await harness({ "api/repos/will/smithers/landings?limit=100": json(200, { items: [LANDING] }) })
    expect(textOf(await seam.revertChange("qupxosqw"))).toBe(
      "Revert is offered on a landed change — qupxosqw has not landed (the landing request is open)."
    )
  })

  test("change.revert on a landed change refuses honestly — the route doesn't exist (plue#456)", async () => {
    const { seam } = await harness({
      "api/repos/will/smithers/landings?limit=100": json(200, { items: [{ ...LANDING, state: "merged" }] })
    })
    expect(textOf(await seam.revertChange("qupxosqw"))).toBe(NO_REVERT_REFUSAL)
  })

  test("change.facet switches the card's tab without re-reading", async () => {
    const { store, seam, requests } = await harness(viewRoutes)
    await seam.viewChange("qupxosqw")
    requests.length = 0

    const result = await seam.setFacet("qupxosqw", "checks")
    expect(result).toBeUndefined()
    expect(payloadOf(store)?.facet).toBe("checks")
    expect(payloadOf(store)?.checks).toHaveLength(2)
    expect(requests).toEqual([])
  })

  test("change.facet on an unread change names the way out", async () => {
    const { seam } = await harness({})
    expect(await seam.setFacet("qupxosqw", "checks")).toBe(
      "Change qupxosqw is not loaded — /change.view qupxosqw reads it first"
    )
  })

  test("a change act resolves the repo from the changes collection after a view", async () => {
    const { store, seam, requests } = await harness(viewRoutes)
    await seam.viewChange("qupxosqw")
    requests.length = 0
    await seam.setFacet("qupxosqw", "diff")
    expect(payloadOf(store)?.facet).toBe("diff")
    expect(requests).toEqual([])
  })
})
