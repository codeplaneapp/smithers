import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "../state/AppController"
import type { AppController as AppControllerType } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"

/*
 * The `+` menu (docs/LOCAL-APP.md "Tabs").
 *
 * Regression: the menu used to render INSIDE `.tab-strip`, which scrolls
 * horizontally. An `overflow-x: auto` container computes `overflow-y: auto`
 * too and clips every absolutely-positioned descendant, so the open menu was
 * cut to the strip's 28px and painted nothing below it — the trigger read
 * aria-expanded="true" while the human saw no menu. happy-dom does no layout,
 * so the pin is structural: the menu's DOM ancestry must hold no overflow
 * container, i.e. it is not a descendant of the strip. The e2e spec pins the
 * paint with elementFromPoint.
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

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const unavailableAgent: NativeAgent = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const localHarness = async (): Promise<{ store: AppStore; controller: AppControllerType }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
    bootstrap: {
      apiVersion: 1,
      host: "local",
      version: "test",
      buildSha: "test",
      capabilities: ["local.repositories", "local.targets", "local.terminal", "local.harnesses"],
      authFlow: "none",
      sandbox: { platform: "darwin", mode: "enforced" }
    },
    // A terminal tab attaches the PTY client; nothing listens here, so no socket is opened.
    socketUrl: () => undefined
  })
  return { store, controller }
}

const mount = (controller: AppControllerType): { host: HTMLElement; act: (change: () => void) => Promise<void> } => {
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
  return {
    host,
    act: async (change) => {
      flushSync(change)
      await new Promise((resolve) => setTimeout(resolve, 0))
      flushSync(() => {})
    }
  }
}

const persisted = async (store: AppStore, transition: Parameters<AppStore["dispatch"]>[0]): Promise<void> => {
  await store.dispatch(transition).isPersisted.promise
}

describe("the + menu", () => {
  test("opens outside the scrolling list: Terminal first, then the agents", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "harnesses.loaded",
      actor: "system",
      harnesses: [
        {
          id: "claude",
          displayName: "Claude Code",
          binary: "/opt/homebrew/bin/claude",
          version: "2.1.0",
          status: "signed-in",
          account: { email: "will@codeplane.app" },
          launch: { argv: ["claude"] }
        },
        {
          id: "gemini",
          displayName: "Gemini",
          binary: null,
          version: null,
          status: "unavailable",
          account: null,
          launch: { argv: ["gemini"] }
        }
      ]
    })
    const { host, act } = mount(controller)
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=tab-add]")
    expect(trigger).not.toBeNull()
    // The trigger is a sibling of the strip, never inside it.
    expect(trigger?.closest(".tab-strip")).toBeNull()
    await act(() => trigger?.click())
    const menu = host.querySelector<HTMLElement>("[data-testid=tab-add-menu]")
    expect(menu).not.toBeNull()
    expect(menu?.closest(".tab-strip")).toBeNull()
    expect(trigger?.getAttribute("aria-expanded")).toBe("true")
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])]
    expect(items.map((item) => item.getAttribute("data-flow"))).toEqual([
      "tab.terminal",
      "tab.harness",
      "tab.harness"
    ])
    expect(items[0]?.textContent).toBe("Terminal")
    expect(host.querySelector("[data-testid=tab-add-agents]")?.textContent).toBe("Agents")
    expect(items[1]?.textContent).toContain("Claude Code")
    expect(items[2]?.disabled).toBe(true)
    // One Smithers: the menu offers no second conversation, and no tab.chat flow exists to open one.
    expect(host.querySelector("[data-testid=tab-add-chat]")).toBeNull()
    expect(controller.commands.find("tab.chat")).toBeUndefined()
  })

  test("the sidebar is vertical: Smithers first, the tabs below it, the chrome at the bottom of every tab", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t1", kind: "terminal", title: "Terminal · ~", sessionId: "t1", cwd: "~" }
    })
    const { host } = mount(controller)
    const bar = host.querySelector<HTMLElement>(".chrome-bar")
    expect(bar?.tagName).toBe("ASIDE")
    expect(host.querySelector("[data-testid=tab-strip]")?.getAttribute("aria-orientation")).toBe("vertical")
    const tabs = [...host.querySelectorAll<HTMLElement>(".tab")]
    expect(tabs.map((tab) => tab.getAttribute("data-kind"))).toEqual(["main", "terminal"])
    expect(tabs[0]?.querySelector(".tab-close")).toBeNull()
    expect(tabs[1]?.querySelector("[data-testid=tab-close-t1]")).not.toBeNull()
    // The `+` follows the list, inside the sidebar, outside the scrolling strip.
    const add = host.querySelector<HTMLElement>("[data-testid=tab-add]")
    expect(add?.closest(".chrome-bar")).toBe(bar)
    expect(add?.closest(".tab-strip")).toBeNull()
    // The theme toggle (and admin reset when present) live in the sidebar, so a terminal tab still shows them.
    const theme = host.querySelector<HTMLElement>('[data-flow="appearance.dark-mode"]')
    expect(theme?.closest(".chrome-bar")).toBe(bar)
    expect(store.session().activeTabId).toBe("t1")
    expect(host.querySelector<HTMLElement>("[data-testid=tab-body-main]")?.hidden).toBe(true)
    expect(theme?.closest("[hidden]")).toBeNull()
    // Focus order: the chrome comes after the tabs.
    const order = [...host.querySelectorAll<HTMLElement>(".chrome-bar [data-flow]")].map((el) => el.getAttribute("data-flow"))
    expect(order.indexOf("appearance.dark-mode")).toBeGreaterThan(order.indexOf("tab.menu"))
  })
  test("ArrowDown and ArrowUp walk the vertical tablist and select the tab reached", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t1", kind: "terminal", title: "Terminal · ~", sessionId: "t1", cwd: "~" }
    })
    await persisted(store, { type: "tab.selected", actor: "user", id: "main" })
    const { host, act } = mount(controller)
    const tabs = [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")]
    tabs[0]?.focus()
    const press = (key: string) =>
      act(() => {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
      })
    await press("ArrowDown")
    expect(document.activeElement).toBe(tabs[1] ?? null)
    expect(store.session().activeTabId).toBe("t1")
    await press("ArrowDown")
    expect(document.activeElement).toBe(tabs[0] ?? null)
    expect(store.session().activeTabId).toBe("main")
    await press("End")
    expect(document.activeElement).toBe(tabs[1] ?? null)
    await press("ArrowUp")
    expect(document.activeElement).toBe(tabs[0] ?? null)
    expect(store.session().activeTabId).toBe("main")
  })

  test("Escape minimizes a card maximized with the pointer: focus moves to the button that replaced the one pressed", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "card.upsert",
      actor: "system",
      card: {
        id: "status-1",
        kind: "status",
        title: "Status",
        status: "active",
        createdAt: 1,
        ordinal: 0,
        payload: { progress: 0.5 }
      }
    })
    const { host, act } = mount(controller)
    const maximize = host.querySelector<HTMLButtonElement>("[data-testid=card-maximize-status-1]")
    await act(() => maximize?.click())
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    expect(store.session().maximizedCardId).toBe("status-1")
    const minimize = host.querySelector<HTMLButtonElement>("[data-testid=card-minimize-status-1]")
    expect(document.activeElement).toBe(minimize ?? null)
    await act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    })
    expect(store.session().maximizedCardId).toBeNull()
    // The pointer path back: minimize hands focus to the maximize button that replaces it.
    await act(() => host.querySelector<HTMLButtonElement>("[data-testid=card-maximize-status-1]")?.click())
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    await act(() => host.querySelector<HTMLButtonElement>("[data-testid=card-minimize-status-1]")?.click())
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    expect(store.session().maximizedCardId).toBeNull()
    expect(document.activeElement).toBe(host.querySelector("[data-testid=card-maximize-status-1]"))
  })
})

/*
 * The Repos section (docs/LOCAL-APP.md "Tabs"): Smithers first, then every
 * pinned repository with its tabs nested under it, the active one
 * highlighted, and "No repository" for tabs opened with nothing open.
 */
describe("the sidebar's Repos section", () => {
  const repo = (id: string, name: string, path: string) => ({
    id,
    path,
    name,
    git: { branch: "main", remote: null },
    smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "no WORKSPACE.ts", workspaces: [] },
    warnings: []
  })

  test("no repository: one Select a repo row bound to repo.open, and nothing nests", async () => {
    const { controller } = await localHarness()
    const { host } = mount(controller)
    const section = host.querySelector<HTMLElement>("[data-testid=repo-section]")
    expect(section).not.toBeNull()
    expect(section?.closest(".tab-strip")).not.toBeNull()
    const empty = host.querySelector<HTMLButtonElement>("[data-testid=repo-empty]")
    expect(empty?.getAttribute("data-flow")).toBe("repo.open")
    expect(empty?.textContent).toBe("Select a repo")
    expect(host.querySelector("[data-testid=repo-none]")).toBeNull()
    // Smithers is still the first tab, above the section.
    const strip = host.querySelector<HTMLElement>("[data-testid=tab-strip]")
    expect(strip?.firstElementChild?.getAttribute("data-testid")).toBe("tab-main")
  })

  test("opening a repository pins it as the active row; tabs nest under their repository", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "repos.loaded",
      actor: "system",
      repos: [repo("r1", "smithers", "/Users/will/smithers"), repo("r2", "force", "/Users/will/force")]
    })
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t1", kind: "terminal", title: "Terminal · smithers", sessionId: "t1", cwd: "/Users/will/smithers", repoKey: "local:/Users/will/smithers" }
    })
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t2", kind: "terminal", title: "Terminal · ~", sessionId: "t2", cwd: "~" }
    })
    const { host, act } = mount(controller)
    expect(host.querySelector("[data-testid=repo-empty]")).toBeNull()
    const smithers = host.querySelector<HTMLElement>("[data-testid=repo-local\\:\\/Users\\/will\\/smithers]")
    const force = host.querySelector<HTMLElement>("[data-testid=repo-local\\:\\/Users\\/will\\/force]")
    // Both opened in one read, nothing named yet: the first by name is the active row.
    expect(force?.dataset.active).toBe("true")
    expect(smithers?.dataset.active).toBe("false")
    expect(force?.querySelector('[data-flow="repo.select"]')?.getAttribute("aria-current")).toBe("true")
    expect(smithers?.querySelector('[data-flow="repo.select"]')?.getAttribute("aria-current")).toBeNull()
    // The terminal opened in smithers nests under smithers; the one opened in ~ sits under "No repository".
    expect(smithers?.querySelector(".repo-tabs [data-testid=tab-t1]")).not.toBeNull()
    expect(force?.querySelector(".repo-tabs .tab")).toBeNull()
    expect(host.querySelector("[data-testid=repo-none] [data-testid=tab-t2]")).not.toBeNull()
    // Each repo row carries its own `+` (the same tab menu, scoped) and an unpin, both registered flows.
    expect(force?.querySelector('[data-flow="tab.menu"]')?.getAttribute("data-testid")).toBe("repo-add-local:/Users/will/force")
    expect(force?.querySelector('[data-flow="repo.unpin"]')).not.toBeNull()
    // Choosing the other row makes it the active one: the sidebar and the composer's selector agree.
    await act(() => smithers?.querySelector<HTMLButtonElement>('[data-flow="repo.select"]')?.click())
    expect(store.session().activeRepoKey).toBe("local:/Users/will/smithers")
    expect(smithers?.dataset.active).toBe("true")
    expect(force?.dataset.active).toBe("false")
    expect(host.querySelector("[data-testid=composer-repo-trigger]")?.textContent).toContain("smithers")
    // Unpinning the active row forgets it; its tab falls under "No repository" and the other row takes over.
    await act(() => smithers?.querySelector<HTMLButtonElement>('[data-flow="repo.unpin"]')?.click())
    expect(host.querySelector("[data-testid=repo-local\\:\\/Users\\/will\\/smithers]")).toBeNull()
    expect(store.collections.pinnedRepos.get("local:/Users/will/smithers")).toBeUndefined()
    expect(host.querySelector("[data-testid=repo-none] [data-testid=tab-t1]")).not.toBeNull()
    expect(host.querySelector("[data-testid=composer-repo-trigger]")?.textContent).toContain("force")
  })

  test("ArrowDown walks tabs across repo groups, selecting each one reached", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, { type: "repos.loaded", actor: "system", repos: [repo("r1", "smithers", "/Users/will/smithers")] })
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t1", kind: "terminal", title: "Terminal · smithers", sessionId: "t1", cwd: "/Users/will/smithers", repoKey: "local:/Users/will/smithers" }
    })
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t2", kind: "terminal", title: "Terminal · ~", sessionId: "t2", cwd: "~" }
    })
    await persisted(store, { type: "tab.selected", actor: "user", id: "main" })
    const { host, act } = mount(controller)
    const tabs = [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")]
    expect(tabs.map((tab) => tab.dataset.tabId)).toEqual(["main", "t1", "t2"])
    tabs[0]?.focus()
    const press = (key: string) =>
      act(() => {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
      })
    await press("ArrowDown")
    expect(store.session().activeTabId).toBe("t1")
    await press("ArrowDown")
    expect(store.session().activeTabId).toBe("t2")
    await press("ArrowDown")
    expect(store.session().activeTabId).toBe("main")
  })
})
