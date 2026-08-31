import {
  HarnessesResponseSchema,
  PtyCreateResponseSchema,
  PtyOutputResponseSchema,
  ReposResponseSchema
} from "smithers-shared/LocalApp"
import { hasCapability } from "smithers-shared/AppBootstrap"
import { activeRepoOf, MAIN_TAB_ID, repoKeyOf } from "../AppState"
import type { PinnedRepo, Repo, TabRow } from "../AppState"
import type { CommandResult } from "../../flows/Flows"
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
  /** `tab.read <tabId>`: another tab's recent output as text, for the agent. */
  readonly readTab: (tabId: string) => Promise<CommandResult>
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
  /** The `+` menu; with a pin key, that repository becomes the active one first (a repo row's own `+`). */
  readonly toggleTabMenu: (repoKey?: string) => Promise<string | void>
  /**
   * A sidebar repo row: the active repository, reopened first when its pin
   * is closed (a typed path where the host allows one, else the picker).
   */
  readonly selectRepo: (repoKey: string) => Promise<string | void>
  /** Forget a pinned repository; its open session and tabs stay until closed. */
  readonly unpinRepo: (repoKey: string) => string | void
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

/** How much of a tab's output `tab.read` hands the model: the last 16 KiB. */
export const TAB_READ_TAIL_BYTES = 16 * 1024

export const createTabsController = (ctx: ControllerContext): TabsController => {
  const { store, baseUrl } = ctx
  const { collections } = store

  const orderedTabs = (): Array<TabRow> =>
    [...collections.tabs.values()].sort((left, right) => left.ordinal - right.ordinal)

  const activeTab = (): TabRow | undefined => collections.tabs.get(store.session().activeTabId ?? MAIN_TAB_ID)

  const activeRepo = (): Repo | undefined => activeRepoOf(store.session(), collections.repos.values())
  /** The pin the active repository nests new tabs under (docs/LOCAL-APP.md "Tabs"). */
  const activeRepoKey = (): { readonly repoKey: string } | Record<never, never> => {
    const repo = activeRepo()
    return repo === undefined ? {} : { repoKey: repoKeyOf(repo.path) }
  }

  const cwd = (): string => activeRepo()?.path ?? HOME_CWD
  /*
   * The tab names where its process runs. A process started with no
   * repository open lands in the home directory, and a tab that hid that
   * read as "Claude Code in the repo" while the agent sat in `~`. The
   * title says which: the repository's name, or `~`.
   */
  const tabTitle = (base: string): string => `${base} · ${activeRepo()?.name ?? HOME_CWD}`
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
      tab: { id: sessionId, kind: "terminal", title: tabTitle("Terminal"), sessionId, cwd: directory, ...activeRepoKey() }
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
        title: tabTitle(harness.displayName),
        sessionId,
        harnessId: harness.id,
        cwd: directory,
        ...activeRepoKey()
      }
    })
    /*
     * The agent is a subagent of the conversation it was launched from
     * (docs/LOCAL-APP.md "Tabs"): the tab is where it runs, and this card is
     * the conversation's record of it — embedded, never a takeover — with the
     * way back to the tab. The store scopes the card to the conversation
     * that was active at the launch.
     */
    store.dispatch({
      type: "card.upsert",
      actor: "user",
      card: {
        id: `agent-${sessionId}`,
        kind: "agent",
        title: harness.displayName,
        status: "active",
        createdAt: Date.now(),
        ordinal: 0,
        payload: {
          harnessId: harness.id,
          displayName: harness.displayName,
          tabId: sessionId,
          sessionId,
          cwd: directory,
          phase: "running",
          exitCode: null
        }
      }
    })
  }

  /*
   * `tab.read` (docs/LOCAL-APP.md "Tabs"): Smithers is the first tab and can
   * read every other one. A process tab answers with the tail of its
   * scrollback from the server (`GET /api/pty/:id/output`), plain text,
   * bounded; a card tab answers with its payload; main is the conversation
   * the model is already in.
   */
  const readTab: TabsController["readTab"] = async (tabId) => {
    const tab = collections.tabs.get(tabId)
    if (tab === undefined) {
      const known = orderedTabs().map((candidate) => `${candidate.id} (${candidate.kind} "${candidate.title}")`)
      return `There is no tab with id ${tabId}. Open tabs: ${known.join(", ")}.`
    }
    if (tab.kind === "main") return { value: "That is this conversation — its transcript is already in your context." }
    if (tab.kind === "card") {
      const card = collections.cards.get(tab.cardId)
      if (card === undefined) return `The card behind tab ${tabId} is no longer in the conversation.`
      return { value: JSON.stringify({ kind: card.kind, title: card.title, status: card.status, payload: card.payload }) }
    }
    let response: Response
    try {
      response = await ctx.boundedFetch(
        `${baseUrl}/api/pty/${encodeURIComponent(tab.sessionId)}/output?tail=${TAB_READ_TAIL_BYTES}`
      )
    } catch (error) {
      return `Could not read ${tab.title}: ${error instanceof Error ? error.message : String(error)}`
    }
    if (!response.ok) {
      return `Could not read ${tab.title}: ${await ctx.errorMessageOf(response, `the server answered ${response.status}`)}`
    }
    const parsed = PtyOutputResponseSchema.safeParse(await response.json())
    if (!parsed.success) return `Could not read ${tab.title}: the server's answer had no output.`
    const header = `${tab.kind} "${tab.title}" (${parsed.data.alive ? "running" : "exited"}${
      tab.exitCode === undefined || tab.exitCode === null ? "" : `, code ${tab.exitCode}`
    }) in ${tab.cwd}${parsed.data.truncated ? " — older output not shown" : ""}`
    return { value: parsed.data.output.trim() === "" ? `${header}\n(no output yet)` : `${header}\n${parsed.data.output}` }
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
        tab: { id: `card-${cardId}`, kind: "card", title: card.title, cardId, ...activeRepoKey() }
      })
    }
    /*
     * The transcript's copy returns to its embedded form, but that is the
     * frames controller's act (AppController composes the two): minimizing
     * here by dispatch alone left the address bar at the maximized frame,
     * so a reload restored the card maximized in the transcript AND the tab.
     */
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

  const toggleTabMenu: TabsController["toggleTabMenu"] = async (repoKey) => {
    if (repoKey !== undefined) {
      const refusal = await selectRepo(repoKey)
      if (refusal !== undefined) return refusal
      if (store.session().tabMenuOpen === true) return
    }
    const open = store.session().tabMenuOpen !== true
    store.dispatch({ type: "tab.menu.toggled", actor: "user", open })
    if (open) void loadHarnesses()
  }

  const selectRepo: TabsController["selectRepo"] = async (repoKey) => {
    const pin: PinnedRepo | undefined = collections.pinnedRepos.get(repoKey)
    if (pin === undefined) return `There is no pinned repository with key ${repoKey}.`
    const open = [...collections.repos.values()].some((repo) => repoKeyOf(repo.path) === repoKey)
    if (!open) {
      // A pinned repository the server no longer holds: open it again, by path where the host allows one.
      const pathEntry = ctx.services.bootstrap !== undefined &&
        hasCapability(ctx.services.bootstrap, "local.repository-path-entry")
      const refusal = pathEntry ? await ctx.openRepo({ path: pin.path }) : await openLocalRepo()
      if (refusal !== undefined) return refusal
      if (![...collections.repos.values()].some((repo) => repoKeyOf(repo.path) === repoKey)) {
        return `${pin.name} was not reopened.`
      }
    }
    store.dispatch({ type: "repo.selected", actor: "user", id: repoKey })
  }

  const unpinRepo: TabsController["unpinRepo"] = (repoKey) => {
    if (collections.pinnedRepos.get(repoKey) === undefined) return `There is no pinned repository with key ${repoKey}.`
    store.dispatch({ type: "repo.unpinned", actor: "user", id: repoKey })
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
    readTab,
    openCardTab,
    selectTab,
    closeTab,
    confirmTabClose,
    cancelTabClose,
    toggleTabMenu,
    selectRepo,
    unpinRepo,
    openLocalRepo,
    loadHarnesses,
    loadRepos,
    notePtyExit,
    activeRepo,
    installKeyboard
  }
}
