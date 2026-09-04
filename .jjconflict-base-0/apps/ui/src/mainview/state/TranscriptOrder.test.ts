import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { Card } from "./AppState"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"

/*
 * §7.5: the transcript is ONE ordered list of messages and cards. Numbering a
 * message over the messages alone put every message posted after a card above
 * that card, and the ordinals persist, so the wrong order survived a reload.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const cardAt = (id: string, ordinal: number): Card => ({
  id,
  kind: "browser",
  title: id,
  status: "active",
  createdAt: Date.now(),
  ordinal,
  payload: {
    url: "https://example.com",
    finalUrl: "https://example.com",
    status: 200,
    frameable: true,
    blockReason: null
  }
})

/** The merged transcript, in the order it renders. */
const order = (store: AppStore): string[] =>
  [
    ...[...store.collections.messages.values()].map((message) => ({
      ordinal: message.ordinal,
      label: `msg:${message.text.slice(0, 12)}`
    })),
    ...[...store.collections.cards.values()].map((card) => ({
      ordinal: card.ordinal,
      label: `card:${card.id}`
    }))
  ]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((entry) => entry.label)

describe("a pending question never survives a restart", () => {
  test("an unanswered /world.delete confirm is dropped at boot, not re-asked", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    const note = [...first.collections.worldDocuments.values()][0]
    expect(note).toBeDefined()
    first.dispatch({ type: "world.delete.asked", actor: "user", id: note?.id ?? "" })
    expect(first.session().pendingWorldDeleteId).toBe(note?.id ?? "")

    // The same persisted store, opened again — the modal's overlay swallows
    // every pointer press, so re-asking makes the whole app unreachable.
    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().pendingWorldDeleteId ?? null).toBeNull()
    expect(second.collections.worldDocuments.get(note?.id ?? "")).toBeDefined()
  })
})

describe("messages and cards share one transcript counter", () => {
  test("a message posted after a card sorts below it", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    store.dispatch({ type: "message.appended", actor: "system", text: "opening digest" })
    store.dispatch({ type: "card.upsert", actor: "user", card: cardAt("reco", 1) })
    store.dispatch({ type: "card.upsert", actor: "user", card: cardAt("balance", 2) })
    store.dispatch({ type: "message.submitted", actor: "user", turnId: "turn-1", text: "reply with ping" })
    expect(order(store)).toEqual([
      "msg:opening dige",
      "card:reco",
      "card:balance",
      "msg:reply with p"
    ])
  })

  test("the ordinals themselves are ordered, so the order survives a reload", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    store.dispatch({ type: "card.upsert", actor: "user", card: cardAt("first", 0) })
    store.dispatch({ type: "message.appended", actor: "system", text: "after the card" })
    const message = [...store.collections.messages.values()][0]
    expect(message?.ordinal).toBe(1)
  })
})
