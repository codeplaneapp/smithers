import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { CLOUD_ROUTE_PREFIX } from "smithers-shared/LocalApp"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import {
  createLinearSeam,
  NO_OPS_FEED_NOTE,
  NO_OP_RETRY_REFUSAL,
  NO_TEAM_PICK_NOTE,
  SETUP_EXPIRED_NOTE,
  SIGN_OUT_REFUSAL
} from "./LinearSeam"
import type { LinearSeamDeps } from "./LinearSeam"
import type { SeamContext } from "./SeamContext"

/*
 * The Linear seam (lane sync, ADR 0005): the connector-setup card is the
 * wizard (handoff → team → repository → confirm → connected), sync and
 * activity render the sync-ops card, disconnect removes the card, and the
 * routes that do not exist (plue#468 ops/retry, plue#469 setup lookup)
 * degrade with the ADR's wording and are never faked. Every route is a
 * double; nothing is faked.
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

/* plue's chi router answers an unrouted path with this plain text — the shape prod gives today. */
const chiNotFound = (): Response => new Response("404 page not found", { status: 404 })

const INTEGRATION = {
  id: 7,
  linear_team_id: "team-eng",
  linear_team_key: "ENG",
  linear_team_name: "Engineering",
  repo_owner: "will",
  repo_name: "smithers",
  is_active: true,
  last_sync_at: "2026-09-02T09:00:00Z",
  created_at: "2026-09-01T10:00:00Z"
}

const SETUP = {
  teams: [
    { id: "team-eng", name: "Engineering", key: "ENG" },
    { id: "team-design", name: "Design", key: "DES" }
  ],
  expires_at: "2099-09-02T12:00:00Z",
  viewer: { id: "u1", email: "will@example.com", name: "Will" }
}

/* A route sees the request init, so a double can record the body a write posted. */
type Route = (init?: RequestInit) => Response

const harness = async (
  routes: Record<string, Route>,
  options: { readonly signedIn?: boolean } & LinearSeamDeps = {}
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
      if (route === undefined) return chiNotFound()
      return route(init)
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
      scopes: null
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
  const { signedIn: _signedIn, ...deps } = options
  return { store, seam: createLinearSeam(ctx, deps), requests }
}

const textOf = (result: unknown): string | undefined =>
  typeof result === "string" ? result : (result as { value?: string } | null | undefined)?.value

const cardOf = (store: AppStore) => store.collections.cards.get("connector-setup-linear-will/smithers")

const payloadOf = (store: AppStore) => {
  const card = cardOf(store)
  return card?.kind === "connector-setup" ? card.payload : undefined
}

const syncPayloadOf = (store: AppStore) => {
  const card = store.collections.cards.get("sync-ops-linear-7")
  return card?.kind === "sync-ops" ? card.payload : undefined
}

/** The authorized handoff: session answers waiting once, then the setup key. */
const authorizedSession = (): Route => {
  let polls = 0
  return () => {
    polls += 1
    return json(200, polls < 2 ? { state: "waiting" } : { state: "authorized", setupKey: "sk-123" })()
  }
}

describe("createLinearSeam", () => {
  test("signed out, every act refuses with the sign-in wording", async () => {
    const { seam } = await harness({}, { signedIn: false })

    expect(textOf(await seam.connect())).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.openLinear())).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.confirmConnect())).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.syncNow("7"))).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.activity())).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.disconnect("7"))).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.retryOp("op-1"))).toBe(SIGN_OUT_REFUSAL)
  })

  test("connect upserts the wizard card with the active authorize step", async () => {
    const { store, seam } = await harness({})

    const result = await seam.connect()

    expect(textOf(result)).toBe("Connect Linear on will/smithers — the card walks the handoff.")
    const payload = payloadOf(store)
    expect(payload?.connector).toBe("linear")
    expect(payload?.repo).toBe("will/smithers")
    expect(payload?.phase).toBe("setup")
    expect(payload?.steps).toEqual([
      { id: "authorize", label: "Authorize in your browser", state: "active", detail: null },
      { id: "team", label: "Team", state: "pending", detail: null },
      { id: "repository", label: "Repository", state: "pending", detail: "will/smithers" },
      { id: "confirm", label: "Confirm", state: "pending", detail: null }
    ])
  })

  test("openLinear runs the handoff, lists the teams, and advances the card", async () => {
    const opened: Array<string> = []
    const { store, seam, requests } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.jjhub.tech/api/auth/linear?callback_port=9" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": json(200, SETUP)
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async (url) => (opened.push(url), true) }
    )
    await seam.connect()

    await seam.openLinear()

    expect(opened).toEqual(["https://api.jjhub.tech/api/auth/linear?callback_port=9"])
    expect(requests).toContain("POST /api/linear-auth/start")
    expect(requests).toContain("GET api/linear/setup/sk-123")
    const payload = payloadOf(store)
    expect(payload?.setupKey).toBe("sk-123")
    expect(payload?.actor).toBe("Will")
    expect(payload?.teams).toEqual(SETUP.teams)
    expect(payload?.steps.find((step) => step.id === "authorize")).toEqual({
      id: "authorize",
      label: "Authorize in your browser",
      state: "done",
      detail: "authorized as Will"
    })
    expect(payload?.steps.find((step) => step.id === "team")?.state).toBe("active")
  })

  test("openLinear with no setup route degrades the team pick with the plue#469 wording", async () => {
    const { store, seam } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.jjhub.tech/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession()
        /* api/linear/setup/sk-123 is unrouted: chi's plain 404, like prod today. */
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async () => true }
    )
    await seam.connect()

    const result = await seam.openLinear()

    expect(result).toBe(NO_TEAM_PICK_NOTE)
    const payload = payloadOf(store)
    expect(payload?.steps.find((step) => step.id === "authorize")?.state).toBe("done")
    const team = payload?.steps.find((step) => step.id === "team")
    expect(team?.state).toBe("error")
    expect(team?.error).toBe(NO_TEAM_PICK_NOTE)
  })

  test("openLinear with an expired setup key reads authorization expired", async () => {
    const { store, seam } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.jjhub.tech/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": json(404, { message: "linear oauth setup not found or expired" })
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async () => true }
    )
    await seam.connect()

    const result = await seam.openLinear()

    expect(result).toBe(SETUP_EXPIRED_NOTE)
    const authorize = payloadOf(store)?.steps.find((step) => step.id === "authorize")
    expect(authorize?.state).toBe("error")
    expect(authorize?.error).toBe(SETUP_EXPIRED_NOTE)
  })

  test("pickTeam marks the team and activates the repository step", async () => {
    const { store, seam } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.jjhub.tech/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": json(200, SETUP)
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async () => true }
    )
    await seam.connect()
    await seam.openLinear()

    await seam.pickTeam("team-eng")
    const payload = payloadOf(store)
    expect(payload?.teamId).toBe("team-eng")
    expect(payload?.steps.find((step) => step.id === "team")).toEqual({
      id: "team",
      label: "Team",
      state: "done",
      detail: "ENG · Engineering"
    })
    expect(payload?.steps.find((step) => step.id === "repository")?.state).toBe("active")

    expect(await seam.pickTeam("team-nope")).toBe("Team team-nope is not one this authorization can see.")
  })

  test("confirmConnect posts the integration and turns the card connected", async () => {
    const { store, seam, requests } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.jjhub.tech/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": json(200, SETUP),
        "POST api/linear": json(201, INTEGRATION),
        "api/linear": json(200, [INTEGRATION])
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async () => true }
    )
    await seam.connect()
    await seam.openLinear()
    await seam.pickTeam("team-eng")

    const result = await seam.confirmConnect()

    expect(requests).toContain("POST api/linear")
    expect(textOf(result)).toBe("Linear ENG connected to will/smithers — the card tracks it.")
    const card = cardOf(store)
    expect(card?.title).toBe("Linear · ENG → will/smithers")
    expect(card?.status).toBe("acted")
    const payload = payloadOf(store)
    expect(payload?.phase).toBe("connected")
    expect(payload?.integration).toEqual({
      id: 7,
      teamKey: "ENG",
      teamName: "Engineering",
      active: true,
      lastSyncAt: "2026-09-02T09:00:00Z"
    })
    expect(payload?.steps.every((step) => step.state === "done")).toBe(true)
    /* The integrations collection carries the row the refresh read. */
    const row = store.collections.linearIntegrations.get("7")
    expect(row?.teamKey).toBe("ENG")
    expect(row?.lastSyncAt).toBe("2026-09-02T09:00:00Z")
  })

  test("picking another repository at step 3 keeps the card, and Connect posts the picked repository", async () => {
    /*
     * Review finding 1: the card id is keyed on the repository the wizard
     * opened on, while step 3 rewrites payload.repo — and the card's Connect
     * passes payload.repo. Resolving the card by that repo alone found no
     * card, so the wizard could never complete for anything but the default.
     */
    const posted: Array<unknown> = []
    const picked = { ...INTEGRATION, repo_owner: "acme", repo_name: "flows" }
    let integrations: Array<unknown> = []
    const { store, seam } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.jjhub.tech/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": json(200, SETUP),
        "POST api/linear": (init) => {
          posted.push(JSON.parse(String(init?.body)))
          integrations = [picked]
          return json(201, picked)()
        },
        "api/linear": () => json(200, integrations)(),
        "DELETE api/linear/7": () => {
          integrations = []
          return new Response(null, { status: 204 })
        }
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async () => true }
    )
    await seam.connect()
    await seam.openLinear()
    await seam.pickTeam("team-eng")

    await seam.pickRepository("will/smithers", "acme/flows")
    expect(cardOf(store)?.title).toBe("Connect Linear · acme/flows")
    expect(payloadOf(store)?.repo).toBe("acme/flows")
    expect(payloadOf(store)?.steps.find((step) => step.id === "repository")?.detail).toBe("acme/flows")

    /* The card's Connect button passes the picked repository, not the opening one. */
    const result = await seam.confirmConnect("acme/flows")

    expect(textOf(result)).toBe("Linear ENG connected to acme/flows — the card tracks it.")
    expect(posted).toEqual([{ setup_key: "sk-123", linear_team_id: "team-eng", repo: "acme/flows" }])
    /* The SAME card turned connected — no second card under the picked repo's id. */
    expect(store.collections.cards.get("connector-setup-linear-acme/flows")).toBeUndefined()
    expect(cardOf(store)?.title).toBe("Linear · ENG → acme/flows")
    expect(payloadOf(store)?.phase).toBe("connected")
    expect(payloadOf(store)?.integration?.id).toBe(7)

    /* Disconnect finds that same card, keyed on the opening repository. */
    await seam.disconnect("7", "ENG")
    expect(cardOf(store)).toBeUndefined()
  })

  test("confirmConnect before the team pick names the missing step", async () => {
    const { seam } = await harness({})
    await seam.connect()

    expect(await seam.confirmConnect()).toBe("Step 1 first: Open Linear and authorize.")
  })

  test("syncNow starts the sync and renders the sync-ops card with the degraded feed note", async () => {
    const { store, seam } = await harness({
      "api/linear": json(200, [INTEGRATION]),
      "POST api/linear/7/sync": json(202, { status: "sync_started" })
    })

    const result = await seam.syncNow()

    expect(textOf(result)).toBe("Sync started for Linear ENG ↔ will/smithers — the card tracks it.")
    const payload = syncPayloadOf(store)
    expect(payload?.subject).toBe("Linear ENG ↔ will/smithers")
    expect(payload?.trigger).toBe("sync started")
    expect(payload?.runState).toBeNull()
    expect(payload?.ops).toEqual([])
    expect(payload?.opsNote).toBe(NO_OPS_FEED_NOTE)
  })

  test("syncNow on an already-running sync says so; a 422 op error lands on the card", async () => {
    const { store, seam } = await harness({
      "api/linear": json(200, [INTEGRATION]),
      "POST api/linear/7/sync": json(409, { status: "sync_already_running" })
    })
    await seam.syncNow("ENG")
    expect(syncPayloadOf(store)?.trigger).toBe("already running")

    const failing = await harness({
      "api/linear": json(200, [INTEGRATION]),
      "POST api/linear/7/sync": json(422, { message: "pushing op 3 failed: remote rejected" })
    })
    const result = await failing.seam.syncNow("7")
    expect(textOf(result)).toBe("pushing op 3 failed: remote rejected")
    expect(syncPayloadOf(failing.store)?.error).toBe("pushing op 3 failed: remote rejected")
    expect(failing.store.collections.cards.get("sync-ops-linear-7")?.status).toBe("error")
  })

  test("a sync refusal carrying both a status token and a message shows the message verbatim", async () => {
    /* Review finding 13: the machine token led, so the server's sentence never reached the card. */
    const { store, seam } = await harness({
      "api/linear": json(200, [INTEGRATION]),
      "POST api/linear/7/sync": json(422, { status: "sync_failed", message: "Linear API: 422 label 'infra' does not exist" })
    })

    const result = await seam.syncNow("7")

    expect(textOf(result)).toBe("Linear API: 422 label 'infra' does not exist")
    expect(syncPayloadOf(store)?.error).toBe("Linear API: 422 label 'infra' does not exist")
  })

  test("syncNow with several integrations names them; with none, points at connect", async () => {
    const many = await harness({
      "api/linear": json(200, [
        INTEGRATION,
        { ...INTEGRATION, id: 9, linear_team_key: "DES", linear_team_name: "Design", linear_team_id: "team-design" }
      ])
    })
    expect(textOf(await many.seam.syncNow())).toBe(
      "linear.sync names an integration: ENG (7) → will/smithers, DES (9) → will/smithers."
    )

    const none = await harness({ "api/linear": json(200, []) })
    expect(textOf(await none.seam.syncNow())).toBe("No Linear integration is connected — /linear.connect opens the card.")
    expect(textOf(await none.seam.syncNow("ENG"))).toBe(
      "No Linear integration named ENG — none are connected. /linear.connect opens the card."
    )
  })

  test("activity renders the 24h card with the degraded feed note", async () => {
    const { store, seam } = await harness({ "api/linear": json(200, [INTEGRATION]) })

    const result = await seam.activity("ENG")

    expect(textOf(result)).toBe("The last 24 hours of Linear ENG — the feed is plue#468, the card says so.")
    expect(syncPayloadOf(store)?.window).toBe("24h")
    expect(syncPayloadOf(store)?.opsNote).toBe(NO_OPS_FEED_NOTE)
  })

  test("disconnect deletes the integration and removes the connected card", async () => {
    /* The list reads one integration before the delete, none after. */
    let integrations: Array<unknown> = [INTEGRATION]
    const { store, seam, requests } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.jjhub.tech/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": json(200, SETUP),
        "POST api/linear": json(201, INTEGRATION),
        "api/linear": () => json(200, integrations)(),
        "DELETE api/linear/7": () => {
          integrations = []
          return new Response(null, { status: 204 })
        }
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async () => true }
    )
    await seam.connect()
    await seam.openLinear()
    await seam.pickTeam("team-eng")
    await seam.confirmConnect()
    expect(store.collections.cards.get("connector-setup-linear-will/smithers")?.kind).toBe("connector-setup")

    /*
     * Review finding 4: disconnecting is consequential, so the team key typed
     * back is the confirm — without it (or with the wrong one) nothing is
     * deleted and the answer names the exact invocation.
     */
    expect(textOf(await seam.disconnect("7"))).toBe(
      "Disconnecting Linear ENG from will/smithers needs its team key typed back exactly — /linear.disconnect 7 ENG."
    )
    expect(textOf(await seam.disconnect("7", "DES"))).toBe(
      "Disconnecting Linear ENG from will/smithers needs its team key typed back exactly — /linear.disconnect 7 ENG."
    )
    expect(requests).not.toContain("DELETE api/linear/7")
    expect(store.collections.cards.get("connector-setup-linear-will/smithers")?.kind).toBe("connector-setup")

    const result = await seam.disconnect("7", "ENG")

    expect(requests).toContain("DELETE api/linear/7")
    expect(textOf(result)).toBe("Linear ENG disconnected from will/smithers.")
    expect(store.collections.linearIntegrations.get("7")).toBeUndefined()
    expect(store.collections.cards.get("connector-setup-linear-will/smithers")).toBeUndefined()
  })

  test("retryOp refuses with the plue#468 wording and never calls a route", async () => {
    const { seam, requests } = await harness({})

    expect(await seam.retryOp("op-3")).toBe(NO_OP_RETRY_REFUSAL)
    expect(requests).toEqual([])
    expect(await seam.retryOp(" ")).toBe("sync.retry needs an op id: /sync.retry <opId>")
  })
})
