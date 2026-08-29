import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "./App"
import { ControllerTestProvider } from "./ControllerContext"
import type { NativeAgent, NativeRepositories } from "./native/NativeBridge"
import { createAppController } from "./state/AppController"
import type { AppController as AppControllerType } from "./state/AppController"
import { createAppStore } from "./state/AppStore"

/*
 * The connect surface's roving arrows move between the rows' ACTIONS — the
 * buttons. A status Badge ("Connected ✓ as …") sits in the same action slot
 * carrying data-row-action, but it is not a control: the roving set used to
 * include it, so ArrowDown called focus() on a non-focusable element and the
 * keyboard ring stranded on a row that does nothing when activated (§21.2).
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

const silentAgent: NativeAgent = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

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

describe("the connect surface's roving arrows skip non-interactive status rows", () => {
  test("signed in, ArrowDown lands on the Import button, never on the Connected badge", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "codeplanesmithers",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      fetchImpl: async () => new Response("{}", { headers: { "content-type": "application/json" } })
    })
    const host = mount(controller)
    flushSync(() => controller.showConnectors())

    const list = host.querySelector<HTMLElement>(".connect-store-list")
    expect(list).not.toBeNull()
    // The GitHub row's action slot is a status Badge — present, and not a button.
    const badge = list?.querySelector("[data-row-action]:not(button)")
    expect(badge).not.toBeNull()
    const importButton = list?.querySelector<HTMLButtonElement>("button[data-row-action][data-flow=\"repos.import\"]")
    expect(importButton).not.toBeNull()

    flushSync(() => {
      list?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    })
    expect(document.activeElement).toBe(importButton ?? null)

    // The ring wraps over the buttons only; the badge never takes focus.
    flushSync(() => {
      list?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    })
    expect(document.activeElement).toBe(importButton ?? null)
    expect(document.activeElement).not.toBe(badge ?? null)
  })
})
