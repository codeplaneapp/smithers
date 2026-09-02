import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { CLOUD_ROUTE_PREFIX } from "smithers-shared/LocalApp"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { createGitHubSeam, lowRateLimit, NO_MIRROR_OPS_NOTE, SIGN_OUT_REFUSAL, trustedInstallUrl } from "./GitHubSeam"
import type { GitHubSeamDeps } from "./GitHubSeam"
import type { SeamContext } from "./SeamContext"

/*
 * The GitHub seam (lane sync, ADR 0005): github.app renders the
 * connector-setup card from the status DTO (and files the row in the
 * collection), reconcile and mirror-sync surface the platform's own words
 * when their routes don't exist yet, and a structured 429 or a low
 * remaining budget renders the ADR's rate-limit line. Every route is a
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

const json = (status: number, body: unknown): (() => Response) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const STATUS_PATH = "api/repos/will/smithers/github-app-status"

const INSTALLED = {
  github_app_installed: true,
  github_app_configured: true,
  installation_id: 5511,
  install_url: "https://github.com/apps/smithers/installations/new"
}

const MISSING = {
  github_app_installed: false,
  github_app_configured: false,
  install_url: "https://github.com/apps/smithers/installations/new"
}

type Route = () => Response

const harness = async (
  routes: Record<string, Route>,
  options: { readonly signedIn?: boolean } & GitHubSeamDeps = {}
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
      if (route === undefined) return new Response("404 page not found", { status: 404 })
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
  return { store, seam: createGitHubSeam(ctx, deps), requests }
}

const textOf = (result: unknown): string | undefined =>
  typeof result === "string" ? result : (result as { value?: string } | null | undefined)?.value

const cardOf = (store: AppStore) => store.collections.cards.get("connector-setup-github-will/smithers")

const payloadOf = (store: AppStore) => {
  const card = cardOf(store)
  return card?.kind === "connector-setup" ? card.payload : undefined
}

const mirrorPayloadOf = (store: AppStore) => {
  const card = store.collections.cards.get("sync-ops-mirror-will/smithers")
  return card?.kind === "sync-ops" ? card.payload : undefined
}

describe("trustedInstallUrl", () => {
  test("only github.com https origins are trusted", () => {
    expect(trustedInstallUrl("https://github.com/apps/smithers/installations/new")).toBe(
      "https://github.com/apps/smithers/installations/new"
    )
    expect(trustedInstallUrl("http://github.com/apps/smithers")).toBeNull()
    expect(trustedInstallUrl("https://github.com.evil.example/apps")).toBeNull()
    expect(trustedInstallUrl("not a url")).toBeNull()
  })
})

describe("lowRateLimit", () => {
  test("under a fifth of the budget is low", () => {
    expect(lowRateLimit({ limit: 5000, remaining: 999 })).toBe(true)
    expect(lowRateLimit({ limit: 5000, remaining: 1000 })).toBe(false)
    expect(lowRateLimit({ limit: 0, remaining: 0 })).toBe(false)
  })
})

describe("createGitHubSeam", () => {
  test("signed out, every act refuses with the sign-in wording", async () => {
    const { seam } = await harness({}, { signedIn: false })

    expect(textOf(await seam.app())).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.openInstall())).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.reconcile())).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.mirrorSync())).toBe(SIGN_OUT_REFUSAL)
  })

  test("github.app files the status row and renders the connected card", async () => {
    const { store, seam } = await harness({ [STATUS_PATH]: json(200, INSTALLED) })

    const result = await seam.app()

    expect(textOf(result)).toBe("The Smithers GitHub App is installed on will/smithers — the card tracks it.")
    const row = store.collections.githubAppStatuses.get("will/smithers")
    expect(row?.installed).toBe(true)
    expect(row?.configured).toBe(true)
    expect(row?.installationId).toBe(5511)
    expect(row?.installUrl).toBe("https://github.com/apps/smithers/installations/new")
    const card = cardOf(store)
    expect(card?.title).toBe("GitHub · will/smithers")
    expect(card?.status).toBe("acted")
    const payload = payloadOf(store)
    expect(payload?.connector).toBe("github")
    expect(payload?.phase).toBe("connected")
    expect(payload?.installationId).toBe(5511)
    expect(payload?.configured).toBe(true)
  })

  test("github.app on a missing App renders the setup phase with the install link", async () => {
    const { store, seam } = await harness({ [STATUS_PATH]: json(200, MISSING) })

    const result = await seam.app()

    expect(textOf(result)).toBe(
      "The Smithers GitHub App is not installed on will/smithers — the card has the install link."
    )
    const payload = payloadOf(store)
    expect(payload?.phase).toBe("setup")
    expect(payload?.installUrl).toBe("https://github.com/apps/smithers/installations/new")
    expect(cardOf(store)?.status).toBe("active")
  })

  test("github.app with the rate-limit facts under a fifth renders the rate-limit line", async () => {
    const { store, seam } = await harness({
      [STATUS_PATH]: json(200, {
        ...INSTALLED,
        github_rate_limit_limit: 5000,
        github_rate_limit_remaining: 400,
        github_rate_limit_reset: "2026-09-02T13:00:00Z"
      })
    })

    await seam.app()

    expect(payloadOf(store)?.rateLimit).toEqual({ limit: 5000, remaining: 400, resetAt: "2026-09-02T13:00:00Z" })
    expect(store.collections.githubAppStatuses.get("will/smithers")?.rateLimit).toEqual({
      limit: 5000,
      remaining: 400,
      resetAt: "2026-09-02T13:00:00Z"
    })
  })

  test("github.app with a healthy budget renders no rate-limit line", async () => {
    const { store, seam } = await harness({
      [STATUS_PATH]: json(200, {
        ...INSTALLED,
        github_rate_limit_limit: 5000,
        github_rate_limit_remaining: 4900
      })
    })

    await seam.app()

    expect(payloadOf(store)?.rateLimit).toBeUndefined()
    /* The row still carries what the wire said; only the card's line is gated. */
    expect(store.collections.githubAppStatuses.get("will/smithers")?.rateLimit?.remaining).toBe(4900)
  })

  test("github.app on a structured 429 renders the refusal and the rate-limit facts", async () => {
    const { store, seam } = await harness({
      [STATUS_PATH]: json(429, {
        code: "github_rate_limited",
        message: "GitHub rate limit exhausted",
        limit: 5000,
        remaining: 0,
        reset_at: "2026-09-02T13:00:00Z"
      })
    })

    const result = await seam.app()

    expect(textOf(result)).toBe("GitHub rate limit exhausted")
    const payload = payloadOf(store)
    expect(payload?.error).toBe("GitHub rate limit exhausted")
    expect(payload?.rateLimit).toEqual({ limit: 5000, remaining: 0, resetAt: "2026-09-02T13:00:00Z" })
    expect(cardOf(store)?.status).toBe("error")
    /* No row: nothing was READ, only refused. */
    expect(store.collections.githubAppStatuses.get("will/smithers")).toBeUndefined()
  })

  test("github.app on a plain 429 invents no reset", async () => {
    const { store, seam } = await harness({ [STATUS_PATH]: json(429, { message: "too many requests" }) })

    const result = await seam.app()

    expect(textOf(result)).toBe("too many requests")
    expect(payloadOf(store)?.rateLimit).toBeUndefined()
  })

  test("openInstall opens the trusted install link from the card", async () => {
    const opened: Array<string> = []
    const { seam } = await harness(
      { [STATUS_PATH]: json(200, MISSING) },
      { openExternal: async (url) => (opened.push(url), true) }
    )
    await seam.app()

    await seam.openInstall()

    expect(opened).toEqual(["https://github.com/apps/smithers/installations/new"])
  })

  test("openInstall before any status read points at github.app first", async () => {
    const { seam } = await harness({})

    expect(await seam.openInstall()).toBe("No install link for will/smithers yet — /github.app reads the status first.")
  })

  test("reconcile with no route shows the platform's words and still re-reads the status", async () => {
    const { store, seam, requests } = await harness({ [STATUS_PATH]: json(200, INSTALLED) })

    const result = await seam.reconcile()

    expect(requests[0]).toBe("POST api/github-app/reconcile")
    /* The unrouted 404 fallback names the status; the status re-read still lands. */
    expect(textOf(result)).toBe("The reconcile failed (404)")
    expect(store.collections.githubAppStatuses.get("will/smithers")?.installed).toBe(true)
    expect(payloadOf(store)?.error).toBe("The reconcile failed (404)")
  })

  test("reconcile answers the re-read status when the route exists", async () => {
    const { store, seam } = await harness({
      "POST api/github-app/reconcile": json(200, { reconciled: 1 }),
      [STATUS_PATH]: json(200, INSTALLED)
    })

    const result = await seam.reconcile()

    expect(textOf(result)).toBe("Reconciled — the GitHub card for will/smithers re-read the App status.")
    expect(payloadOf(store)?.phase).toBe("connected")
    expect(store.collections.githubAppStatuses.get("will/smithers")?.installationId).toBe(5511)
  })

  test("mirrorSync renders the card with the run the wire names", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/mirror-sync": json(202, { run_id: 88 })
    })

    const result = await seam.mirrorSync()

    expect(textOf(result)).toBe("Mirror sync started for will/smithers — the card tracks it.")
    const payload = mirrorPayloadOf(store)
    expect(payload?.subject).toBe("GitHub → will/smithers mirror")
    expect(payload?.trigger).toBe("sync started · run 88")
    expect(payload?.runState).toBeNull()
    expect(payload?.opsNote).toBe(NO_MIRROR_OPS_NOTE)
  })

  test("mirrorSync with no route renders the verbatim 404 on the card", async () => {
    const { store, seam } = await harness({})

    const result = await seam.mirrorSync()

    expect(textOf(result)).toBe("The mirror sync failed (404)")
    expect(mirrorPayloadOf(store)?.error).toBe("The mirror sync failed (404)")
  })

  test("mirrorSync on a structured 429 carries the rate-limit facts", async () => {
    const { store, seam } = await harness({
      "POST api/repos/will/smithers/mirror-sync": json(429, {
        code: "github_rate_limited",
        message: "GitHub rate limit exhausted",
        limit: 5000,
        remaining: 0,
        reset_at: "2026-09-02T13:00:00Z"
      })
    })

    const result = await seam.mirrorSync()

    expect(textOf(result)).toBe("GitHub rate limit exhausted")
    expect(mirrorPayloadOf(store)?.rateLimit).toEqual({ limit: 5000, remaining: 0, resetAt: "2026-09-02T13:00:00Z" })
  })
})
