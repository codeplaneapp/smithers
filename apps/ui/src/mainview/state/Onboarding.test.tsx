import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AppBootstrap } from "smithers-shared/AppBootstrap"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { initMessage, repoStep, repoSuggestion } from "../Onboarding"
import { createAppController } from "./AppController"
import type { AppController as AppControllerType } from "./AppController"
import { createAppStore } from "./AppStore"

/*
 * Onboarding — the opening entry of a fresh session.
 *
 * The FIRST message says "Smithers initialized successfully" and reads back
 * what the host registered (bootstrap, capabilities, flows, harnesses,
 * repositories). Its one next step is "Select a repo": locally the native
 * folder picker (`repo.open`, the IDE's open-folder), on Cloud the GitHub
 * chooser (`repos.watch`). The pill under the composer names the same step.
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

const mount = (controller: AppControllerType): HTMLElement => {
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
  return host
}

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const silentAgent: NativeAgent = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const nativeRepositories = (picks: Array<string>): NativeRepositories => ({
  available: true,
  pickLocalRepository: async (access) => {
    picks.push(access)
    return { status: "cancelled" }
  }
})

const localBootstrap: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "1.0.0",
  buildSha: "abcdef1234567890",
  capabilities: ["local.repositories", "local.targets", "local.terminal", "local.harnesses"],
  authFlow: "none",
  sandbox: { platform: "darwin", mode: "enforced" }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const backend = (routes: Record<string, Response>) => ({
  fetchImpl: async (input: unknown) => {
    const path = new URL(String(input), "https://app.test").pathname
    return (routes[path] ?? json(404, { status: "error" })).clone()
  }
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const SMITHERS_MESSAGES = "[data-slot=\"chat-message\"][data-role=\"assistant\"]"

const text = (node: Element | null): string => (node?.textContent ?? "").replace(/\s+/g, " ").trim()

describe("onboarding — the opening entry", () => {
  test("local host, fresh session: init read first, then Select a repo through the native picker", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const picks: Array<string> = []
    const controller = createAppController(store, nativeRepositories(picks), silentAgent, {
      bootstrap: localBootstrap,
      features: { suggestionPills: true },
      ...backend({
        "/api/harnesses": json(200, {
          harnesses: [{
            id: "claude",
            displayName: "Claude Code",
            binary: "/usr/local/bin/claude",
            version: "2.0.0",
            status: "signed-in",
            account: { email: "will@example.com" },
            launch: { argv: ["claude"] }
          }]
        }),
        "/api/repos": json(200, { repos: [] })
      })
    })
    await controller.loadHarnesses()
    await settled()

    const host = mount(controller)
    const messages = [...host.querySelectorAll(SMITHERS_MESSAGES)].map(text)
    expect(messages).toHaveLength(1)
    const opening = messages[0] ?? ""
    expect(opening.startsWith("Smithers initialized successfully")).toBe(true)
    const init = host.querySelector<HTMLElement>("[data-testid=\"init-message\"]")
    expect(init?.querySelector(".message-init-check")).not.toBeNull()
    const title = init?.querySelector(".message-init-title") ?? null
    const prompt = init?.querySelector(".message-init-prompt") ?? null
    const details = init?.querySelector<HTMLDetailsElement>("details.message-init-details") ?? null
    const summary = details?.querySelector("summary") ?? null
    const detailContent = details?.querySelector(".message-init-details-content") ?? null

    // Native details owns disclosure state: closed by default, with the title and prompt outside it.
    expect(details?.open).toBe(false)
    expect(details?.hasAttribute("open")).toBe(false)
    expect(text(summary)).toBe("Details")
    expect(text(title)).toBe("Smithers initialized successfully")
    expect(text(prompt)).toBe("Select a repo to get started.")
    expect(details?.contains(title)).toBe(false)
    expect(details?.contains(prompt)).toBe(false)
    const cta = host.querySelector<HTMLElement>(".message-cta")
    expect(text(cta)).toBe("Select a repo")
    expect(cta?.dataset.flow).toBe("repo.open")
    expect(details?.contains(cta)).toBe(false)

    summary?.click()
    expect(details?.open).toBe(true)
    expect(details?.hasAttribute("open")).toBe(true)
    expect(text(detailContent)).toContain("Host: local (1.0.0 abcdef1), sandbox enforced on darwin")
    expect(text(detailContent)).toContain(
      "Capabilities: local.repositories, local.targets, local.terminal, local.harnesses"
    )
    expect(text(detailContent)).toContain(`Flows registered: ${controller.commands.all().length}`)
    expect(text(detailContent)).toContain("Harnesses: Claude Code (signed-in, will@example.com)")
    expect(text(detailContent)).toContain("Repositories: none open")
    expect(text(title)).toBe("Smithers initialized successfully")
    expect(text(prompt)).toBe("Select a repo to get started.")

    // The one next step rides the message AND the pill, both bound to repo.open.
    const pills = [...host.querySelectorAll<HTMLElement>(".smithers-suggestion")]
    expect(pills.map((pill) => text(pill))).toEqual(["Select a repo"])
    expect(pills[0]?.dataset.flow).toBe("repo.open")
    expect(pills[0]?.dataset.gold).toBe("true")
    expect(host.innerHTML).not.toContain("Choose repos to watch")

    // Clicking it is the IDE's open-folder: the native picker, read-write.
    pills[0]?.click()
    await settled()
    expect(picks).toEqual(["read-write"])
  })

  test("once a repository is open, Select a repo leaves the message and the pills", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, nativeRepositories([]), silentAgent, {
      bootstrap: localBootstrap,
      features: { suggestionPills: true },
      recommender: { debounceMs: 0 },
      ...backend({ "/api/harnesses": json(200, { harnesses: [] }), "/api/repos": json(200, { repos: [] }) })
    })
    const host = mount(controller)
    expect([...host.querySelectorAll<HTMLElement>(".smithers-suggestion")].map(text)).toEqual(["Select a repo"])

    store.dispatch({
      type: "repos.loaded",
      actor: "system",
      repos: [{
        id: "repo-1",
        name: "smithers",
        path: "/Users/will/smithers",
        git: { branch: "main", remote: null },
        warnings: [],
        smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "none", workspaces: [] }
      }]
    })
    await settled()
    await settled()
    flushSync(() => {})

    const pills = [...host.querySelectorAll<HTMLElement>(".smithers-suggestion")].map(text)
    expect(pills).not.toContain("Select a repo")
    expect(pills.length).toBeGreaterThan(0)
    const opening = [...host.querySelectorAll(SMITHERS_MESSAGES)].map(text)[0] ?? ""
    expect(opening).toContain("Repositories: smithers")
    expect(opening).not.toContain("Select a repo")
    expect(host.querySelector(".message-cta")).toBeNull()
  })

  test("cloud host, signed in and never-chosen: the pill says Select a repo and opens the GitHub chooser", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      features: { suggestionPills: true },
      ...backend({
        "/api/auth/session": json(200, { login: "will", allowlisted: true, admin: false }),
        "/api/identity/watched": json(200, { selected: null, selectedAt: null, via: null }),
        "/api/identity/repos": json(200, { candidates: [], cached: false })
      })
    })
    await controller.loadSession()
    await settled()

    const host = mount(controller)
    expect(text(host.querySelector(SMITHERS_MESSAGES))).toContain("Smithers initialized successfully")
    const pills = [...host.querySelectorAll<HTMLElement>(".smithers-suggestion")]
    expect(pills.map((pill) => text(pill))).toEqual(["Select a repo"])
    expect(pills[0]?.dataset.flow).toBe("repos.watch")
    expect(host.querySelector<HTMLElement>(".message-cta")?.dataset.flow).toBe("repos.watch")
  })

  test("local host, signed out: sign-in is an option, so the init read still opens the session", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, nativeRepositories([]), silentAgent, {
      bootstrap: { ...localBootstrap, capabilities: [...localBootstrap.capabilities, "identity"], authFlow: "both" },
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] }),
        "/api/repos": json(200, { repos: [] })
      })
    })
    await controller.loadSession()
    await settled()

    const host = mount(controller)
    const messages = [...host.querySelectorAll(SMITHERS_MESSAGES)].map(text)
    expect(messages).toHaveLength(1)
    expect((messages[0] ?? "").startsWith("Smithers initialized successfully")).toBe(true)
    expect(host.querySelector("[data-flow=\"repo.open\"]")).not.toBeNull()
  })

  test("cloud: signed out, the auth state still shows only itself — no init read, no pill", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    await controller.loadSession()
    await settled()

    const host = mount(controller)
    expect(host.querySelectorAll(SMITHERS_MESSAGES)).toHaveLength(0)
    expect(host.querySelectorAll(".smithers-suggestion")).toHaveLength(0)
  })
})

describe("onboarding — the pill feature flag", () => {
  test("off by default: no pill row in the DOM, the message action still names the repo step", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, nativeRepositories([]), silentAgent, {
      bootstrap: localBootstrap,
      ...backend({ "/api/repos": json(200, { repos: [] }) })
    })
    expect(controller.features.suggestionPills).toBe(false)
    const host = mount(controller)
    expect(host.querySelector(".smithers-suggestions")).toBeNull()
    expect(host.querySelectorAll(".smithers-suggestion")).toHaveLength(0)
    expect(host.querySelector("[data-flow=\"repo.open\"]")).not.toBeNull()
  })
})

describe("onboarding — the pure rules", () => {
  test("a connected repository ends the local step; the cloud step follows needsSelection", () => {
    expect(repoStep({ localPickerAvailable: true, connectors: [], repos: [], needsSelection: false })).toBe("local")
    expect(repoStep({ localPickerAvailable: true, connectors: [{}], repos: [], needsSelection: false })).toBe("none")
    /*
     * The defect: a signed-in session with an unmade GitHub watch list fell
     * through to "cloud" after a LOCAL repo opened, so "Select a repo" stayed
     * on screen right after the user selected one. An open repository or a
     * connector answers the step whatever the watch list says.
     */
    expect(repoStep({ localPickerAvailable: true, connectors: [], repos: [{}], needsSelection: true })).toBe("none")
    expect(repoStep({ localPickerAvailable: false, connectors: [{}], repos: [], needsSelection: true })).toBe("none")
    expect(repoStep({ localPickerAvailable: false, connectors: [], repos: [], needsSelection: true })).toBe("cloud")
    expect(repoStep({ localPickerAvailable: false, connectors: [], repos: [], needsSelection: false })).toBe("none")
  })

  test("the pill and the message action name the same flow for the step", () => {
    expect(repoSuggestion("none")).toEqual([])
    expect(repoSuggestion("local")[0]?.flow).toBe("repo.open")
    expect(repoSuggestion("cloud")[0]?.flow).toBe("repos.watch")
    const facts = { bootstrap: undefined, flowCount: 3, harnesses: [], connectors: [], repos: [] }
    expect(initMessage({ ...facts, repoStep: "none" }).action).toBeUndefined()
    expect(initMessage({ ...facts, repoStep: "none" }).text).not.toContain("Select a repo")
    expect(initMessage({ ...facts, repoStep: "local" }).action).toEqual({ flow: "repo.open", label: "Select a repo" })
    expect(initMessage({ ...facts, repoStep: "cloud" }).action).toEqual({ flow: "repos.watch", label: "Select a repo" })
  })

  test("an open repository and a connector both read back by name", () => {
    const message = initMessage({
      bootstrap: undefined,
      flowCount: 0,
      harnesses: [],
      connectors: [{ name: "flows", branch: "main" }],
      repos: [{ name: "smithers" }],
      repoStep: "none"
    })
    expect(message.text).toContain("Host: unknown")
    expect(message.text).toContain("Harnesses: none detected")
    expect(message.text).toContain("Repositories: smithers, flows @ main")
  })
})
