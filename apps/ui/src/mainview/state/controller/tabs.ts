import { HarnessesResponseSchema, PtyCreateResponseSchema, ReposResponseSchema } from "smithers-shared/LocalApp"
import { hasCapability } from "smithers-shared/AppBootstrap"
import { MAIN_TAB_ID } from "../AppState"
import type { Repo, TabRow } from "../AppState"
import type { ControllerContext } from "./context"

/*
 * The local-app tabs (docs/LOCAL-APP.md "Tabs"): opening a terminal, a
 * harness, or a card in a tab; selecting and closing tabs; the `+` menu; and
 * the repository chip's data. Every state change goes through the store's
 * dispatcher with the actor recorded; the server is reached only for what
 * it owns (PTY sessions, the harness list, the repository list).
 */

export interface TabsController {
  /** Cmd+T / the `+` menu's Terminal row: `POST /api/pty` then a terminal tab. */
  readonly openTerminalTab: () => Promise<string | void>
  /** A `+` menu harness row: `POST /api/pty { kind: "harness", harnessId }` then a harness tab. */
  readonly openHarnessTab: (harnessId: string) => Promise<string | void>
  /** A maximized card's "Open in tab": one tab per card, rendering the same store record. */
  readonly openCardTab: (cardId: string) => string | void
  /** A tab id, or a 1-based position (Cmd+1..9; 1 is always main). */
  readonly selectTab: (target: string) => string | void
  /**
   * Close a tab (the active one when unnamed). A tab whose process is still
   * alive asks first; the answer is tab.close.confirm / tab.close.cancel.
   * Main never closes and never complains.
   */
  readonly closeTab: (tabId?: string) => Promise<string | void>
  readonly confirmTabClose: () => Promise<string | void>
  readonly cancelTabClose: () => void
  readonly toggleTabMenu: () => void
  /** The chrome's "Open repository": the native picker when there is one, else a typed path. */
  readonly openLocalRepo: () => Promise<string | void>
  readonly loadHarnesses: () => Promise<void>
  readonly loadRepos: () => Promise<void>
  /** A `pty.exit` frame reached a tab: record the code so closing no longer asks. */
  readonly notePtyExit: (sessionId: string, code: number | null) => void
  /** The repository new terminals start in; undefined means the server's home directory. */
  readonly activeRepo: () => Repo | undefined
  /** The Cmd+T / Cmd+W / Cmd+1..9 bindings on one document; returns the uninstaller. */
  readonly installKeyboard: (target: Pick<Document, "addEventListener" | "removeEventListener">) => () => void
}

const isProcessTab = (tab: TabRow | undefined): tab is Extract<TabRow, { kind: "terminal" | "harness" }> =>
  tab?.kind === "terminal" || tab?.kind === "harness"

/** The home directory is the server's to expand; the SPA never knows it. */
const HOME_CWD = "~"

/** The emulator's geometry before the first fit; the resize seam corrects it. */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

export const createTabsController = (ctx: ControllerContext): TabsController => {
  const { store, baseUrl } = ctx
  const { collections } = store

  const orderedTabs = (): Array<TabRow> =>
    [...collections.tabs.values()].sort((left, right) => left.ordinal - right.ordinal)

  const activeTab = (): TabRow | undefined => collections.tabs.get(store.session().activeTabId ?? MAIN_TAB_ID)

  const activeRepo = (): Repo | undefined => [...collections.repos.values()][0]

  const cwd = (): string => activeRepo()?.path ?? HOME_CWD
  const sessionRepository = (): { readonly repoId: string } | Record<never, never> => {
    const repo = activeRepo()
    return repo === undefined ? {} : { repoId: repo.id }
  }

  const createSession = async (body: Record<string, unknown>): Promise<string> => {
    const response = await ctx.boundedFetch(`${baseUrl}/api/pty`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
    if (!response.ok) throw new Error(await ctx.errorMessageOf(response, `The server answered ${response.status}`))
    const parsed = PtyCreateResponseSchema.safeParse(await response.json())
    if (!parsed.success) throw new Error("The server's answer carried no session id")
    return parsed.data.sessionId
  }

  const openTerminalTab: TabsController["openTerminalTab"] = async () => {
    let sessionId: string
    const directory = cwd()
    try {
      sessionId = await createSession({ kind: "terminal", ...sessionRepository(), cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
    } catch (error) {
      return `Could not start a terminal: ${error instanceof Error ? error.message : String(error)}`
    }
    store.dispatch({
      type: "tab.opened",
      actor: "user",
      // The session id is the tab id: unique per process, and `tab-<id>` stays a readable test id.
      tab: { id: sessionId, kind: "terminal", title: "Terminal", sessionId, cwd: directory }
    })
  }

  const openHarnessTab: TabsController["openHarnessTab"] = async (harnessId) => {
    if (collections.harnesses.size === 0) await loadHarnesses()
    const harness = [...collections.harnesses.values()].find((candidate) => candidate.id === harnessId)
    if (harness === undefined) return `There is no harness with id ${harnessId}.`
    if (harness.status === "unavailable") return `${harness.displayName} is not installed here.`
    let sessionId: string
    const directory = cwd()
    try {
      sessionId = await createSession({
        kind: "harness",
        ...sessionRepository(),
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        harnessId: harness.id
      })
    } catch (error) {
      return `Could not start ${harness.displayName}: ${error instanceof Error ? error.message : String(error)}`
    }
    store.dispatch({
      type: "tab.opened",
      actor: "user",
      tab: {
        id: sessionId,
        kind: "harness",
        title: harness.displayName,
        sessionId,
        harnessId: harness.id,
        cwd: directory
      }
    })
  }

  const openCardTab: TabsController["openCardTab"] = (cardId) => {
    const card = collections.cards.get(cardId)
    if (card === undefined) return `There is no card with id ${cardId}.`
    const existing = orderedTabs().find((tab) => tab.kind === "card" && tab.cardId === cardId)
    if (existing !== undefined) {
      store.dispatch({ type: "tab.selected", actor: "user", id: existing.id })
    } else {
      store.dispatch({
        type: "tab.opened",
        actor: "user",
        tab: { id: `card-${cardId}`, kind: "card", title: card.title, cardId }
      })
    }
    // The tab now shows the card; the transcript's copy returns to its embedded form.
    if (store.session().maximizedCardId === cardId) store.dispatch({ type: "card.minimized", actor: "user" })
  }

  const selectTab: TabsController["selectTab"] = (target) => {
    const position = /^[1-9]$/.test(target) ? Number(target) : undefined
    const tab = position === undefined
      ? collections.tabs.get(target)
      : orderedTabs()[position - 1]
    if (tab === undefined) {
      // A position past the strip is a no-op keystroke, not an error.
      return position === undefined ? `There is no tab with id ${target}.` : undefined
    }
    store.dispatch({ type: "tab.selected", actor: "user", id: tab.id })
  }

  const endSession = async (tab: TabRow): Promise<void> => {
    if (!isProcessTab(tab)) return
    // An exited session is still listed on the server until deleted, so the
    // DELETE goes out either way; a 404 for one the server already dropped is fine.
    try {
      await ctx.boundedFetch(`${baseUrl}/api/pty/${encodeURIComponent(tab.sessionId)}`, { method: "DELETE" })
    } catch {
      // The tab closes either way.
    }
  }

  const finishClose = async (tab: TabRow): Promise<void> => {
    await endSession(tab)
    store.dispatch({ type: "tab.closed", actor: "user", id: tab.id })
  }

  const closeTab: TabsController["closeTab"] = async (tabId) => {
    const tab = tabId === undefined ? activeTab() : collections.tabs.get(tabId)
    if (tab === undefined) return tabId === undefined ? undefined : `There is no tab with id ${tabId}.`
    if (tab.kind === "main") return
    if (isProcessTab(tab) && tab.exitCode === undefined) {
      store.dispatch({ type: "tab.close.asked", actor: "user", id: tab.id })
      return
    }
    await finishClose(tab)
  }

  const confirmTabClose: TabsController["confirmTabClose"] = async () => {
    const pending = store.session().pendingTabCloseId
    if (pending === undefined || pending === null) return
    const tab = collections.tabs.get(pending)
    if (tab === undefined) {
      store.dispatch({ type: "tab.close.asked", actor: "user", id: null })
      return
    }
    await finishClose(tab)
  }

  const cancelTabClose: TabsController["cancelTabClose"] = () => {
    store.dispatch({ type: "tab.close.asked", actor: "user", id: null })
  }

  const loadHarnesses: TabsController["loadHarnesses"] = async () => {
    try {
      const response = await ctx.boundedFetch(`${baseUrl}/api/harnesses`)
      if (!response.ok) return
      const parsed = HarnessesResponseSchema.safeParse(await response.json())
      if (!parsed.success) return
      store.dispatch({ type: "harnesses.loaded", actor: "system", harnesses: parsed.data.harnesses })
    } catch {
      // No server behind /api/harnesses (pure web, a test) leaves the menu with Terminal alone.
    }
  }

  const loadRepos: TabsController["loadRepos"] = async () => {
    try {
      const response = await ctx.boundedFetch(`${baseUrl}/api/repos`)
      if (!response.ok) return
      const parsed = ReposResponseSchema.safeParse(await response.json())
      if (!parsed.success) return
      store.dispatch({ type: "repos.loaded", actor: "system", repos: parsed.data.repos })
    } catch {
      // Same as the harnesses: an absent seam means no repository, not a failure.
    }
  }

  const toggleTabMenu: TabsController["toggleTabMenu"] = () => {
    const open = store.session().tabMenuOpen !== true
    store.dispatch({ type: "tab.menu.toggled", actor: "user", open })
    if (open) void loadHarnesses()
  }

  const openLocalRepo: TabsController["openLocalRepo"] = async () => {
    if (ctx.repositories.available) {
      store.dispatch({ type: "connector.local.requested", actor: "user", access: "read-write" })
      try {
        const result = await ctx.repositories.pickLocalRepository("read-write")
        if (result.status === "cancelled") {
          store.dispatch({ type: "connector.local.cancelled", actor: "user" })
          return
        }
        if (result.status === "error") {
          store.dispatch({ type: "connector.local.failed", actor: "system", message: result.message })
          return result.message
        }
        const { authorizationId, ...repository } = result.repository
        store.dispatch({
          type: "connector.local.connected",
          actor: "system",
          access: "read-write",
          repository
        })
        return ctx.openRepo({ authorizationId, displayName: repository.name })
      } catch {
        const message = "The native repository picker stopped responding. Try again."
        store.dispatch({ type: "connector.local.failed", actor: "system", message })
        return message
      }
    }
    if (ctx.services.bootstrap === undefined || !hasCapability(ctx.services.bootstrap, "local.repository-path-entry")) {
      return "Opening a repository needs the Smithers native app."
    }
    if (typeof window === "undefined" || typeof window.prompt !== "function") {
      return "Opening a repository needs the Smithers app."
    }
    const path = (window.prompt("Repository path") ?? "").trim()
    if (path === "") return
    return ctx.openRepo({ path })
  }

  const notePtyExit: TabsController["notePtyExit"] = (sessionId, code) => {
    store.dispatch({ type: "pty.exited", actor: "system", sessionId, code })
  }

  /*
   * Cmd+T, Cmd+W, Cmd+1..9 (docs/LOCAL-APP.md "Keyboard"). The capture phase
   * so a focused terminal (whose emulator handles keydown itself) still
   * yields the chrome's shortcuts; Meta alone, because Ctrl+T/Ctrl+W are
   * keystrokes a shell owns.
   */
  const installKeyboard: TabsController["installKeyboard"] = (target) => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      const name = key === "t" ? "tab.terminal" : key === "w" ? "tab.close" : /^[1-9]$/.test(key) ? "tab.select" : undefined
      if (name === undefined) return
      event.preventDefault()
      event.stopPropagation()
      void ctx.commands.run(name, name === "tab.select" ? key : undefined)
    }
    target.addEventListener("keydown", onKeyDown, true)
    return () => target.removeEventListener("keydown", onKeyDown, true)
  }

  return {
    openTerminalTab,
    openHarnessTab,
    openCardTab,
    selectTab,
    closeTab,
    confirmTabClose,
    cancelTabClose,
    toggleTabMenu,
    openLocalRepo,
    loadHarnesses,
    loadRepos,
    notePtyExit,
    activeRepo,
    installKeyboard
  }
}
