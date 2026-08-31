import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AppBootstrap } from "smithers-shared/AppBootstrap"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import type { AppController as AppControllerType } from "./AppController"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"

/*
 * The composer's layout (will's brief, 2026-08-30): a header row above the box
 * holds the repository selector and where the repository lives (a local path,
 * or owner/repo on GitHub); inside the box the `+` (add files, a connector, a
 * flow, an agent) and the surface pill sit bottom-left. Every affordance is a
 * registered flow; every menu's open state is the session's.
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

const nativeRepositories: NativeRepositories = {
  available: true,
  pickLocalRepository: async () => ({ status: "cancelled" })
}

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

const text = (node: Element | null): string => (node?.textContent ?? "").replace(/\s+/g, " ").trim()

interface View {
  readonly host: HTMLElement
  readonly act: (change: () => void) => Promise<void>
}

const mount = (controller: AppControllerType): View => {
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
  const act = async (change: () => void): Promise<void> => {
    flushSync(change)
    await settled()
    flushSync(() => {})
  }
  return { host, act }
}

const persisted = async (store: AppStore, transition: Parameters<AppStore["dispatch"]>[0]): Promise<void> => {
  await store.dispatch(transition).isPersisted.promise
}

const byTestId = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-testid="${id}"]`)

const localController = async (harnesses: ReadonlyArray<unknown> = []) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, nativeRepositories, silentAgent, {
    bootstrap: localBootstrap,
    ...backend({
      "/api/harnesses": json(200, { harnesses }),
      "/api/repos": json(200, { repos: [] })
    })
  })
  await controller.loadHarnesses()
  await settled()
  return { store, controller }
}

describe("the composer header: the repository selector and where it lives", () => {
  test("no repository: the selector says Select a repo, no origin chip, and the chrome has no duplicate", async () => {
    const { controller } = await localController()
    const view = mount(controller)

    const trigger = byTestId(view.host, "composer-repo-trigger")
    expect(text(trigger)).toBe("Select a repo")
    expect(trigger?.dataset.connected).toBe("false")
    expect(trigger?.dataset.flow).toBe("connect")
    expect(byTestId(view.host, "repo-chip")).toBeNull()
    // The header holds the selector; the chrome bar no longer repeats it.
    expect(byTestId(view.host, "composer-header")?.contains(trigger)).toBe(true)
    expect(view.host.querySelector(".chrome-bar .repo-chip")).toBeNull()
    // The sidebar's Repos section offers the same one step when nothing is pinned, and nothing else binds repo.open there.
    const sidebarOpens = [...view.host.querySelectorAll(".chrome-bar [data-flow=\"repo.open\"]")]
    expect(sidebarOpens.map((el) => el.getAttribute("data-testid"))).toEqual(["repo-empty"])

    // Its menu offers the IDE's open-folder, through the registered flow.
    await view.act(() => trigger?.click())
    expect(controller.store.session().connectMenuOpen).toBe(true)
    const open = byTestId(view.host, "chrome-open-repo")
    expect(text(open)).toBe("Open local repository…")
    expect(open?.dataset.flow).toBe("repo.open")
    expect(controller.commands.find("repo.open")).toBeDefined()
  })

  test("a local repository: the selector names it and the origin chip shows the local path and branch", async () => {
    const { store, controller } = await localController()
    const view = mount(controller)

    await view.act(() => {
      void persisted(store, {
        type: "repos.loaded",
        actor: "system",
        repos: [{
          id: "smithers",
          path: "/Users/williamcory/smithers",
          name: "smithersai/smithers",
          git: { branch: "v1/rc0-migration", remote: "git@github.com:smithersai/smithers.git" },
          warnings: [],
          smithers: {
            detected: false,
            workspaceFile: null,
            declarationFiles: [],
            reason: "no WORKSPACE.ts",
            workspaces: []
          }
        }]
      })
    })
    await view.act(() => {})

    const selector = text(byTestId(view.host, "composer-repo-trigger"))
    expect(selector).toBe("smithersai/smithers")
    expect(byTestId(view.host, "composer-repo-trigger")?.dataset.connected).toBe("true")
    const chip = byTestId(view.host, "repo-chip")
    expect(chip?.dataset.origin).toBe("local")
    expect(chip?.title).toBe("/Users/williamcory/smithers")
    expect(text(chip?.querySelector(".composer-origin-name") ?? null)).toBe("~/smithers")
    expect(text(chip?.querySelector(".composer-origin-branch") ?? null)).toBe("· v1/rc0-migration")
    expect(text(chip)).toBe("~/smithers · v1/rc0-migration")
    expect(text(chip)).not.toContain("smithersai/smithers")
    expect(`${selector} ${text(chip)}`.match(/smithersai\/smithers/g)).toHaveLength(1)
  })

  test("a watched GitHub repository: the origin chip does not repeat the selector's owner/repo", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      ...backend({
        "/api/auth/session": json(200, { login: "will", allowlisted: true, admin: false }),
        "/api/identity/watched": json(200, { selected: ["smithersai/smithers"], selectedAt: "2026-08-30", via: "command" }),
        "/api/identity/repos": json(200, { candidates: [], cached: false })
      })
    })
    await controller.loadSession()
    await settled()
    const view = mount(controller)
    await view.act(() => {})

    expect(text(byTestId(view.host, "composer-repo-trigger"))).toBe("smithersai/smithers")
    expect(byTestId(view.host, "repo-chip")).toBeNull()
  })
})

describe("the composer's + menu and surface pill", () => {
  test("+ opens a store-owned menu: Add files first, then a connector and an agent; the pill names the surface", async () => {
    const { store, controller } = await localController([{
      id: "claude",
      displayName: "Claude Code",
      binary: "/usr/local/bin/claude",
      version: "2.0.0",
      status: "signed-in",
      account: { email: "will@example.com" },
      launch: { argv: ["claude"] }
    }])
    const view = mount(controller)

    const add = byTestId(view.host, "composer-add")
    expect(add?.dataset.flow).toBe("composer.add")
    expect(controller.commands.find("composer.add")).toBeDefined()
    // Bottom-left: the + and the pill share the actions row, pill after +.
    const actions = view.host.querySelector(".composer-actions")
    expect(actions?.children[0]?.classList.contains("composer-add")).toBe(true)
    expect(actions?.children[1]?.classList.contains("composer-surfaces")).toBe(true)
    expect(text(byTestId(view.host, "composer-surface-trigger"))).toBe("Chat")

    expect(store.session().addMenuOpen).toBe(false)
    await view.act(() => add?.click())
    expect(store.session().addMenuOpen).toBe(true)
    const items = [...view.host.querySelectorAll<HTMLElement>("[data-testid=\"composer-add-menu\"] [role=\"menuitem\"]")]
    expect(items.map((item) => text(item))).toEqual([
      "Add files…",
      "New connector…",
      // The named roles (AgentRoles.ts): only the orchestrator's harness is installed in this fixture.
      "Orchestrator · Fable 5will@example.com",
      "Explainer · Kimi K3opencode-kimi is not installed",
      "Implementation · GPT-5.6 Solcodex is not installed",
      "Trivial implementation · GPT-5.6 Lunacodex is not installed",
      "UI · Kimi K3opencode-kimi is not installed",
      "Fast UI · Cerebras gpt-oss-120bopencode-cerebras is not installed",
      "New agent…Claude Code"
    ])
    // The orchestrator's harness is installed, so its role row is enabled; the explainer's is not.
    expect(items[2]?.hasAttribute("disabled")).toBe(false)
    expect(items[3]?.hasAttribute("disabled")).toBe(true)
    expect(items[8]?.hasAttribute("disabled")).toBe(false)
    expect(items.map((item) => item.dataset.flow)).toEqual([
      "files.add",
      "connector.add",
      ...Array<string>(6).fill("agent.role"),
      "tab.harness"
    ])
    // No jjhub on the local host: no flow.create, so no "New flow…" is offered.
    expect(controller.commands.find("flow.create")).toBeUndefined()

    // Add files… is honest about the host: no attach seam, one Smithers message, menu closed.
    await view.act(() => items[0]?.click())
    expect(store.session().addMenuOpen).toBe(false)
    await view.act(() => {})
    const messages = [...store.collections.messages.values()].map((message) => message.text)
    expect(messages.some((message) => message.startsWith("Attachments aren't available on this host yet"))).toBe(true)
  })

  test("Escape and an outside press close the + menu through the store", async () => {
    const { store, controller } = await localController()
    const view = mount(controller)

    await view.act(() => byTestId(view.host, "composer-add")?.click())
    expect(store.session().addMenuOpen).toBe(true)
    await view.act(() => {
      byTestId(view.host, "composer-add-menu")?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      )
    })
    expect(store.session().addMenuOpen).toBe(false)

    await view.act(() => byTestId(view.host, "composer-add")?.click())
    expect(store.session().addMenuOpen).toBe(true)
    await view.act(() => {
      view.host.querySelector(".smithers-transcript")?.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    })
    expect(store.session().addMenuOpen).toBe(false)
  })

  test("the surface pill lists Chat, Connect and World, and reads the pane it opened", async () => {
    const { store, controller } = await localController()
    const view = mount(controller)

    await view.act(() => byTestId(view.host, "composer-surface-trigger")?.click())
    const items = [...view.host.querySelectorAll<HTMLElement>(".composer-surfaces [role=\"menuitem\"]")]
    expect(items.map((item) => item.dataset.flow)).toEqual(["chat", "connect", "world"])
    await view.act(() => items[2]?.click())
    expect(store.session().surface).toBe("world")
    expect(text(byTestId(view.host, "composer-surface-trigger"))).toBe("World")
  })
})
