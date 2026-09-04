import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { renderAgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

/** An agent double that records every turn request and ends the turn fast. */
const recordingAgent = (requests: StartAgentTurnRequest[]): NativeAgent => ({
  available: true,
  startTurn: async (request) => {
    requests.push(request)
    return { status: "error", message: "Recorded." }
  },
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("per-turn runtime context", () => {
  test("every turn carries a freshly derived context identifying the Smithers product", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))

    controller.send("hey smithers what app am I in")
    await settled()

    expect(requests).toHaveLength(1)
    const context = requests[0]?.context
    expect(context?.version).toBe(1)
    expect(context?.product).toBe("smithers")
    expect(context?.surface).toBe("chat")
    expect(context?.connectors).toEqual([])
    expect(context?.limitations.some((line) => line.includes("Cannot see"))).toBe(true)
  })

  test("a state change between turns shows up in the next turn's context", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))

    controller.send("first turn")
    await settled()
    controller.showWorld()
    controller.send("second turn")
    await settled()

    expect(requests).toHaveLength(2)
    expect(requests[0]?.context?.surface).toBe("chat")
    expect(requests[1]?.context?.surface).toBe("world")
    // Freshly derived, not cached: the revision moved with the surface change.
    const firstRevision = requests[0]?.context?.revision ?? 0
    expect(requests[1]?.context?.revision ?? 0).toBeGreaterThan(firstRevision)
    const firstCaptured = requests[0]?.context?.capturedAt ?? 0
    expect(requests[1]?.context?.capturedAt ?? 0).toBeGreaterThanOrEqual(firstCaptured)
  })

  test("the hidden context never enters the persisted visible transcript", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))

    controller.send("what app am I in")
    await settled()

    expect(requests[0]?.context).toBeDefined()
    for (const message of store.collections.messages.values()) {
      expect(message.text).not.toContain("Runtime context")
      expect(message.text).not.toContain("running INSIDE the Smithers product")
      expect(message.reasoning ?? "").not.toContain("Runtime context")
    }
  })

  test("a tool-loop continuation leg rebuilds the context, it does not replay the first leg's", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const listeners = new Set<(frame: AgentTurnFrame) => void>()
    // Leg 1 asks for a command that mutates world state; leg 2 must SEE it.
    const agent: NativeAgent = {
      available: true,
      startTurn: async (request) => {
        const leg = requests.length
        requests.push(request)
        queueMicrotask(() => {
          const frames: ReadonlyArray<AgentTurnFrame> = leg === 0
            ? [
              {
                runId: request.runId,
                type: "tool_call",
                call_id: "call_1",
                name: "commands",
                arguments: JSON.stringify({ action: "execute", name: "world.new-note" })
              },
              { runId: request.runId, type: "done", reason: "tool_call" }
            ]
            : [
              { runId: request.runId, type: "delta", kind: "text", text: "Noted." },
              { runId: request.runId, type: "done", reason: "stop" }
            ]
          for (const frame of frames) for (const listener of listeners) listener(frame)
        })
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    const controller = createAppController(store, unavailableRepositories, agent)

    controller.send("make me a note")
    await settled()
    await settled()

    expect(requests).toHaveLength(2)
    const before = requests[0]?.context
    const after = requests[1]?.context
    expect(before?.worldState.documentCount ?? -1).toBeGreaterThanOrEqual(0)
    expect(after?.worldState.documentCount ?? 0).toBe((before?.worldState.documentCount ?? 0) + 1)
    expect(after?.revision ?? 0).toBeGreaterThan(before?.revision ?? 0)
  })

  test("web limitations are honest about the native-only repository picker", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))

    controller.send("connect my repo")
    await settled()

    const limitations = requests[0]?.context?.limitations ?? []
    expect(limitations.some((line) => line.includes("pure-web client cannot connect"))).toBe(true)
  })

  test("Smithers is the first tab and sees every other one: the context lists the tabs and their status", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests), {
      bootstrap: {
        apiVersion: 1,
        host: "local",
        version: "test",
        buildSha: "test",
        capabilities: ["local.terminal", "local.harnesses"],
        authFlow: "none",
        sandbox: { platform: "darwin", mode: "enforced" }
      }
    })
    await store.dispatch({
      type: "harnesses.loaded",
      actor: "system",
      harnesses: [{
        id: "claude",
        displayName: "Claude Code",
        binary: "/opt/homebrew/bin/claude",
        version: "2.1.0",
        status: "signed-in",
        account: { email: "will@codeplane.app" },
        launch: { argv: ["claude"] }
      }]
    }).isPersisted.promise
    await store.dispatch({
      type: "tab.opened",
      actor: "user",
      tab: { id: "h1", kind: "harness", title: "Claude Code · ~", sessionId: "h1", harnessId: "claude", cwd: "~" }
    }).isPersisted.promise
    await store.dispatch({ type: "tab.selected", actor: "user", id: "main" }).isPersisted.promise

    controller.send("what is the agent doing")
    await settled()
    const tabs = requests[0]?.context?.tabs ?? []
    expect(tabs).toEqual([
      { id: "main", kind: "main", title: "Smithers", status: "open", active: true },
      {
        id: "h1",
        kind: "harness",
        title: "Claude Code · ~",
        harnessId: "claude",
        account: "will@codeplane.app",
        cwd: "~",
        status: "running",
        exitCode: null,
        active: false
      }
    ])
    expect(requests[0]?.context?.capabilities.some((line) => line.includes("tab.read"))).toBe(true)

    await store.dispatch({ type: "pty.exited", actor: "system", sessionId: "h1", code: 0 }).isPersisted.promise
    controller.send("and now?")
    await settled()
    expect(requests[1]?.context?.tabs?.[1]).toMatchObject({ status: "exited", exitCode: 0 })
  })

  /*
   * agent-parity.md: the agent tried /workspace.terminal, failed on the
   * missing cloud session, and ran /auth.prompt — GitHub, already connected —
   * because the context stated GitHub and never the Smithers Cloud session.
   */
  test("the native app's context states the Smithers Cloud session and names cloud.prompt when it is signed out", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests), {
      bootstrap: {
        apiVersion: 1,
        host: "local",
        version: "test",
        buildSha: "test",
        capabilities: ["agent", "identity", "jjhub", "cloud.pat", "cloud.terminal"],
        authFlow: "both",
        sandbox: { platform: "darwin", mode: "enforced" }
      }
    })
    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-out", username: null, expiresAt: null, scopes: null }).isPersisted.promise
    controller.send("launch a terminal")
    await settled()
    expect(requests[0]?.context?.cloud).toEqual({ state: "signed-out", username: null })
    const signedOut = renderAgentRuntimeContext(requests[0]?.context as AgentRuntimeContext)
    expect(signedOut).toContain("- Smithers Cloud: signed out (workspaces, changes and sync need it; cloud.prompt renders the sign-in button).")

    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null }).isPersisted.promise
    controller.send("and now?")
    await settled()
    expect(requests[1]?.context?.cloud).toEqual({ state: "signed-in", username: "will" })
    expect(renderAgentRuntimeContext(requests[1]?.context as AgentRuntimeContext)).toContain("- Smithers Cloud: signed in as will.")

    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: "degraded" }).isPersisted.promise
    controller.send("workspaces?")
    await settled()
    expect(requests[2]?.context?.cloud).toEqual({ state: "degraded", username: "will" })
  })

  test("on the web the GitHub sign-in is the Smithers Cloud sign-in, so the cloud line follows the identity", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests), {
      bootstrap: {
        apiVersion: 1,
        host: "cloud",
        version: "test",
        buildSha: "cloud",
        capabilities: ["agent", "identity", "jjhub"],
        authFlow: "redirect",
        sandbox: null
      }
    })
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null })
    controller.send("hi")
    await settled()
    expect(requests[0]?.context?.cloud).toEqual({ state: "signed-out", username: null })
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null })
    controller.send("again")
    await settled()
    expect(requests[1]?.context?.cloud).toEqual({ state: "signed-in", username: "will" })
  })

  test("a host with no cloud door states the session unavailable", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests), {
      bootstrap: {
        apiVersion: 1,
        host: "local",
        version: "test",
        buildSha: "test",
        capabilities: ["local.terminal"],
        authFlow: "none",
        sandbox: { platform: "darwin", mode: "enforced" }
      }
    })
    controller.send("hi")
    await settled()
    expect(requests[0]?.context?.cloud).toEqual({ state: "unavailable", username: null })
    expect(renderAgentRuntimeContext(requests[0]?.context as AgentRuntimeContext)).toContain("- Smithers Cloud: unavailable on this host.")
  })

  test("alone, the context says so and offers no tab.read", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))
    controller.send("hi")
    await settled()
    expect(requests[0]?.context?.tabs).toEqual([{ id: "main", kind: "main", title: "Smithers", status: "open", active: true }])
    expect(requests[0]?.context?.capabilities.some((line) => line.includes("tab.read"))).toBe(false)
  })
})
