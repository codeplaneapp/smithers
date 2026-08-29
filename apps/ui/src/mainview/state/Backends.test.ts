import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AgentTurnFrame } from "smithers-shared/NativeAgent"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import type { AppServices } from "./AppController"
import type { Card } from "./AppState"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"

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

const silentAgent = (): NativeAgent => ({
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** A test-double backend: routes answers by path, never a network. */
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

const balanceBody = (totalUsd: string, chargeCount = 0) => ({
  user: "will",
  balance: { totalUsd, totalNanos: 0, lifetimeChargedUsd: "0.05375", chargeCount },
  state: totalUsd === "0" ? "empty" : "ok",
  allowedToStartWork: totalUsd !== "0",
  credits: []
})

describe("identity session record", () => {
  test("a signed-in allowlisted answer drives the record (actor: system)", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({ "/api/auth/session": json(200, { login: "will", allowlisted: true, admin: false }) })
    })
    await controller.loadSession()
    const identity = store.collections.identitySessions.get("identity")
    expect(identity?.state).toBe("signed-in")
    expect(identity?.login).toBe("will")
    expect(identity?.allowlisted).toBe(true)
    const journal = [...store.collections.transitions.values()]
    expect(journal.some((r) => r.type === "identity.session.loaded" && r.actor === "system")).toBe(true)
  })

  test("a 401 is signed-out and the scope list is fetched for the opening chat message", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        // The real /api/auth/scopes shape: one whole sentence per scope.
        "/api/auth/scopes": json(200, {
          provider: "github",
          requestedScopes: ["read:user", "repo"],
          scopes: [
            { scope: "read:user", plain: "See your GitHub profile.", why: "Sign-in." },
            { scope: "repo", plain: "Read access to your repositories.", why: "The connector." }
          ]
        })
      })
    })
    await controller.loadSession()
    const identity = store.collections.identitySessions.get("identity")
    expect(identity?.state).toBe("signed-out")
    expect(identity?.scopesPlain).toBe(
      "Before GitHub asks, here is what Smithers will use: See your GitHub profile. Read access to your repositories."
    )
  })

  // Wave 8: the product Worker's seam restates the expected signed-out 401 as
  // a resolved 200 (the browser logs any 4xx as a console error regardless of
  // how calmly the client handles it). Same resolved state, no error path.
  test("the seam's 200 signed-out answer resolves the same state as a 401", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/auth/session": json(200, { status: "signed-out" }),
        "/api/auth/scopes": json(200, {
          provider: "github",
          requestedScopes: ["read:user"],
          scopes: [{ scope: "read:user", plain: "See your GitHub profile.", why: "Sign-in." }]
        })
      })
    })
    await controller.loadSession()
    const identity = store.collections.identitySessions.get("identity")
    expect(identity?.state).toBe("signed-out")
    expect(identity?.scopesPlain).toBe(
      "Before GitHub asks, here is what Smithers will use: See your GitHub profile."
    )
  })

  test("a signed-in answer drives the balance read from the session answer, not a blind boot probe", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/auth/session": json(200, { login: "will", allowlisted: true, admin: false }),
        "/api/billing/balance": json(200, balanceBody("500"))
      })
    })
    await controller.loadSession()
    await settled()
    const account = store.collections.billingAccounts.get("billing")
    expect(account?.state).toBe("ok")
    expect(account?.totalUsd).toBe("500")
  })

  test("an unreachable seam is recorded as unavailable, which never gates", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      fetchImpl: async () => {
        throw new Error("connection refused")
      }
    })
    await controller.loadSession()
    expect(store.collections.identitySessions.get("identity")?.state).toBe("unavailable")
  })

  test("request access confirms once and is honest when the post fails", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/auth/session": json(200, { login: "newcomer", allowlisted: false, admin: false }),
        "/api/identity/request-access": json(200, { status: "requested" })
      })
    })
    await controller.loadSession()
    await controller.requestAccess()
    const identity = store.collections.identitySessions.get("identity")
    expect(identity?.accessRequested).toBe(true)
    expect(
      [...store.collections.transitions.values()].some(
        (r) => r.type === "identity.access.requested" && r.actor === "user"
      )
    ).toBe(true)
  })

  test("a failed access request is an honest state, not a dead end", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/auth/session": json(200, { login: "newcomer", allowlisted: false, admin: false }),
        "/api/identity/request-access": json(500, { status: "error", message: "queue unavailable" })
      })
    })
    await controller.loadSession()
    await controller.requestAccess()
    const identity = store.collections.identitySessions.get("identity")
    expect(identity?.accessRequested).toBe(false)
    expect(identity?.accessError).toBe("queue unavailable")
  })

  test("sign out posts to the seam and clears the record", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/auth/session": json(200, { login: "will", allowlisted: true, admin: false }),
        "/api/auth/logout": json(200, { status: "ok" })
      })
    })
    await controller.loadSession()
    expect(store.collections.identitySessions.get("identity")?.state).toBe("signed-in")
    await controller.signOut()
    const identity = store.collections.identitySessions.get("identity")
    expect(identity?.state).toBe("signed-out")
    expect(identity?.login).toBeNull()
  })

  test("a signed-out send reaches the backend: identity is not a gate on the chat", async () => {
    const store = await webStore()
    let turns = 0
    const countingAgent: NativeAgent = {
      ...silentAgent(),
      startTurn: async () => {
        turns += 1
        return { status: "started" }
      }
    }
    const controller = createAppController(store, unavailableRepositories, countingAgent, {
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    await controller.loadSession()
    controller.send("can you help me?")
    await settled()

    expect(turns).toBe(1)
    const reply = [...store.collections.messages.values()].find((message) =>
      message.text.includes("Sign in with GitHub first")
    )
    expect(reply).toBeUndefined()
  })

  test("a non-allowlisted send reaches the backend too", async () => {
    const store = await webStore()
    let turns = 0
    const countingAgent: NativeAgent = {
      ...silentAgent(),
      startTurn: async () => {
        turns += 1
        return { status: "started" }
      }
    }
    const controller = createAppController(store, unavailableRepositories, countingAgent, {
      ...backend({
        "/api/auth/session": json(200, { login: "newcomer", allowlisted: false, admin: false })
      })
    })
    await controller.loadSession()
    controller.send("can you help me?")
    await settled()

    expect(turns).toBe(1)
    const reply = [...store.collections.messages.values()].find((message) =>
      message.text.includes("design partners only")
    )
    expect(reply).toBeUndefined()
  })

  test("returning from a failed OAuth redirect is a chat message with a retry action, never a bare page", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), backend({}))
    expect(controller.handleAuthReturn("?auth=failed")).toBe(true)
    const message = [...store.collections.messages.values()].find((entry) =>
      entry.text.includes("GitHub sign-in didn't finish")
    )
    expect(message?.role).toBe("smithers")
    expect(message?.action).toEqual({ flow: "auth.sign-in", label: "Try sign-in again" })
    expect(controller.handleAuthReturn("")).toBe(false)
    expect(controller.handleAuthReturn("?theme=dark")).toBe(false)
  })
})

describe("billing record", () => {
  test("balance refresh records dollars and allowedToStartWork", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({ "/api/billing/balance": json(200, balanceBody("500")) })
    })
    await controller.refreshBalance()
    const account = store.collections.billingAccounts.get("billing")
    expect(account?.state).toBe("ok")
    expect(account?.totalUsd).toBe("500")
    expect(account?.allowedToStartWork).toBe(true)
  })

  test("the balance card states the first-run line once, in dollars", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({ "/api/billing/balance": json(200, balanceBody("500")) })
    })
    await controller.showBalance()
    const card = store.collections.cards.get("billing-balance")
    expect(card?.kind).toBe("balance")
    if (card?.kind === "balance") {
      expect(card.payload.totalUsd).toBe("500")
      expect(card.payload.introUsd).toBe("500")
    }
  })

  test("the intro line is gone once anything has been charged", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({ "/api/billing/balance": json(200, balanceBody("499.94625", 1)) })
    })
    await controller.showBalance()
    const card = store.collections.cards.get("billing-balance")
    if (card?.kind === "balance") expect(card.payload.introUsd).toBeNull()
  })

  test("a definitive $0 NEVER pauses chat — the turn runs (chat is on us during the alpha)", async () => {
    const store = await webStore()
    let turns = 0
    const countingAgent: NativeAgent = {
      ...silentAgent(),
      startTurn: async () => {
        turns += 1
        return { status: "started" }
      }
    }
    const controller = createAppController(store, unavailableRepositories, countingAgent, {
      ...backend({ "/api/billing/balance": json(200, balanceBody("0")) })
    })
    await controller.refreshBalance()
    expect(store.collections.billingAccounts.get("billing")?.allowedToStartWork).toBe(false)

    controller.send("do more work")
    await settled()

    // The free-chat ruling (2026-08-09): interactive chat is complimentary —
    // the pause discipline applies only to non-complimentary (paid) work.
    expect(turns).toBe(1)
    const pause = [...store.collections.messages.values()].find((message) => message.text.includes("balance is at $0"))
    expect(pause).toBeUndefined()
    const submitted = [...store.collections.messages.values()].find(
      (message) => message.text === "do more work"
    )
    expect(submitted?.role).toBe("user")
  })

  test("an unconfigured billing seam is honest and never pauses work", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({})
    })
    await controller.refreshBalance()
    expect(store.collections.billingAccounts.get("billing")?.state).toBe("unavailable")
  })
})

describe("approval round trip", () => {
  const approvalCard = (store: AppStore): Card => {
    const card: Card = {
      id: "approval-1",
      kind: "approval",
      title: "Deploy it?",
      status: "active",
      createdAt: Date.now(),
      ordinal: 900,
      payload: { capability: "run the deploy flow", runId: "run_01", nodeId: "approve", iteration: 0 }
    }
    store.dispatch({ type: "card.upsert", actor: "smithers", card })
    return card
  }

  test("decision → pending → worker → echo freezes the card from the server echo", async () => {
    const store = await webStore()
    let posted: unknown
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/approvals/decision": async (request) => {
          posted = await request.json()
          return json(200, { runId: "run_01", nodeId: "approve", iteration: 0, approved: true })
        }
      })
    })
    approvalCard(store)
    controller.decideApproval("approval-1", "approved")
    const pending = store.collections.cards.get("approval-1")
    if (pending?.kind === "approval") expect(pending.payload.pending).toBe(true)
    await settled()
    expect(posted).toEqual({
      runId: "run_01",
      nodeId: "approve",
      iteration: 0,
      decision: { approved: true }
    })
    const card = store.collections.cards.get("approval-1")
    expect(card?.status).toBe("acted")
    if (card?.kind === "approval") {
      expect(card.payload.decision).toBe("approved")
      expect(card.payload.pending).toBe(false)
      expect(card.payload.decidedAt).toBeDefined()
    }
  })

  test("the deny path round-trips and freezes denied from the echo", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/approvals/decision": json(200, {
          runId: "run_01",
          nodeId: "approve",
          iteration: 0,
          approved: false
        })
      })
    })
    approvalCard(store)
    controller.decideApproval("approval-1", "denied")
    await settled()
    const card = store.collections.cards.get("approval-1")
    expect(card?.status).toBe("acted")
    if (card?.kind === "approval") expect(card.payload.decision).toBe("denied")
  })

  test("a failed round trip is a retryable honest error, never a silent freeze", async () => {
    const store = await webStore()
    let attempts = 0
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        if (!url.includes("/api/approvals/decision")) return json(404, {})
        attempts += 1
        if (attempts === 1) return json(502, { status: "error", message: "gateway unreachable" })
        return json(200, { runId: "run_01", nodeId: "approve", iteration: 0, approved: true })
      }
    })
    approvalCard(store)
    controller.decideApproval("approval-1", "approved")
    await settled()
    let card = store.collections.cards.get("approval-1")
    expect(card?.status).toBe("error")
    if (card?.kind === "approval") {
      expect(card.payload.error).toBe("gateway unreachable")
      expect(card.payload.pending).toBe(false)
      expect(card.payload.decision).toBeUndefined()
    }
    // Retry from the error state succeeds.
    controller.decideApproval("approval-1", "approved")
    await settled()
    card = store.collections.cards.get("approval-1")
    expect(card?.status).toBe("acted")
    if (card?.kind === "approval") expect(card.payload.decision).toBe("approved")
  })

  test("a card with no run identity cannot be fake-decided", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), backend({}))
    store.dispatch({
      type: "card.upsert",
      actor: "smithers",
      card: {
        id: "approval-local",
        kind: "approval",
        title: "Local only",
        status: "active",
        createdAt: Date.now(),
        ordinal: 900,
        payload: { capability: "a demo card" }
      }
    })
    controller.decideApproval("approval-local", "approved")
    const card = store.collections.cards.get("approval-local")
    expect(card?.status).toBe("error")
    if (card?.kind === "approval") {
      expect(card.payload.error).toContain("not linked to a run")
      expect(card.payload.decision).toBeUndefined()
    }
  })
})

describe("turn cost + stop discipline", () => {
  const streamingAgent = (
    emit: (runId: string, push: (frame: AgentTurnFrame) => void) => void
  ): { agent: NativeAgent; cancelled: string[] } => {
    const listeners = new Set<(frame: AgentTurnFrame) => void>()
    const cancelled: string[] = []
    return {
      cancelled,
      agent: {
        available: true,
        startTurn: async (request) => {
          queueMicrotask(() => emit(request.runId, (frame) => listeners.forEach((l) => l(frame))))
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
    }
  }

  test("a completed turn carries NO per-turn dollar line — chat is complimentary", async () => {
    const store = await webStore()
    let usageReads = 0
    const { agent } = streamingAgent((runId, push) => {
      push({ runId, type: "delta", kind: "text", text: "Done." })
      push({ runId, type: "done" })
    })
    const controller = createAppController(store, unavailableRepositories, agent, {
      ...backend({
        "/api/billing/balance": json(200, balanceBody("499.94625", 1)),
        "/api/billing/usage": () => {
          usageReads += 1
          return json(200, { runId: "x", charges: [{ chargeId: "c1" }], totalUsd: "0.05375" })
        }
      })
    })
    controller.send("hello")
    await settled()
    await settled()
    const response = [...store.collections.messages.values()].find((m) => m.text === "Done.")
    // The true cost is recorded by the billing seam (zero debited); the UI
    // never states a per-turn dollar line and never asks for one.
    expect("costUsd" in (response ?? {})).toBe(false)
    expect(usageReads).toBe(0)
    // The balance chip still refreshes from the real answer after the turn.
    expect(store.collections.billingAccounts.get("billing")?.totalUsd).toBe("499.94625")
  })

  test("a turn that dies server-side mid-stream surfaces as an honest failure", async () => {
    const store = await webStore()
    const { agent } = streamingAgent((runId, push) => {
      push({ runId, type: "delta", kind: "text", text: "partial" })
      push({
        runId,
        type: "done",
        error: "The response stream ended before Smithers finished the turn."
      })
    })
    const controller = createAppController(store, unavailableRepositories, agent, backend({}))
    controller.send("hello")
    await settled()
    const response = [...store.collections.messages.values()].find((m) => m.text === "partial")
    expect(response?.status).toBe("failed")
    expect(response?.statusDetail).toContain("stream ended")
    expect(store.session().phase).toBe("idle")
  })

  test("a server-side kill surfaces as an interrupted turn with the honest line", async () => {
    const store = await webStore()
    const { agent } = streamingAgent((runId, push) => {
      push({ runId, type: "delta", kind: "text", text: "partial work" })
      // The Worker's terminal frame for a kill through /api/agent/turn/cancel.
      push({ runId, type: "done", reason: "cancelled" })
    })
    const controller = createAppController(store, unavailableRepositories, agent, backend({}))
    controller.send("hello")
    await settled()
    const response = [...store.collections.messages.values()].find((m) => m.text === "partial work")
    expect(response?.status).toBe("interrupted")
    expect(response?.statusDetail).toBe("That turn was stopped by the server.")
    expect(store.session().phase).toBe("idle")
  })

  test("a kill landing before the first delta still describes the turn, never silence", async () => {
    const store = await webStore()
    const { agent } = streamingAgent((runId, push) => {
      // No delta at all: the kill beat the model's first token.
      push({ runId, type: "done", reason: "cancelled" })
    })
    const controller = createAppController(store, unavailableRepositories, agent, backend({}))
    controller.send("hello")
    await settled()
    const response = [...store.collections.messages.values()].find(
      (m) => m.text === "That turn was stopped by the server."
    )
    expect(response?.role).toBe("smithers")
    expect(response?.status).toBe("interrupted")
    expect(store.session().phase).toBe("idle")
  })

  test("stop cancels the endpoint and says what it stopped, keeping the partial text", async () => {
    const store = await webStore()
    const { agent, cancelled } = streamingAgent((runId, push) => {
      push({ runId, type: "delta", kind: "text", text: "working on it" })
    })
    const controller = createAppController(store, unavailableRepositories, agent, backend({}))
    controller.send("hello")
    await settled()
    controller.stop()
    expect(cancelled).toHaveLength(1)
    const response = [...store.collections.messages.values()].find((m) => m.text === "working on it")
    expect(response?.status).toBe("interrupted")
    expect(response?.statusDetail).toBe("Stopped the current response.")
    expect(store.session().phase).toBe("idle")
  })
})
