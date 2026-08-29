import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import type { AppController as AppControllerType } from "./AppController"
import { createAppStore } from "./AppStore"

/*
 * The composer hot path.
 *
 * The draft changes on every keystroke. It used to be read by the shell, so
 * one character re-rendered App — and App renders the whole transcript, every
 * message, every card. The shell now projects the session WITHOUT the draft
 * and the composer subscribes to the draft itself, so typing re-renders the
 * composer subtree and nothing above it.
 *
 * These tests pin that as a render COUNT, not a description: `data-flows` is
 * built from `controller.commands.all()` during App's render, so counting that
 * call counts App renders. Putting `draft` back into the shell's projection
 * fails here immediately.
 */

GlobalRegistrator.register()

/*
 * bun test shares one process across files, so the DOM globals registered
 * above would leak into every file that runs after this one. Registration is
 * confined to this file's run, exactly as ChatShell.test.tsx does it.
 */
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

interface Counted {
  readonly controller: AppControllerType
  /** How many times App has rendered since mount. */
  readonly renders: () => number
  readonly host: HTMLElement
  readonly act: (change: () => void) => Promise<void>
}

/** Mount App behind a controller whose registry read counts the shell's renders. */
const mountCounted = async (): Promise<Counted> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const real = createAppController(store, unavailableRepositories, unavailableAgent)
  let count = 0
  const controller: AppControllerType = {
    ...real,
    commands: {
      ...real.commands,
      all: () => {
        count += 1
        return real.commands.all()
      }
    }
  }
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
    // Collection subscriptions land on a microtask; flush what they queued.
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushSync(() => {})
  }
  await act(() => {})
  return { controller, renders: () => count, host, act }
}

const textarea = (host: HTMLElement): HTMLTextAreaElement | null => host.querySelector<HTMLTextAreaElement>("textarea")

describe("the composer hot path: typing never re-renders the transcript", () => {
  test("a run of keystrokes re-renders the shell zero times", async () => {
    const view = await mountCounted()
    const before = view.renders()

    for (const draft of ["w", "wr", "wri", "writ", "write"]) {
      await view.act(() => view.controller.changeDraft(draft))
    }

    // The composer took every character...
    expect(textarea(view.host)?.value).toBe("write")
    expect(view.controller.store.session().draft).toBe("write")
    // ...and the shell above it never rendered again.
    expect(view.renders()).toBe(before)
  })

  test("the shell still re-renders for the session state it does read", async () => {
    const view = await mountCounted()
    const before = view.renders()

    // A surface change is not the hot path: the shell reads `surface`, so it
    // must still project it. This is the other half of the projection —
    // dropping a field the shell needs has to fail as loudly as keeping the
    // draft it does not.
    await view.act(() => void view.controller.runCommand("world"))

    expect(view.renders()).toBeGreaterThan(before)
    expect(view.host.querySelector(".world-surface")).not.toBeNull()
  })

  test("typing leaves the transcript's rendered messages untouched", async () => {
    const view = await mountCounted()
    await view.act(() => view.controller.runCommandArgs("send", "a message worth keeping"))
    const before = view.host.querySelector(".smithers-transcript")?.innerHTML
    const renders = view.renders()

    await view.act(() => view.controller.changeDraft("/"))
    await view.act(() => view.controller.changeDraft(""))

    expect(view.host.querySelector(".smithers-transcript")?.innerHTML).toBe(before)
    expect(view.renders()).toBe(renders)
  })

  test("Escape outside the connect menu closes its session state", async () => {
    const view = await mountCounted()
    const shell = view.host.querySelector<HTMLElement>(".app-shell")
    expect(shell).not.toBeNull()

    await view.act(() => view.controller.toggleConnectMenu())
    expect(view.controller.store.session().connectMenuOpen).toBe(true)

    document.body.focus()
    flushSync(() => {
      shell?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    })
    await view.act(() => {})

    expect(view.controller.store.session().connectMenuOpen).toBe(false)
  })
})

/*
 * The connect menu's open state belongs to the store.
 *
 * It used to be a `useState` inside ComposerConnect, which made the component
 * the authority on whether it was open — nothing else could open it, close it,
 * or read it, and no journal entry recorded that it had happened. It is a
 * session field now, written only through the `connect-menu.toggled`
 * transition. These tests pin all three halves of that: the store round-trip
 * the projection follows, and the two dismissals (an outside press, Escape)
 * that have to reach the store rather than a local setter.
 */

/** Let a `requestAnimationFrame`-deferred focus call land before asserting. */
const frame = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })

const connectTrigger = (host: HTMLElement): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>(".composer-connect-trigger")

const connectList = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>(".composer-connect-list")

describe("the connect menu's open state lives in the store", () => {
  test("the open state round-trips through the connect-menu.toggled transition", async () => {
    const view = await mountCounted()
    const { store } = view.controller
    expect(store.session().connectMenuOpen).toBe(false)
    expect(connectList(view.host)).toBeNull()

    // Dispatched at the store, with no component involved at all: the menu
    // is a projection of the session, so this alone has to open it.
    await view.act(() => store.dispatch({ type: "connect-menu.toggled", actor: "user", open: true }))

    expect(store.session().connectMenuOpen).toBe(true)
    expect(connectList(view.host)).not.toBeNull()
    expect(connectTrigger(view.host)?.getAttribute("aria-expanded")).toBe("true")

    await view.act(() => store.dispatch({ type: "connect-menu.toggled", actor: "user", open: false }))

    expect(store.session().connectMenuOpen).toBe(false)
    expect(connectList(view.host)).toBeNull()
    expect(connectTrigger(view.host)?.getAttribute("aria-expanded")).toBe("false")

    // Both ends were recorded — the journal is what a store-owned menu buys.
    const toggles = [...store.collections.transitions.values()].filter(
      (record) => record.type === "connect-menu.toggled"
    )
    expect(toggles.map((record) => JSON.parse(record.payload).open)).toEqual([true, false])
  })

  test("opening from the trigger, then a pointer press outside, closes it", async () => {
    const view = await mountCounted()
    const { store } = view.controller

    await view.act(() => connectTrigger(view.host)?.click())
    expect(store.session().connectMenuOpen).toBe(true)
    expect(connectList(view.host)).not.toBeNull()

    // A press inside the menu is not a dismissal.
    await view.act(() => {
      connectList(view.host)?.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    })
    expect(store.session().connectMenuOpen).toBe(true)

    await view.act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    })

    expect(store.session().connectMenuOpen).toBe(false)
    expect(connectList(view.host)).toBeNull()
  })

  test("opening from the trigger, then Escape, closes it and returns focus", async () => {
    const view = await mountCounted()
    const { store } = view.controller

    await view.act(() => connectTrigger(view.host)?.click())
    expect(store.session().connectMenuOpen).toBe(true)
    const list = connectList(view.host)
    expect(list).not.toBeNull()

    await view.act(() => {
      list?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    })
    await frame()

    expect(store.session().connectMenuOpen).toBe(false)
    expect(connectList(view.host)).toBeNull()
    // Escape must not strand focus on a node that no longer exists.
    const trigger = connectTrigger(view.host)
    expect(trigger).not.toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
