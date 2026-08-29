import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "../state/AppController"
import type { AppServices } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"
import { flowRequirements, unmetRequirements } from "./registry"
import type { CommandState } from "./registry"

/*
 * The requirement axis (registry.ts flowRequirements): a user-invoked flow
 * with an unmet requirement parks durably in the session row, the fulfilling
 * flow runs in its place, and the parked flow resumes when
 * the requirement's predicate flips true — one requirement at a time, against
 * live state. Agent invocations never park: they fail honestly with the
 * reason.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: NativeAgent = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
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

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** Every seam answers 404 — requirement resolution must not depend on a live backend. */
const deadBackend: AppServices = {
  fetchImpl: async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    return json(404, { status: "error", message: `no stub for ${url}` })
  }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const freshController = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    controller: createAppController(store, unavailableRepositories, unavailableAgent, deadBackend)
  }
}

const signedOut = async (store: AppStore): Promise<void> => {
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
}

const signedIn = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

const reposChosen = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "watched.replaced",
    actor: "system",
    selected: ["will/flows"],
    selectedAt: "2026-08-12T09:00:00.000Z",
    via: "command"
  })
  await settled()
}

const chatState: CommandState = {
  surface: "chat",
  typing: false,
  hasConnectors: false,
  admin: false,
  needsSelection: false,
  signedOut: false
}

describe("requirement axis — the pure model", () => {
  test("unmetRequirements answers in declaration order, only unmet, unknown ids skipped", () => {
    const meta = { summary: "", requires: ["signed-in", "repos-selected", "no-such"] }
    expect(unmetRequirements(meta, { ...chatState, signedOut: true, needsSelection: true }).map((r) => r.id)).toEqual([
      "signed-in",
      "repos-selected"
    ])
    expect(unmetRequirements(meta, { ...chatState, needsSelection: true }).map((r) => r.id)).toEqual([
      "repos-selected"
    ])
    expect(unmetRequirements(meta, chatState)).toEqual([])
    expect(unmetRequirements({ summary: "" }, { ...chatState, signedOut: true })).toEqual([])
  })

  test("every requirement's fulfill names a registered flow shape", () => {
    for (const requirement of flowRequirements) {
      expect(requirement.fulfill).toMatch(/^[a-z0-9_.-]+$/)
      expect(requirement.reason.length).toBeGreaterThan(0)
    }
  })
})

describe("requirement axis — the run path", () => {
  test("a user-invoked command with an unmet requirement parks durably and runs the fulfilling command", async () => {
    const { store, controller } = await freshController()
    await signedOut(store)
    const outcome = await controller.commands.run("repos.watch")
    // auth.sign-in ran in its place (a no-op redirect outside a browser).
    expect(outcome.status).toBe("executed")
    await settled()
    const pending = store.session().pendingCommand
    expect(pending?.name).toBe("repos.watch")
    expect(pending?.requirement).toBe("signed-in")
    expect(pending?.args).toBeNull()
  })

  test("an agent-invoked command with an unmet requirement fails honestly and parks nothing", async () => {
    const { store, controller } = await freshController()
    await signedOut(store)
    const outcome = await controller.commands.runForAgent("repos.watch")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("Sign in with GitHub first")
    const viaTool = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "repos.watch" })
    })
    expect(viaTool).toContain("failed: Sign in with GitHub first")
    await settled()
    expect(store.session().pendingCommand ?? null).toBeNull()
  })

  test("the parked command resumes once its requirement is satisfied, announced by a toast", async () => {
    const { store, controller } = await freshController()
    await signedOut(store)
    await controller.commands.run("repos.watch")
    await settled()
    await signedIn(store)
    await reposChosen(store)
    controller.resumeDeferredCommand()
    await settled()
    expect(store.session().pendingCommand ?? null).toBeNull()
    const titles = [...store.collections.toasts.values()].map((toast) => toast.title)
    expect(titles.some((title) => title.includes("Continuing /repos.watch"))).toBe(true)
  })

  test("requirements resolve one at a time: sign-in first, then the repo selection, then the command", async () => {
    const { store, controller } = await freshController()
    await signedOut(store)
    await controller.commands.run("flow.create", "nightly test triage")
    await settled()
    expect(store.session().pendingCommand?.requirement).toBe("signed-in")
    expect(store.session().pendingCommand?.args).toBe("nightly test triage")

    // Signing in satisfies the first requirement; the resume re-runs the
    // command, which now parks on the NEXT unmet requirement and opens the
    // repo chooser in its place.
    await signedIn(store)
    controller.resumeDeferredCommand()
    await settled()
    const stepped = store.session().pendingCommand
    expect(stepped?.name).toBe("flow.create")
    expect(stepped?.requirement).toBe("repos-selected")

    // The confirmed selection satisfies the second requirement; the command
    // finally executes (against the dead backend it fails honestly, but the
    // parking spot is spent either way).
    await reposChosen(store)
    controller.resumeDeferredCommand()
    await settled()
    expect(store.session().pendingCommand ?? null).toBeNull()
  })

  test("a parked command whose requirement id no longer exists clears without running", async () => {
    const { store, controller } = await freshController()
    store.dispatch({
      type: "command.deferred",
      actor: "user",
      name: "world",
      args: null,
      requirement: "retired-requirement"
    })
    await settled()
    controller.resumeDeferredCommand()
    await settled()
    expect(store.session().pendingCommand ?? null).toBeNull()
    expect(store.session().surface).toBe("chat")
  })

  test("an agent-invoked signed-in requirement renders the sign-in step itself — prose is not a button", async () => {
    const { store, controller } = await freshController()
    await signedOut(store)
    const outcome = await controller.commands.runForAgent("repos.watch")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("already rendered in the chat")
    await settled()
    const prompts = [...store.collections.messages.values()].filter(
      (message) => message.action?.flow === "auth.sign-in"
    )
    expect(prompts).toHaveLength(1)
  })

  test("the repo chooser never opens empty for a session that cannot list repositories", async () => {
    const { store, controller } = await freshController()
    // No identity dispatched at all: the seamless-dev state ("unavailable").
    const outcome = await controller.commands.run("repos.watch")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("sign-in step comes first")
    await settled()
    expect([...store.collections.cards.values()].some((card) => card.kind === "repo-chooser")).toBe(false)
    // The sign-in step rendered instead of a dead chooser (the seeded store's
    // identity is "unknown" pre-load, so the step is the button message; a
    // booted dev app has loadSession's "unavailable" answer and states the
    // missing seam instead).
    const prompts = [...store.collections.messages.values()].filter(
      (message) => message.action?.flow === "auth.sign-in"
    )
    expect(prompts).toHaveLength(1)
  })

  test("a satisfied requirement never defers: the command just runs", async () => {
    const { store, controller } = await freshController()
    await signedIn(store)
    await reposChosen(store)
    const outcome = await controller.commands.run("billing.balance")
    // The dead backend fails the seam honestly — but nothing parked.
    expect(outcome.status).not.toBe("unknown-command")
    await settled()
    expect(store.session().pendingCommand ?? null).toBeNull()
  })
})
