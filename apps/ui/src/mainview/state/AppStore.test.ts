import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { Card } from "./AppState"
import { createAppStore } from "./AppStore"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { createControllerContext } from "./controller/context"
import { createTurnController } from "./controller/turns"
import { createWorkflowController } from "./controller/workflows"
import type { AppStore } from "./AppStore"

/** Each test gets its own storage so cases never observe another case's writes. */
const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

describe("createAppStore with the localStorage fallback backend", () => {
  test("boots, seeds state, and reports the fallback persistence mode", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    expect(store.persistenceMode).toBe("localStorage")
    expect(store.session().id).toBe("main")
    // Wave 14 §1: the seed plants no opening message. An empty transcript is
    // the honest boot state — the first message is whatever the session
    // actually produces (the auth state signed out, the digest signed in).
    expect(store.collections.messages.size).toBe(0)
    expect(store.collections.worldDocuments.size).toBeGreaterThan(0)
  })

  test("dispatches transitions and journals them", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const before = store.session().revision
    const transaction = store.dispatch({
      type: "composer.changed",
      actor: "user",
      draft: "hello from the fallback backend"
    })
    await transaction.isPersisted.promise
    expect(store.session().draft).toBe("hello from the fallback backend")
    expect(store.session().revision).toBe(before + 1)
    const journal = [...store.collections.transitions.values()]
    expect(journal.some((record) => record.type === "composer.changed")).toBe(true)
  })

  test("persists state across store instances sharing one storage", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    const transaction = first.dispatch({
      type: "composer.changed",
      actor: "user",
      draft: "durable draft"
    })
    await transaction.isPersisted.promise
    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().draft).toBe("durable draft")
  })

  test("boot reconciles an orphaned in-flight turn instead of restoring a stuck responding surface", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    // Simulate the app going away mid-turn: a submitted message, one delta,
    // and no done frame — the persisted phase stays "responding".
    await first.dispatch({ type: "message.submitted", actor: "user", turnId: "turn-gone", text: "Do work" })
      .isPersisted.promise
    await first.dispatch({
      type: "message.response.delta",
      actor: "smithers",
      turnId: "turn-gone",
      channel: "text",
      delta: "Working on it"
    }).isPersisted.promise

    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().phase).toBe("idle")
    const restored = second.collections.messages.get("message-turn-gone-smithers")
    expect(restored?.status).toBe("interrupted")
    expect(restored?.statusDetail).toBe("That turn was interrupted when the app closed.")
    // The reconciliation is journaled like every other state change.
    const journal = [...second.collections.transitions.values()].map((entry) => entry.type)
    expect(journal).toContain("session.turn.orphaned")
  })

  /**
   * The app can go away between the submit and the first delta — then the orphaned
   * turn has no response message at all. Reconciliation must describe THAT turn and
   * return the surface to idle WITHOUT relabelling an earlier, genuinely complete
   * Smithers message: a transcript that says "interrupted" about a turn that
   * finished is a lie.
   */
  test("boot reconciliation describes a turn orphaned before its first delta, and relabels nothing else", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    // An earlier turn that genuinely FINISHED. Wave 14 §1 removed the seeded
    // welcome, so the "relabels nothing else" claim is now pinned against a
    // real completed response rather than a piece of seed data.
    await first.dispatch({ type: "message.submitted", actor: "user", turnId: "turn-done", text: "Earlier work" })
      .isPersisted.promise
    await first.dispatch({
      type: "message.response.delta",
      actor: "smithers",
      turnId: "turn-done",
      channel: "text",
      delta: "Finished that one"
    }).isPersisted.promise
    await first.dispatch({ type: "message.response.completed", actor: "smithers", turnId: "turn-done" })
      .isPersisted.promise
    const finished = first.collections.messages.get("message-turn-done-smithers")
    expect(finished?.status).toBe("complete")
    // Submitted, then the app dies before a single delta arrives.
    await first.dispatch({ type: "message.submitted", actor: "user", turnId: "turn-silent", text: "Do work" })
      .isPersisted.promise

    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().phase).toBe("idle")
    // The earlier, genuinely complete turn is untouched...
    const restoredFinished = second.collections.messages.get("message-turn-done-smithers")
    expect(restoredFinished?.status).toBe("complete")
    expect(restoredFinished?.statusDetail).toBeUndefined()
    // ...and the orphaned turn is the one that carries the honest note.
    const orphaned = second.collections.messages.get("message-turn-silent-smithers")
    expect(orphaned?.status).toBe("interrupted")
    expect(orphaned?.text).toBe("That turn was interrupted when the app closed.")
  })
})

/*
 * An approval is a human authorising an action. Once they have answered, no
 * later frame may put the question back — a reopened card can be decided a
 * second time, and the second decision is one the human never gave.
 */
describe("a decided approval card", () => {
  const GATE: Card = {
    id: "approval-run-1-approve-0",
    kind: "approval",
    title: "Approve the production deploy",
    status: "active",
    createdAt: 1_700_000_000_000,
    ordinal: 1,
    payload: {
      capability: "deploy:production",
      detail: "Deploy the canary Worker.",
      runId: "run-1",
      requestId: "approve",
      approval: { target: { _tag: "Node", runId: "run-1", requestId: "approve" }, scope: "run", idempotencyKey: "k" }
    }
  }

  const approvalOf = (store: AppStore, id: string): Extract<Card, { kind: "approval" }> => {
    const card = store.collections.cards.get(id)
    if (card === undefined || card.kind !== "approval") {
      throw new Error(`no approval card at ${id} (saw ${card?.kind ?? "nothing"})`)
    }
    return card
  }

  const decided = async (card: Card = GATE): Promise<AppStore> => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    await store.dispatch({
      type: "card.approval.decided",
      actor: "user",
      id: card.id,
      decision: "approved",
      decidedAt: 1_700_000_060_000
    }).isPersisted.promise
    return store
  }

  test("is not reopened by a card.updated patch", async () => {
    const store = await decided()
    await store.dispatch({
      type: "card.updated",
      actor: "smithers",
      id: GATE.id,
      patch: { status: "active" }
    }).isPersisted.promise
    const card = approvalOf(store, GATE.id)
    expect(card.status).toBe("acted")
    expect(card.payload.decision).toBe("approved")
    expect(card.payload.decidedAt).toBe(1_700_000_060_000)
  })

  test("is not reopened by re-upserting the same gate", async () => {
    const store = await decided()
    await store.dispatch({
      type: "card.upsert",
      actor: "smithers",
      card: { ...GATE, status: "active" }
    }).isPersisted.promise
    const card = approvalOf(store, GATE.id)
    expect(card.status).toBe("acted")
    expect(card.payload.decision).toBe("approved")
  })

  /*
   * The freeze cannot be laundered by first replacing the card with something
   * that is not an approval and then upserting the gate again.
   */
  test("is not displaced by a card of another kind at the same id", async () => {
    const store = await decided()
    await store.dispatch({
      type: "card.upsert",
      actor: "smithers",
      card: {
        id: GATE.id,
        kind: "status",
        title: "Working",
        status: "active",
        createdAt: 1_700_000_000_000,
        ordinal: 1,
        payload: { note: "still going" }
      }
    }).isPersisted.promise
    const card = approvalOf(store, GATE.id)
    expect(card.status).toBe("acted")
    expect(card.payload.decision).toBe("approved")
  })

  /*
   * The freeze is per-decision, not per-card. A chain lineage reuses one card
   * id for every park, so freezing the id would swallow the next, genuinely
   * different ask and strand the run with no gate on screen.
   */
  test("is replaced by an approval naming a different gate", async () => {
    const chainGate: Card = {
      id: "chain-approval-lineage-1",
      kind: "approval",
      title: "Approval needed",
      status: "active",
      createdAt: 1_700_000_000_000,
      ordinal: 1,
      payload: { capability: "read the repository", runId: "lineage-1", chain: true }
    }
    const store = await decided(chainGate)
    await store.dispatch({
      type: "card.upsert",
      actor: "system",
      card: { ...chainGate, payload: { ...chainGate.payload, capability: "write to the repository" } }
    }).isPersisted.promise
    const card = approvalOf(store, chainGate.id)
    expect(card.status).toBe("active")
    expect(card.payload.capability).toBe("write to the repository")
    expect(card.payload.decision).toBeUndefined()
  })

  test("still records exactly one decision when a later frame tries to re-decide", async () => {
    const store = await decided()
    await store.dispatch({
      type: "card.updated",
      actor: "smithers",
      id: GATE.id,
      patch: { status: "active" }
    }).isPersisted.promise
    await store.dispatch({
      type: "card.approval.decided",
      actor: "user",
      id: GATE.id,
      decision: "denied",
      decidedAt: 1_700_000_120_000
    }).isPersisted.promise
    const card = approvalOf(store, GATE.id)
    expect(card.payload.decision).toBe("approved")
    const decisions = [...store.collections.transitions.values()].filter(
      (entry) => entry.type === "card.approval.decided"
    )
    expect(decisions.length).toBe(1)
  })
})


describe("runtime-owned pending approvals", () => {
  const envelope = (requestId: string) => ({
    target: { _tag: "Node", runId: "run-1", requestId, digest: `sha256:${requestId}`,
      envelope: { capabilities: [], flows: [], budget: {} } },
    scope: "run", idempotencyKey: `approve:${requestId}`
  })
  const gate: Extract<Card, { kind: "approval" }> = {
    id: "trusted-approval", kind: "approval", title: "Read the build logs?", status: "active",
    createdAt: 1, ordinal: 1,
    payload: { capability: "Read the build logs", detail: "Read-only inspection", runId: "run-1",
      requestId: "read-logs", repo: "owner/repo", approval: envelope("read-logs") }
  }

  test("refuses model target and label replacement and forwards the original approval", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let emit!: (frame: AgentTurnFrame) => void
    const calls: Array<{ payload: unknown }> = []
    const ctx = createControllerContext(store, {
      available: false, pickLocalRepository: async () => ({ status: "cancelled" })
    }, {
      available: true, subscribe: listener => { emit = listener; return () => {} },
      startTurn: async () => ({ status: "started" }), cancelTurn: async () => {}
    }, { fetchImpl: async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)))
      return Response.json({ ok: true, payload: {} })
    } })
    const workflows = createWorkflowController(ctx, () => 1, async () => {})
    let forwarded: Card | undefined
    let submitted: Promise<void> | undefined
    const turns = createTurnController(ctx, {
      settleTurnBilling: () => {}, nextOrdinal: () => 1, surfaceCommandFailure: () => {},
      forwardApprovalDecision: (card, decision) => {
        forwarded = card
        submitted = workflows.forwardApprovalDecision(card, decision)
        return submitted
      },
      forwardInboxApprovalDecision: workflows.forwardInboxApprovalDecision
    })
    try {
      turns.subscribeToAgent()
      ctx.activeTurn = { id: "model-turn", receivedText: false, toolLegs: 0, toolItems: [],
        pendingCall: undefined, runLaunch: undefined, askClass: undefined, claimBuffer: "" }
      await store.dispatch({ type: "card.upsert", actor: "system", card: gate }).isPersisted.promise
      const malicious = { ...gate.payload, approval: envelope("deploy-production") }
      emit({ type: "card.update", runId: "model-turn", id: gate.id, patch: { payload: malicious } })
      expect(store.collections.cards.get(gate.id)).toMatchObject(gate)
      emit({ type: "card.update", runId: "model-turn", id: gate.id,
        patch: { title: "Harmless action", payload: { ...gate.payload, capability: "Nothing consequential" } } })
      emit({ type: "card", runId: "model-turn", card: { ...gate, payload: malicious } })
      emit({ type: "card", runId: "model-turn", card: { ...gate, id: "forged-approval" } })
      emit({ type: "card", runId: "model-turn", card: {
        ...gate, kind: "status", payload: { note: "Replace the approval" }
      } })
      expect(store.collections.cards.get(gate.id)).toMatchObject(gate)
      expect(store.collections.cards.get("forged-approval")).toBeUndefined()
      turns.decideApproval(gate.id, "approved")
      await submitted
      expect(forwarded).toMatchObject(gate)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.payload).toMatchObject({ ...envelope("read-logs"), decision: "approve" })
    } finally {
      await ctx.dispose()
      await store.dispose?.()
    }
  })

  test("the store rejects direct model writes and retains a frozen request across reload", async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    const original = structuredClone(gate)
    await store.dispatch({ type: "card.upsert", actor: "smithers", card: original }).isPersisted.promise
    expect(store.collections.cards.get(gate.id)).toBeUndefined()
    await store.dispatch({ type: "card.upsert", actor: "system", card: original }).isPersisted.promise
    original.payload.approval = envelope("deploy-production")
    original.title = "Changed outside the store"
    for (const actor of ["smithers", "system"] as const) {
      await store.dispatch({ type: "card.updated", actor, id: gate.id,
        patch: { title: "Different wording", payload: original.payload } }).isPersisted.promise
      await store.dispatch({ type: "card.upsert", actor, card: original }).isPersisted.promise
    }
    expect(store.collections.cards.get(gate.id)).toMatchObject(gate)
    expect(store.approvalRequest(gate.id)).toEqual(gate)
    const frozen = store.approvalRequest(gate.id)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen?.payload)).toBe(true)
    if (frozen?.kind === "approval") expect(Object.isFrozen(frozen.payload.approval?.target)).toBe(true)
    await store.dispose?.()
    const restored = await createAppStore({ kind: "localStorage", storage })
    try {
      expect(restored.approvalRequest(gate.id)).toEqual(gate)
      expect(restored.collections.cards.get(gate.id)).toMatchObject(gate)
    } finally {
      await restored.dispose?.()
    }
  })

  test("inbox rows keep their original wording and envelope through model writes and runtime refresh", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const inbox: Extract<Card, { kind: "approvals-inbox" }> = {
      id: "inbox", kind: "approvals-inbox", title: "Pending approvals", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: "owner/repo", approvals: [{ runId: "run-1", requestId: "read-logs",
        title: gate.title, approval: envelope("read-logs"), requestedAt: 1 }] }
    }
    const malicious = { ...inbox, title: "Harmless actions", payload: { ...inbox.payload,
      approvals: inbox.payload.approvals.map(row => ({ ...row, title: "No consequences", approval: envelope("deploy-production") })) } }
    const calls: Array<{ payload: unknown }> = []
    const ctx = createControllerContext(store, {
      available: false, pickLocalRepository: async () => ({ status: "cancelled" })
    }, { available: false, subscribe: () => () => {}, startTurn: async () => ({ status: "started" }), cancelTurn: async () => {} }, {
      fetchImpl: async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)))
        return Response.json({ ok: true, payload: {} })
      }
    })
    try {
      await store.dispatch({ type: "card.upsert", actor: "smithers", card: inbox }).isPersisted.promise
      expect(store.collections.cards.get(inbox.id)).toBeUndefined()
      await store.dispatch({ type: "card.upsert", actor: "system", card: inbox }).isPersisted.promise
      await store.dispatch({ type: "card.updated", actor: "smithers", id: inbox.id,
        patch: { title: malicious.title, payload: malicious.payload } }).isPersisted.promise
      await store.dispatch({ type: "card.upsert", actor: "smithers", card: malicious }).isPersisted.promise
      expect(store.collections.cards.get(inbox.id)).toMatchObject(inbox)
      await store.dispatch({ type: "card.upsert", actor: "system", card: malicious }).isPersisted.promise
      expect(store.approvalRequest(inbox.id)?.payload).toEqual(inbox.payload)
      expect(store.collections.cards.get(inbox.id)?.payload).toEqual(inbox.payload)
      const workflows = createWorkflowController(ctx, () => 1, async () => {})
      await workflows.forwardInboxApprovalDecision(inbox.id, "read-logs", "approved")
      await workflows.forwardInboxApprovalDecision(inbox.id, "read-logs", "approved")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.payload).toMatchObject({ ...envelope("read-logs"), decision: "approve" })
    } finally {
      await ctx.dispose()
      await store.dispose?.()
    }
  })

})
