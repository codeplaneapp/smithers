import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { Card } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"

/*
 * The tabs collection's transitions (docs/LOCAL-APP.md "Tabs"): main is
 * seeded and permanent, opened tabs take the next place and become active,
 * closing the active tab falls back to the tab on its left, a card tab's
 * close keeps the card, a PTY exit marks the tab, and boot reconciliation
 * drops the process tabs whose server is gone.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const boot = (storage = memoryStorage()): Promise<AppStore> => createAppStore({ kind: "localStorage", storage })

const persisted = async (store: AppStore, transition: Parameters<AppStore["dispatch"]>[0]): Promise<void> => {
  await store.dispatch(transition).isPersisted.promise
}

const tabIds = (store: AppStore): Array<string> =>
  [...store.collections.tabs.values()].sort((left, right) => left.ordinal - right.ordinal).map((tab) => tab.id)

const themeCard: Card = {
  id: "theme-picker",
  kind: "theme-picker",
  title: "Color themes",
  status: "active",
  createdAt: 1,
  ordinal: 0,
  payload: { selected: "night-owl" }
}

describe("the tabs collection", () => {
  test("boots with the permanent main tab selected", async () => {
    const store = await boot()
    expect(tabIds(store)).toEqual(["main"])
    expect(store.collections.tabs.get("main")).toMatchObject({ kind: "main", title: "Smithers", ordinal: 0 })
    expect(store.session().activeTabId).toBe("main")
    expect(store.session().tabMenuOpen).toBe(false)
    expect(store.session().pendingTabCloseId).toBeNull()
  })

  test("opening tabs appends them in creation order and activates the newest", async () => {
    const store = await boot()
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "tab-a", kind: "terminal", title: "Terminal", sessionId: "a", cwd: "~" }
    })
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "tab-b", kind: "harness", title: "Claude Code", sessionId: "b", harnessId: "claude", cwd: "~" }
    })
    expect(tabIds(store)).toEqual(["main", "tab-a", "tab-b"])
    expect(store.session().activeTabId).toBe("tab-b")
    // Opening closes the + menu; a duplicate id is ignored; main is never re-inserted.
    await persisted(store, { type: "tab.menu.toggled", actor: "user", open: true })
    expect(store.session().tabMenuOpen).toBe(true)
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "tab-a", kind: "terminal", title: "Terminal", sessionId: "a2", cwd: "~" }
    })
    expect(store.collections.tabs.get("tab-a")).toMatchObject({ sessionId: "a" })
    await persisted(store, { type: "tab.opened", actor: "user", tab: { id: "main", kind: "main", title: "Smithers" } })
    expect(tabIds(store)).toEqual(["main", "tab-a", "tab-b"])
    expect(store.session().tabMenuOpen).toBe(true)
  })

  test("selecting names an existing tab; an unknown id changes nothing", async () => {
    const store = await boot()
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "tab-a", kind: "terminal", title: "Terminal", sessionId: "a", cwd: "~" }
    })
    await persisted(store, { type: "tab.selected", actor: "user", id: "main" })
    expect(store.session().activeTabId).toBe("main")
    await persisted(store, { type: "tab.selected", actor: "user", id: "tab-zzz" })
    expect(store.session().activeTabId).toBe("main")
    await persisted(store, { type: "tab.selected", actor: "user", id: "tab-a" })
    expect(store.session().activeTabId).toBe("tab-a")
  })

  test("closing the active tab selects the tab to its left; main never closes", async () => {
    const store = await boot()
    for (const id of ["a", "b", "c"]) {
      await persisted(store, {
        type: "tab.opened",
        actor: "user",
        tab: { id: `tab-${id}`, kind: "terminal", title: "Terminal", sessionId: id, cwd: "~" }
      })
    }
    await persisted(store, { type: "tab.selected", actor: "user", id: "tab-b" })
    await persisted(store, { type: "tab.closed", actor: "user", id: "tab-b" })
    expect(tabIds(store)).toEqual(["main", "tab-a", "tab-c"])
    expect(store.session().activeTabId).toBe("tab-a")
    // Closing an inactive tab leaves the selection alone.
    await persisted(store, { type: "tab.closed", actor: "user", id: "tab-c" })
    expect(store.session().activeTabId).toBe("tab-a")
    await persisted(store, { type: "tab.closed", actor: "user", id: "tab-a" })
    expect(store.session().activeTabId).toBe("main")
    await persisted(store, { type: "tab.closed", actor: "user", id: "main" })
    expect(tabIds(store)).toEqual(["main"])
  })

  test("the close question is session state and clears with the tab", async () => {
    const store = await boot()
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "tab-a", kind: "terminal", title: "Terminal", sessionId: "a", cwd: "~" }
    })
    // Main and unknown tabs cannot be asked about.
    await persisted(store, { type: "tab.close.asked", actor: "user", id: "main" })
    expect(store.session().pendingTabCloseId).toBeNull()
    await persisted(store, { type: "tab.close.asked", actor: "user", id: "tab-a" })
    expect(store.session().pendingTabCloseId).toBe("tab-a")
    await persisted(store, { type: "tab.close.asked", actor: "user", id: null })
    expect(store.session().pendingTabCloseId).toBeNull()
    await persisted(store, { type: "tab.close.asked", actor: "user", id: "tab-a" })
    await persisted(store, { type: "tab.closed", actor: "user", id: "tab-a" })
    expect(store.session().pendingTabCloseId).toBeNull()
  })

  test("a PTY exit marks every tab on that session", async () => {
    const store = await boot()
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "tab-a", kind: "terminal", title: "Terminal", sessionId: "a", cwd: "~" }
    })
    expect(store.collections.tabs.get("tab-a")).not.toHaveProperty("exitCode")
    await persisted(store, { type: "pty.exited", actor: "system", sessionId: "a", code: 0 })
    expect(store.collections.tabs.get("tab-a")).toMatchObject({ exitCode: 0 })
    await persisted(store, { type: "pty.exited", actor: "system", sessionId: "other", code: 1 })
    expect(store.collections.tabs.get("tab-a")).toMatchObject({ exitCode: 0 })
  })

  test("closing a card tab keeps the card in the transcript", async () => {
    const store = await boot()
    await persisted(store, { type: "card.upsert", actor: "user", card: themeCard })
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "tab-card-theme-picker", kind: "card", title: "Color themes", cardId: "theme-picker" }
    })
    expect(store.session().activeTabId).toBe("tab-card-theme-picker")
    await persisted(store, { type: "tab.closed", actor: "user", id: "tab-card-theme-picker" })
    expect(tabIds(store)).toEqual(["main"])
    expect(store.collections.cards.get("theme-picker")).toBeDefined()
  })

  test("harnesses and repos replace their collections wholesale", async () => {
    const store = await boot()
    await persisted(store, {
      type: "harnesses.loaded",
      actor: "system",
      harnesses: [
        {
          id: "claude",
          displayName: "Claude Code",
          binary: "/usr/local/bin/claude",
          version: "2.0.0",
          status: "signed-in",
          account: { email: "will@codeplane.app" },
          launch: { argv: ["claude"] }
        }
      ]
    })
    expect([...store.collections.harnesses.keys()]).toEqual(["claude"])
    // A re-load (the `+` menu opening after boot) carries the same ids again: replaced in place, never duplicated or dropped.
    await persisted(store, {
      type: "harnesses.loaded",
      actor: "system",
      harnesses: [
        {
          id: "claude",
          displayName: "Claude Code",
          binary: "/usr/local/bin/claude",
          version: "2.1.0",
          status: "signed-in",
          account: { email: "will@codeplane.app" },
          launch: { argv: ["claude"] }
        },
        {
          id: "codex",
          displayName: "Codex",
          binary: null,
          version: null,
          status: "unavailable",
          account: null,
          launch: { argv: ["codex"] }
        }
      ]
    })
    expect([...store.collections.harnesses.keys()].sort()).toEqual(["claude", "codex"])
    expect(store.collections.harnesses.get("claude")).toMatchObject({ version: "2.1.0" })
    await persisted(store, { type: "harnesses.loaded", actor: "system", harnesses: [] })
    expect(store.collections.harnesses.size).toBe(0)
    await persisted(store, {
      type: "repos.loaded",
      actor: "system",
      repos: [
        {
          id: "force",
          path: "/tmp/force",
          name: "artsy/force",
          git: null,
          smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "no WORKSPACE.ts", workspaces: [] },
          warnings: []
        }
      ]
    })
    expect(store.collections.repos.get("force")).toMatchObject({ name: "artsy/force" })
  })

  test("boot drops process tabs and orphaned card tabs, and returns to main", async () => {
    const storage = memoryStorage()
    const first = await boot(storage)
    await persisted(first, { type: "card.upsert", actor: "user", card: themeCard })
    await persisted(first, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "tab-a", kind: "terminal", title: "Terminal", sessionId: "a", cwd: "~" }
    })
    await persisted(first, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "tab-card-theme-picker", kind: "card", title: "Color themes", cardId: "theme-picker" }
    })
    await persisted(first, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "tab-card-gone", kind: "card", title: "Gone", cardId: "no-such-card" }
    })
    await persisted(first, { type: "tab.menu.toggled", actor: "user", open: true })
    await persisted(first, { type: "tab.close.asked", actor: "user", id: "tab-a" })
    expect(first.session().activeTabId).toBe("tab-card-gone")

    const second = await boot(storage)
    expect(tabIds(second)).toEqual(["main", "tab-card-theme-picker"])
    // The dead active tab closed like any other: the tab to its left takes over.
    expect(second.session().activeTabId).toBe("tab-card-theme-picker")
    expect(second.session().tabMenuOpen).toBe(false)
    expect(second.session().pendingTabCloseId).toBeNull()
    // Every reconciliation is journaled with the system actor.
    const journal = [...second.collections.transitions.values()]
    expect(journal.filter((record) => record.type === "tab.closed" && record.actor === "system")).toHaveLength(2)
  })
})
