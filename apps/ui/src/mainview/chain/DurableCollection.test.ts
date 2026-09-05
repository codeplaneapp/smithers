import { createCollection, createLiveQueryCollection, createTransaction } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { createCollectionPersistence, durableCollectionOptions } from "./DurableCollection"
import { ENVELOPE_STORAGE_KEY, openTransactionalStorage } from "./TransactionalStorage"

const Widget = z.object({ id: z.string(), label: z.string() })
const spec = { id: "widgets", schema: Widget, getKey: (row: z.infer<typeof Widget>) => row.id }

const fixture = async () => {
  const values = new Map<string, string>()
  let failing = false
  const host = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failing && key === ENVELOPE_STORAGE_KEY) throw new Error("commit refused")
      values.set(key, value)
    },
    removeItem: (key: string) => { values.delete(key) }
  }
  const storage = await openTransactionalStorage(host, { collections: [spec] })
  const persistence = createCollectionPersistence({ storage: storage.storage, batch: storage })
  const collection = createCollection(durableCollectionOptions(persistence, spec))
  await collection.preload()
  return { collection, storage, persistence, host, fail: () => { failing = true }, heal: () => { failing = false } }
}

describe("durable local-only collection adapter", () => {
  test("rows adopted from the historical unprefixed-key layout remain editable", async () => {
    const app = await fixture()
    app.storage.storage.setItem("smithers-mvp.widgets", JSON.stringify({ one: { versionKey: "legacy", data: { id: "one", label: "old" } } }))
    const collection = createCollection(durableCollectionOptions(app.persistence, spec))
    await collection.preload()
    await collection.update("one", (draft) => { draft.label = "updated" }).isPersisted.promise
    expect(JSON.parse(app.storage.storage.getItem("smithers-mvp.widgets")!)).toMatchObject({ "s:one": { data: { id: "one", label: "updated" } } })
  })
  test("direct inserts, updates and deletes confirm only after successful persistence", async () => {
    const app = await fixture()
    await app.collection.insert({ id: "one", label: "before" }).isPersisted.promise
    app.fail()
    await expect(app.collection.update("one", (draft) => { draft.label = "failed" }).isPersisted.promise).rejects.toThrow("commit refused")
    expect(app.collection.get("one")?.label).toBe("before")
    await expect(app.collection.delete("one").isPersisted.promise).rejects.toThrow("commit refused")
    expect(app.collection.get("one")?.label).toBe("before")
    app.heal()
    await app.collection.insert({ id: "two", label: "kept" }).isPersisted.promise
    const reopened = await openTransactionalStorage(app.host, { collections: [spec] })
    const rows = JSON.parse(reopened.storage.getItem("smithers-mvp.widgets")!)
    expect(rows["s:one"].data.label).toBe("before")
    expect(rows["s:two"].data.label).toBe("kept")
    await app.collection.delete("one").isPersisted.promise
    expect(JSON.parse(app.storage.storage.getItem("smithers-mvp.widgets")!)["s:one"]).toBeUndefined()
  })

  test("a query subscribed during pending persistence retains stable local metadata through settlement and another update", async () => {
    const app = await fixture()
    await app.collection.insert({ id: "one", label: "before" }).isPersisted.promise
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const blocked = new Promise<void>((resolve) => { entered = resolve })
    let pause = true
    const persistence = createCollectionPersistence({
      storage: app.storage.storage,
      batch: app.storage,
      flush: async () => {
        if (pause) { pause = false; entered(); await gate }
      }
    })
    const widgets = createCollection(durableCollectionOptions(persistence, spec))
    await widgets.preload()
    const first = widgets.update("one", (draft) => { draft.label = "pending" })
    await blocked
    const query = createLiveQueryCollection({
      query: (q) => q.from({ widgets }).select(({ widgets }) => ({ id: widgets.id, label: widgets.label, synced: widgets.$synced, origin: widgets.$origin }))
    })
    const subscription = query.subscribeChanges(() => {})
    await query.preload()
    const projection = () => [...query.values()].map(({ id, label, synced, origin }) => ({ id, label, synced, origin }))
    expect(projection()).toEqual([{ id: "one", label: "pending", synced: true, origin: "local" }])
    release()
    await first.isPersisted.promise
    await widgets.update("one", (draft) => { draft.label = "next" }).isPersisted.promise
    expect(projection()).toEqual([{ id: "one", label: "next", synced: true, origin: "local" }])
    subscription.unsubscribe()
    await query.cleanup()
  })

  test("queued transitions derived from a failed optimistic state reject before writing", async () => {
    const app = await fixture()
    await app.collection.insert({ id: "one", label: "before" }).isPersisted.promise
    const mutate = (label: string) => {
      const transaction = createTransaction({ mutationFn: async ({ transaction }) => {
        await app.persistence.persist(transaction)
        app.collection.utils.acceptMutations(transaction)
      } })
      transaction.mutate(() => app.collection.update("one", (draft) => { draft.label = label }))
      return transaction.isPersisted.promise
    }
    app.fail()
    const results = await Promise.allSettled([mutate("failed-first"), mutate("failed-dependent")])
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"])
    expect(app.collection.get("one")?.label).toBe("before")
    app.heal()
    await mutate("fresh")
    expect(app.collection.get("one")?.label).toBe("fresh")
    expect(JSON.parse(app.storage.storage.getItem("smithers-mvp.widgets")!)["s:one"].data.label).toBe("fresh")
  })
})
