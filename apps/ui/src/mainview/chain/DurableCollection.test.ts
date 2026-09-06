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

const observedFixture = async (initialRows: Array<z.infer<typeof Widget>>) => {
  const app = await fixture()
  await app.collection.insert(initialRows).isPersisted.promise
  const query = createLiveQueryCollection({ query: (q) => q.from({ row: app.collection }).fn.select(({ row }) => row) })
  const subscription = query.subscribeChanges(() => {})
  await query.preload()
  const rows = () => [...query.values()].map(({ id, label }) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id))
  const durableRows = async () => {
    const reopened = await openTransactionalStorage(app.host, { collections: [spec] })
    const stored = JSON.parse(reopened.storage.getItem("smithers-mvp.widgets")!) as Record<string, { data: z.infer<typeof Widget> }>
    return Object.values(stored).map(({ data }) => data).sort((a, b) => a.id.localeCompare(b.id))
  }
  const pending = (mutate: () => void) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const transaction = createTransaction({ mutationFn: async ({ transaction }) => {
      await gate
      await app.persistence.persist(transaction)
      app.collection.utils.acceptMutations(transaction)
    } })
    transaction.mutate(mutate)
    return {
      release,
      persisted: transaction.isPersisted.promise,
      confirm: async () => { release(); await transaction.isPersisted.promise }
    }
  }
  return {
    ...app,
    query,
    rows,
    durableRows,
    pending,
    dispose: async () => { subscription.unsubscribe(); await query.cleanup(); await app.collection.cleanup() }
  }
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

  test("overlapping confirmations preserve the latest query row after an unrelated transaction settles", async () => {
    const app = await fixture()
    await app.collection.insert([{ id: "one", label: "A" }, { id: "aux", label: "A" }]).isPersisted.promise
    const query = createLiveQueryCollection({
      query: (q) => q.from({ row: app.collection }).fn.select(({ row }) => row)
    })
    const subscription = query.subscribeChanges(() => {})
    await query.preload()
    const update = (label: string, key = "one") => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const transaction = createTransaction({ mutationFn: async ({ transaction }) => {
        await gate
        await app.persistence.persist(transaction)
        app.collection.utils.acceptMutations(transaction)
      } })
      transaction.mutate(() => app.collection.update(key, (draft) => { draft.label = label }))
      return async () => { release(); await transaction.isPersisted.promise }
    }
    const labels = () => [...query.values()].map(({ id, label }) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id))
    try {
      const b = update("B")
      const c = update("C")
      await b()
      const d = update("D")
      const auxiliary = update("Z", "aux")
      await c()
      await d()
      await auxiliary()
      expect(labels()).toEqual([{ id: "aux", label: "Z" }, { id: "one", label: "D" }])
      await update("E")()
      expect(labels()).toEqual([{ id: "aux", label: "Z" }, { id: "one", label: "E" }])
      const reopened = await openTransactionalStorage(app.host, { collections: [spec] })
      const rows = JSON.parse(reopened.storage.getItem("smithers-mvp.widgets")!)
      expect(rows["s:one"].data.label).toBe("E")
      expect(rows["s:aux"].data.label).toBe("Z")
    } finally {
      subscription.unsubscribe()
      await query.cleanup()
    }
  })

  test("confirmed inserts, updates and deletes preserve a newer optimistic replacement", async () => {
    const app = await observedFixture([{ id: "aux", label: "A" }])
    try {
      const inserted = app.pending(() => app.collection.insert({ id: "one", label: "B" }))
      const updated = app.pending(() => app.collection.update("one", (draft) => { draft.label = "C" }))
      await inserted.confirm()
      expect(app.query.get("one")?.label).toBe("C")
      const deleted = app.pending(() => app.collection.delete("one"))
      await updated.confirm()
      expect(app.query.has("one")).toBe(false)
      const replaced = app.pending(() => app.collection.insert({ id: "one", label: "D" }))
      const auxiliary = app.pending(() => app.collection.update("aux", (draft) => { draft.label = "Z" }))
      await deleted.confirm()
      expect(app.query.get("one")?.label).toBe("D")
      await replaced.confirm()
      await auxiliary.confirm()
      await app.pending(() => app.collection.update("one", (draft) => { draft.label = "E" })).confirm()
      expect(app.rows()).toEqual([{ id: "aux", label: "Z" }, { id: "one", label: "E" }])
      expect(await app.durableRows()).toEqual(app.rows())
    } finally {
      await app.dispose()
    }
  })

  test("a failed deletion rejects its replacement and restores the last confirmed row", async () => {
    const app = await observedFixture([{ id: "one", label: "A" }, { id: "aux", label: "A" }])
    try {
      const durable = app.pending(() => app.collection.update("one", (draft) => { draft.label = "B" }))
      const deleted = app.pending(() => app.collection.delete("one"))
      await durable.confirm()
      expect(app.query.has("one")).toBe(false)
      const replacement = app.pending(() => app.collection.insert({ id: "one", label: "D" }))
      const auxiliary = app.pending(() => app.collection.update("aux", (draft) => { draft.label = "Z" }))
      app.fail()
      const settled = Promise.allSettled([deleted.persisted, replacement.persisted, auxiliary.persisted])
      deleted.release()
      replacement.release()
      auxiliary.release()
      expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"])
      expect(app.rows()).toEqual([{ id: "aux", label: "A" }, { id: "one", label: "B" }])
      app.heal()
      expect(await app.durableRows()).toEqual(app.rows())
      await app.pending(() => app.collection.update("one", (draft) => { draft.label = "E" })).confirm()
      expect(app.rows()).toEqual([{ id: "aux", label: "A" }, { id: "one", label: "E" }])
      expect(await app.durableRows()).toEqual(app.rows())
    } finally {
      await app.dispose()
    }
  })

  test("a failed insertion and its queued update and delete restore absence before a fresh insert", async () => {
    const app = await observedFixture([{ id: "aux", label: "A" }])
    try {
      const inserted = app.pending(() => app.collection.insert({ id: "one", label: "B" }))
      const updated = app.pending(() => app.collection.update("one", (draft) => { draft.label = "C" }))
      const deleted = app.pending(() => app.collection.delete("one"))
      app.fail()
      const settled = Promise.allSettled([inserted.persisted, updated.persisted, deleted.persisted])
      inserted.release()
      updated.release()
      deleted.release()
      expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"])
      expect(app.rows()).toEqual([{ id: "aux", label: "A" }])
      app.heal()
      expect(await app.durableRows()).toEqual(app.rows())
      await app.pending(() => app.collection.insert({ id: "one", label: "E" })).confirm()
      expect(app.rows()).toEqual([{ id: "aux", label: "A" }, { id: "one", label: "E" }])
      expect(await app.durableRows()).toEqual(app.rows())
    } finally {
      await app.dispose()
    }
  })
})
