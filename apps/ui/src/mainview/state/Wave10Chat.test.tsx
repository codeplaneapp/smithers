import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { chooserFilter, chooserKeyAction, chooserMove, freshnessLabel } from "../ChatCards"
import { ControllerTestProvider } from "../ControllerContext"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import type { AppController as AppControllerType, AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"

/*
 * Wave 10, DOM half: the derived pill row (§2a/§2f), the chooser card's
 * keyboard completeness, the admin-only reset/devtools absence, the maximize
 * transition's element identity (§2d′), and the pre-model auth gate (§2a″).
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.()
})

const mount = (controller: AppControllerType): { host: HTMLElement; markup: () => string } => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <App />
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return { host, markup: () => host.innerHTML }
}

const act = (work: () => void): void => {
  flushSync(work)
}

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const silentAgent: NativeAgent = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const backend = (
  routes: Record<string, Response | ((request: Request) => Response | Promise<Response>)>
): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const path = absolute.pathname + absolute.search
    for (const [route, answer] of Object.entries(routes)) {
      if (path === route || path.startsWith(`${route}?`)) {
        return typeof answer === "function"
          ? answer(new Request(absolute.toString(), init))
          : answer.clone()
      }
    }
    return json(404, { status: "error", message: `no stub for ${path}` })
  }
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const CANDIDATES = [
  { fullName: "will/flows", private: false, pushedAt: "2026-08-07T12:00:00.000Z", openIssues: 4 },
  { fullName: "will/smithers", private: false, pushedAt: "2026-08-06T09:00:00.000Z", openIssues: 2 }
]

const signedIn = async (store: AppStore, admin = false): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin,
    scopesPlain: null
  })
  await settled()
}

describe("wave 10 — the derived pill row (§2a/§2f)", () => {
  test("with no recommendation and no next step the pill row is EMPTY — an empty row is correct", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent)
    await signedIn(store)
    // A selection exists (zero chosen) → no needsSelection step; no reco → no gold pill.
    store.dispatch({
      type: "watched.replaced",
      actor: "system",
      selected: [],
      selectedAt: "2026-08-09T09:00:00.000Z",
      via: "onboarding"
    })
    await settled()
    const { host } = mount(controller)
    expect(host.querySelectorAll(".smithers-suggestion")).toHaveLength(0)
  })

  test("signed-out, no pill: sign-in is the chrome button, never a gate on the chat (LOCAL-APP.md)", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent)
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-out",
      login: null,
      allowlisted: false,
      admin: false,
      scopesPlain: null
    })
    await settled()
    const { host } = mount(controller)
    expect(host.querySelectorAll(".smithers-suggestion")).toHaveLength(0)
    const signIn = host.querySelector<HTMLElement>("[data-testid=\"chrome-sign-in\"]")
    expect(signIn?.dataset.flow).toBe("auth.sign-in")
  })

  test("needsSelection, the one pill opens the chooser as the gold binding", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      ...backend({
        "/api/identity/watched": json(200, { selected: null, selectedAt: null, via: null }),
        "/api/identity/repos": json(200, { candidates: CANDIDATES, cached: false })
      })
    })
    await signedIn(store)
    await controller.openFirstRunRepos()
    await settled()
    const { host } = mount(controller)
    const pills = host.querySelectorAll<HTMLElement>(".smithers-suggestion")
    expect(pills).toHaveLength(1)
    expect(pills[0]?.dataset.flow).toBe("repos.watch")
    expect(pills[0]?.dataset.gold).toBe("true")
  })
})

describe("wave 10 — the chooser card, keyboard-complete", () => {
  const chooserController = async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const puts: Array<unknown> = []
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : String(input)
        const path = new URL(url, "https://app.test").pathname
        if (path === "/api/identity/repos") {
          return json(200, { candidates: CANDIDATES, cached: false })
        }
        if (path === "/api/identity/watched" && init?.method === "PUT") {
          puts.push(typeof init.body === "string" ? JSON.parse(init.body) : undefined)
          return json(200, { selected: ["will/flows"], selectedAt: "2026-08-09T10:00:00.000Z", via: "onboarding" })
        }
        if (path === "/api/identity/watched") {
          return json(200, { selected: null, selectedAt: null, via: null })
        }
        return json(404, { status: "error", message: `no stub for ${path}` })
      }
    })
    await signedIn(store)
    await controller.openFirstRunRepos()
    return { store, controller, puts }
  }

  test("rows render with name, freshness, and issue count; the filter logic is pure and complete", async () => {
    const { controller } = await chooserController()
    const { host } = mount(controller)
    const rows = host.querySelectorAll(".repo-chooser-row")
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain("will/flows")
    expect(rows[0]?.textContent).toContain("4 open issues")

    // Typing filters (the pure mapping the input delegates to).
    expect(chooserFilter(CANDIDATES, "smithers").map((candidate) => candidate.fullName)).toEqual(["will/smithers"])
    expect(chooserFilter(CANDIDATES, "")).toHaveLength(2)
    expect(chooserFilter(CANDIDATES, "zzz")).toHaveLength(0)
  })

  test("the keyboard map: arrows move, space toggles only with an empty filter, Enter confirms", () => {
    expect(chooserKeyAction("ArrowDown", "")).toEqual({ kind: "move", delta: 1 })
    expect(chooserKeyAction("ArrowUp", "")).toEqual({ kind: "move", delta: -1 })
    expect(chooserKeyAction(" ", "")).toEqual({ kind: "toggle" })
    // Space with text in the filter is text, never a toggle.
    expect(chooserKeyAction(" ", "flo")).toEqual({ kind: "none" })
    expect(chooserKeyAction("Enter", "")).toEqual({ kind: "confirm" })
    expect(chooserKeyAction("a", "")).toEqual({ kind: "none" })
  })

  test("arrows at the window's end grow the window instead of trapping the highlight on page one", () => {
    // 205 repositories, 50 rendered: ArrowDown on row 50 must page forward —
    // the old modulo wrap stranded a keyboard-only user inside the first page.
    const atWindowEnd = chooserMove({
      delta: 1,
      highlightedIndex: 49,
      visibleCount: 50,
      visibleLimit: 50,
      totalCount: 205
    })
    expect(atWindowEnd).toEqual({ highlighted: 50, visibleLimit: 100 })
    // Within the window, movement is a plain step.
    expect(
      chooserMove({ delta: 1, highlightedIndex: 10, visibleCount: 50, visibleLimit: 50, totalCount: 205 })
    ).toEqual({ highlighted: 11, visibleLimit: 50 })
    // At the TRUE end (the whole inventory rendered), down wraps to the top.
    expect(
      chooserMove({ delta: 1, highlightedIndex: 204, visibleCount: 205, visibleLimit: 205, totalCount: 205 })
    ).toEqual({ highlighted: 0, visibleLimit: 205 })
    // Up from the top wraps to the bottom of the rendered window.
    expect(
      chooserMove({ delta: -1, highlightedIndex: 0, visibleCount: 50, visibleLimit: 50, totalCount: 205 })
    ).toEqual({ highlighted: 49, visibleLimit: 50 })
    // The last page grows only to the inventory's size.
    expect(
      chooserMove({ delta: 1, highlightedIndex: 199, visibleCount: 200, visibleLimit: 200, totalCount: 205 })
    ).toEqual({ highlighted: 200, visibleLimit: 205 })
  })

  test("freshness labels read from an injected clock, not the ambient one", () => {
    const now = Date.parse("2026-08-20T12:00:00Z")
    expect(freshnessLabel(null, now)).toBe("never pushed")
    expect(freshnessLabel("2026-08-20T09:00:00Z", now)).toBe("today")
    expect(freshnessLabel("2026-08-19T09:00:00Z", now)).toBe("yesterday")
    expect(freshnessLabel("2026-08-10T09:00:00Z", now)).toBe("10d ago")
    expect(freshnessLabel("2026-06-20T09:00:00Z", now)).toBe("2mo ago")
    expect(freshnessLabel("2024-08-20T09:00:00Z", now)).toBe("2y ago")
  })

  test("row click toggles, all/none bindings fire, confirm PUTs the selection", async () => {
    const { store, controller, puts } = await chooserController()
    const { host } = mount(controller)

    const row = host.querySelector<HTMLButtonElement>(".repo-chooser-row")
    act(() => row?.click())
    await settled()
    let card = store.collections.cards.get("repo-chooser")
    expect(card?.kind === "repo-chooser" ? card.payload.selected : []).toEqual(["will/flows"])

    act(() => host.querySelector<HTMLButtonElement>("[data-flow=\"repos.watch.confirm\"]")?.click())
    await settled()
    await settled()
    expect(puts).toHaveLength(1)
    expect(puts[0]).toEqual({ selected: ["will/flows"], via: "onboarding" })
    expect(store.collections.cards.get("repo-chooser")).toBeUndefined()
    expect(
      [...store.collections.messages.values()].some((message) =>
        message.text.includes("change this anytime — just ask")
      )
    ).toBe(true)
  })
})

describe("wave 10 — admin-only affordances are absent, not hidden (§2/§2b)", () => {
  test("non-admin: no reset button, no devtools panel, no trace in the DOM", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent)
    await signedIn(store, false)
    const { host } = mount(controller)
    expect(host.querySelector(".corner-reset-btn")).toBeNull()
    expect(host.querySelector(".devtools-panel")).toBeNull()
    // The registry manifest in the DOM carries no admin or reset names.
    const manifest = host.querySelector(".app-shell")?.getAttribute("data-flows") ?? ""
    expect(manifest).not.toContain("admin.")
    expect(manifest).not.toContain("reset")
    expect(manifest).not.toContain("debug.")
  })

  test("admin: the reset button renders and admin.devtools toggles the panel", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent)
    await signedIn(store, true)
    const { host } = mount(controller)
    expect(host.querySelector(".corner-reset-btn")).not.toBeNull()
    expect(host.querySelector(".devtools-panel")).toBeNull()
    act(() => void controller.runCommand("admin.devtools"))
    expect(host.querySelector(".devtools-panel")).not.toBeNull()
    expect(host.querySelector(".devtools-registry")?.textContent).toContain("repos.watch")
    act(() => void controller.runCommand("admin.devtools"))
    expect(host.querySelector(".devtools-panel")).toBeNull()
  })
})

describe("wave 10 — the maximize transition (§2d′)", () => {
  test("maximizing keeps the SAME element (no re-mount); Escape minimizes", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent)
    await signedIn(store)
    store.dispatch({
      type: "card.upsert",
      actor: "smithers",
      card: {
        id: "status-one",
        kind: "status",
        title: "A status",
        status: "active",
        createdAt: Date.now(),
        ordinal: 10,
        payload: { note: "halfway" }
      }
    })
    await settled()
    const { host } = mount(controller)
    const card = host.querySelector<HTMLElement>(".smithers-card[data-kind=\"status\"]")
    expect(card).not.toBeNull()
    expect(card?.dataset.maximized).toBe("false")

    const button = host.querySelector<HTMLButtonElement>("[data-flow=\"card.maximize\"]")
    expect(button).not.toBeNull()
    act(() => button?.click())
    const maximizedCard = host.querySelector<HTMLElement>(".smithers-card[data-kind=\"status\"]")
    // Element identity persists across the transition — the same node morphed.
    expect(maximizedCard).toBe(card)
    expect(maximizedCard?.dataset.maximized).toBe("true")
    expect(host.querySelector(".card-maximize-backdrop")).not.toBeNull()

    act(() => void controller.runCommand("card.minimize"))
    expect(host.querySelector<HTMLElement>(".smithers-card[data-kind=\"status\"]")?.dataset.maximized).toBe("false")
    expect(host.querySelector<HTMLElement>(".smithers-card[data-kind=\"status\"]")).toBe(card)
  })
})

describe("local app: identity is not a gate on the chat (LOCAL-APP.md)", () => {
  test("a signed-out send reaches the turn seam: one startTurn call, no sign-in reply", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let turns = 0
    const countingAgent: NativeAgent = {
      available: true,
      startTurn: async () => {
        turns += 1
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: () => () => {}
    }
    const controller = createAppController(store, unavailableRepositories, countingAgent)
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-out",
      login: null,
      allowlisted: false,
      admin: false,
      scopesPlain: null
    })
    await settled()
    controller.send("list my issues")
    await settled()
    expect(turns).toBe(1)
    const reply = [...store.collections.messages.values()].find((message) =>
      message.text.includes("Sign in with GitHub first")
    )
    expect(reply).toBeUndefined()
  })
})
