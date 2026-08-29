import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../../native/NativeBridge"
import type { FrameHistoryPort, FrameLocation } from "../../runtime/FrameHistory"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import { cardFrameId, DEFAULT_BRANCH_ID, DEFAULT_WORKSPACE_ID, rootFrameId } from "../AppState"

const storage = (): StorageApi => {
  const rows = new Map<string, string>()
  return {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => void rows.set(key, value),
    removeItem: (key) => void rows.delete(key)
  }
}

const repositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({ status: "error", code: "native-required", message: "native only" })
}

const agent: NativeAgent = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const memoryHistory = (): FrameHistoryPort & { readonly value: () => FrameLocation | undefined } => {
  const entries: FrameLocation[] = []
  let index = -1
  const listeners = new Set<(location: FrameLocation | undefined) => void>()
  const publish = (): void => {
    for (const listener of listeners) listener(entries[index])
  }
  return {
    value: () => entries[index],
    current: () => entries[index],
    replace: (location) => {
      if (index < 0) {
        entries.push(location)
        index = 0
      } else entries[index] = location
    },
    push: (location) => {
      entries.splice(index + 1)
      entries.push(location)
      index = entries.length - 1
    },
    back: () => {
      if (index > 0) index -= 1
      publish()
    },
    forward: () => {
      if (index < entries.length - 1) index += 1
      publish()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("durable frame navigation", () => {
  test("maximizes, traverses browser history, forks immutably, and restores a deep link", async () => {
    const host = storage()
    const history = memoryHistory()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    const controller = createAppController(store, repositories, agent, { frameHistory: history })
    const card = {
      id: "status-1",
      kind: "status" as const,
      title: "Status",
      status: "active" as const,
      createdAt: 1,
      ordinal: 0,
      payload: { progress: 0.5 }
    }
    await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise

    expect(history.value()).toEqual({
      workspaceId: DEFAULT_WORKSPACE_ID,
      branchId: DEFAULT_BRANCH_ID,
      frameId: rootFrameId(DEFAULT_BRANCH_ID)
    })
    controller.maximizeCard(card.id)
    await settle()
    const mainFrameId = cardFrameId(DEFAULT_BRANCH_ID, card.id)
    expect(store.session().activeFrameId).toBe(mainFrameId)
    expect(store.session().maximizedCardId).toBe(card.id)
    expect(history.value()?.frameId).toBe(mainFrameId)

    controller.frameBack()
    await settle()
    expect(store.session().activeFrameId).toBe(rootFrameId(DEFAULT_BRANCH_ID))
    expect(store.session().maximizedCardId).toBeNull()
    controller.frameForward()
    await settle()
    expect(store.session().activeFrameId).toBe(mainFrameId)

    const original = structuredClone(store.collections.frames.get(mainFrameId))
    controller.forkFrame()
    await settle()
    const forkLocation = history.value()
    expect(forkLocation?.branchId).not.toBe(DEFAULT_BRANCH_ID)
    expect(store.collections.branches.get(forkLocation!.branchId)).toMatchObject({
      parentBranchId: DEFAULT_BRANCH_ID,
      forkedFromFrameId: mainFrameId,
      forkedAtRevision: original?.stateRevision
    })
    expect(store.collections.frames.get(mainFrameId)).toEqual(original)
    expect(store.session().activeFrameId).toBe(forkLocation?.frameId)

    controller.dispose()
    const restored = await createAppStore({ kind: "localStorage", storage: host })
    // Simulate the durable store restoring at root while the address bar keeps
    // the forked frame; controller boot must choose the valid deep link.
    await restored.dispatch({ type: "card.minimized", actor: "user" }).isPersisted.promise
    const restoredController = createAppController(restored, repositories, agent, { frameHistory: history })
    await settle()
    expect(restored.session().activeBranchId).toBe(forkLocation?.branchId)
    expect(restored.session().activeFrameId).toBe(forkLocation?.frameId)
    expect(restored.session().maximizedCardId).toBe(card.id)
    restoredController.dispose()
  })
})
