import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import type { AppBootstrap } from "smithers-shared/AppBootstrap"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { RECOMMENDATION_ID } from "./AppState"
import type { Repo } from "./AppState"
import { createAppController } from "./AppController"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"

/*
 * The recommender as a workflow: a material change → the `recommend` flow →
 * the rule's pills at once, then a cheap side turn whose validated answer
 * replaces them. No real model is ever asked here — the agent is a recorder.
 */

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

const nativeRepositories: NativeRepositories = {
  available: true,
  pickLocalRepository: async () => ({ status: "cancelled" })
}

const localBootstrap: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "1.0.0",
  buildSha: "abcdef1234567890",
  capabilities: ["agent", "local.repositories", "local.targets", "local.terminal", "local.harnesses"],
  authFlow: "none",
  sandbox: { platform: "darwin", mode: "enforced" }
}

const repo: Repo = {
  id: "repo-1",
  name: "smithers",
  path: "/Users/will/smithers",
  git: { branch: "main", remote: null },
  warnings: [],
  smithers: {
    detected: true,
    workspaceFile: "smithers.workspace.ts",
    declarationFiles: ["legacy declaration"],
    reason: "workspace file present",
    workspaces: [{ path: ".", title: "smithers" }]
  }
}

const settle = async (ticks = 4) => {
  for (let tick = 0; tick < ticks; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** An agent that records every side turn and answers on demand. */
const recordingAgent = (available = true) => {
  const launches: StartAgentTurnRequest[] = []
  const cancelled: string[] = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const agent: NativeAgent = {
    available,
    startTurn: async (request) => {
      launches.push(request)
      return { status: "started" }
    },
    cancelTurn: async (runId) => {
      cancelled.push(runId)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const emit = (frame: AgentTurnFrame) => {
    for (const listener of listeners) listener(frame)
  }
  return {
    agent,
    launches,
    cancelled,
    answer: (runId: string, text: string) => {
      emit({ runId, type: "delta", kind: "text", text })
      emit({ runId, type: "done", reason: "stop" })
    },
    fail: (runId: string) => emit({ runId, type: "done", error: "upstream refused" })
  }
}

const boot = async (agent: NativeAgent, repositories = nativeRepositories, services: AppServices = {}) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, repositories, agent, {
    bootstrap: localBootstrap,
    features: { suggestionPills: true },
    recommender: { enabled: true, debounceMs: 0 },
    ...services
  })
  return { store, controller }
}

const row = (store: Awaited<ReturnType<typeof boot>>["store"]) =>
  store.collections.recommendations.get(RECOMMENDATION_ID)

describe("recommend — the flow", () => {
  test("is registered, hidden from the slash menu, and never the model's to call", async () => {
    const { controller } = await boot(recordingAgent().agent)
    const entry = controller.commands.find("system.recommend")
    expect(entry).toBeDefined()
    expect(entry?.metadata.hidden).toBe(true)
    expect(entry?.binding.descriptor.modelInvocable).toBe(false)
    expect(controller.slashItems("recomm").map((item) => item.flow.name)).not.toContain("system.recommend")
  })

  test("opening a repository retires 'Select a repo' at once and asks the cheap tier for the next click", async () => {
    const recorder = recordingAgent()
    const { store, controller } = await boot(recorder.agent)
    // The fresh session's rule: the repo step leads.
    await controller.recommend()
    expect(row(store)?.suggestions[0]?.flow).toBe("repo.open")

    store.dispatch({ type: "repos.loaded", actor: "system", repos: [repo] })
    await settle()

    const current = row(store)
    expect(current?.source).toBe("rule")
    expect(current?.suggestions.map((suggestion) => suggestion.flow)).not.toContain("repo.open")
    const side = recorder.launches.filter((launch) => launch.runId.startsWith("recommend-")).at(-1)
    expect(side).toBeDefined()
    expect(side?.tier).toBe("cheap")
    expect(side?.purpose).toBe("recommend")
    expect(side?.tools).toBeUndefined()
    const ask = side?.messages[0]
    expect(ask !== undefined && "content" in ask ? ask.content : "").toContain("Repositories open: smithers")
    // The side turn is invisible to the conversation.
    expect(store.session().phase).toBe("idle")
    expect([...store.collections.messages.values()].some((message) => message.role === "user")).toBe(false)
  })

  test("the agent's validated answer replaces the rule; unknown flows are dropped", async () => {
    const recorder = recordingAgent()
    const { store } = await boot(recorder.agent)
    store.dispatch({ type: "repos.loaded", actor: "system", repos: [repo] })
    await settle()
    const side = recorder.launches.find((launch) => launch.runId.startsWith("recommend-"))
    recorder.answer(
      side?.runId ?? "",
      JSON.stringify({
        suggestions: [
          { flow: "chat.commands", label: "See what I can do", why: "fresh repository" },
          { flow: "deploy.everything", label: "nope" }
        ]
      })
    )
    await settle()
    const current = row(store)
    expect(current?.source).toBe("agent")
    expect(current?.suggestions.map((suggestion) => suggestion.flow)).toEqual(["chat.commands"])
    expect(current?.suggestions[0]).toMatchObject({ label: "See what I can do", why: "fresh repository", emphasis: "primary" })
  })

  test("a refused, failed, or empty answer leaves the rule standing", async () => {
    const recorder = recordingAgent()
    const { store } = await boot(recorder.agent)
    store.dispatch({ type: "repos.loaded", actor: "system", repos: [repo] })
    await settle()
    const side = recorder.launches.find((launch) => launch.runId.startsWith("recommend-"))
    recorder.fail(side?.runId ?? "")
    await settle()
    expect(row(store)?.source).toBe("rule")

    store.dispatch({
      type: "tab.opened",
      actor: "user",
      tab: { id: "tab-x", kind: "terminal", title: "Terminal", sessionId: "pty-x", cwd: "/Users/will/smithers" }
    })
    await settle()
    const second = recorder.launches.filter((launch) => launch.runId.startsWith("recommend-"))[1]
    recorder.answer(second?.runId ?? "", "Just click around.")
    await settle()
    expect(row(store)?.source).toBe("rule")
  })

  test("without an agent seam the rule alone writes the row and nothing is launched", async () => {
    const recorder = recordingAgent(false)
    const { store } = await boot(recorder.agent, unavailableRepositories)
    store.dispatch({ type: "repos.loaded", actor: "system", repos: [repo] })
    await settle()
    expect(row(store)?.source).toBe("rule")
    expect(recorder.launches.length).toBe(0)
  })

  test("a newer state supersedes the side turn in flight; the old answer is dropped", async () => {
    const recorder = recordingAgent()
    const { store } = await boot(recorder.agent)
    store.dispatch({ type: "repos.loaded", actor: "system", repos: [repo] })
    await settle()
    const first = recorder.launches.find((launch) => launch.runId.startsWith("recommend-"))
    store.dispatch({ type: "repos.loaded", actor: "system", repos: [] })
    await settle()
    const sides = recorder.launches.filter((launch) => launch.runId.startsWith("recommend-"))
    expect(sides.length).toBe(2)
    expect(recorder.cancelled).toContain(first?.runId ?? "")
    recorder.answer(first?.runId ?? "", JSON.stringify({ suggestions: [{ flow: "chat.commands", label: "Stale" }] }))
    await settle()
    expect(row(store)?.source).toBe("rule")
    recorder.answer(sides[1]?.runId ?? "", JSON.stringify({ suggestions: [{ flow: "world", label: "Fresh" }] }))
    await settle()
    expect(row(store)?.suggestions.map((suggestion) => suggestion.label)).toEqual(["Fresh"])
  })

  test("a keystroke never regenerates", async () => {
    const recorder = recordingAgent()
    const { controller } = await boot(recorder.agent)
    controller.changeDraft("hel")
    controller.changeDraft("hello")
    await settle()
    expect(recorder.launches.length).toBe(0)
  })

  test("feature flag off (the default): the recommender enabled or not, no side turn launches; the rule row still lands", async () => {
    const recorder = recordingAgent()
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    createAppController(store, nativeRepositories, recorder.agent, {
      bootstrap: localBootstrap,
      recommender: { enabled: true, debounceMs: 0 }
    })
    store.dispatch({ type: "repos.loaded", actor: "system", repos: [repo] })
    await settle()
    expect(recorder.launches.length).toBe(0)
    expect(store.collections.recommendations.get(RECOMMENDATION_ID)?.source).toBe("rule")
  })

  test("opt-in: a harness that does not enable it gets the rule only and its agent seam is never called", async () => {
    const recorder = recordingAgent()
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    createAppController(store, nativeRepositories, recorder.agent, {
      bootstrap: localBootstrap,
      features: { suggestionPills: true },
      recommender: { debounceMs: 0 }
    })
    store.dispatch({ type: "repos.loaded", actor: "system", repos: [repo] })
    await settle()
    expect(row(store)?.source).toBe("rule")
    expect(recorder.launches.length).toBe(0)
  })
})
