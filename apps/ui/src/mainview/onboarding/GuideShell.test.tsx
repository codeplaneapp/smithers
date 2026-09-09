import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ControllerTestProvider } from "../ControllerContext"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { initialGuide } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { GuideShell } from "./GuideShell"

/*
 * The talk-directly lesson (step 6): the invitation copy, the numbered human
 * instructions under it (the reusable GuideSteps), and the Call Smithers
 * fallback button. Mounted against the real controller and store.
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

const silentAgent: AgentPort = {
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

const text = (node: Element | null): string => (node?.textContent ?? "").replace(/\s+/g, " ").trim()

const mountGuide = async (step: number): Promise<HTMLElement> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, silentAgent)
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step } }).isPersisted.promise
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <GuideShell>
          <div />
        </GuideShell>
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return host
}

describe("the talk-directly lesson", () => {
  test("invites the user to talk, then shows the gesture as numbered steps", async () => {
    const host = await mountGuide(6)
    const lesson = host.querySelector('[data-message-step="6"]')
    expect(text(lesson)).toContain("You can talk directly to me. Try it now.")
    expect(text(lesson)).not.toContain("stay out of the way")

    const steps = host.querySelector(".guide-steps")
    expect(steps?.tagName).toBe("OL")
    const items = [...(steps?.querySelectorAll("li") ?? [])]
    expect(items).toHaveLength(1)
    expect(text(items[0]?.querySelector(".guide-step-number") ?? null)).toBe("1")
    expect(text(items[0]?.querySelector(".guide-step-body") ?? null)).toBe("Press ⌘ K (or Ctrl K) and type a message to me")
    expect([...(items[0]?.querySelectorAll("kbd") ?? [])].map((kbd) => text(kbd))).toEqual(["⌘ K", "Ctrl K"])

    // The touch/click fallback stays (docs/ONBOARDING.md).
    expect(text(host.querySelector('[aria-keyshortcuts="Meta+k Control+k Enter ArrowRight"]'))).toContain("Call Smithers")
  }, 20000)

  test("other lessons show no numbered steps", async () => {
    const host = await mountGuide(5)
    expect(host.querySelector(".guide-steps")).toBeNull()
  }, 20000)
})
