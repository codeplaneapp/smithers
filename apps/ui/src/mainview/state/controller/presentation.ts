import { TOOLS_BROWSER_FETCH_PATH } from "smithers-shared/AgentApiRoutes"
import { foldLineages } from "../../chain/DebugFolds"
import { DEFAULT_PALETTE, isPalette, PALETTES, WORLD_DISPLAY_NAME } from "../AppState"
import type { Card, Palette } from "../AppState"
import { THEME_PICKER_CARD_ID } from "../AppStore"
import type { ControllerContext } from "./context"

export interface PresentationController {
  readonly showChat: () => void
  readonly showWorld: () => void
  readonly showConnectors: () => void
  readonly maximizeCard: (id: string) => string | void
  readonly minimizeCard: () => void
  readonly toggleDevtools: () => void
  readonly toggleSurfacesMenu: () => void
  readonly toggleConnectMenu: () => void
  readonly closeConnectMenu: () => void
  readonly describeAgentBackend: (backend: string) => string | { readonly value: string }
  readonly debugSnapshot: () => { readonly value: string }
  readonly debugEvents: () => { readonly value: string }
  readonly debugChain: () => { readonly value: string }
  readonly netTap: () => string
  readonly debugNet: () => { readonly value: string }
  readonly resetGrants: () => Promise<string | { readonly value: string }>
  readonly debugSeams: () => Promise<string | void | { readonly value: string }>
  readonly openBrowser: (url: string) => Promise<string | void | { readonly value: string }>
  readonly toggleTheme: () => void
  readonly setPalette: (args: string) => string | void
}

export const createPresentationController = (
  ctx: ControllerContext,
  adminHealth: () => Promise<string | void>
): PresentationController => {
  const showChat = (): void => {
    ctx.store.dispatch({ type: "surface.changed", actor: ctx.commandActor, surface: "chat" })
  }

  /*
   * Toggles toggle (§2c): invoking the command for the currently-open pane
   * returns to the chat. And THE EMBED LAW's in-app half (§2c″): the AGENT's
   * invocation renders an embedded card in the transcript instead — a
   * surface-maximizing takeover is structurally unavailable to the model.
   */
  const showWorld = (): void => {
    if (ctx.commandActor === "smithers") {
      const snapshot = ctx.store.worldStateSnapshot()
      let highest = -1
      for (const message of ctx.store.collections.messages.values()) highest = Math.max(highest, message.ordinal)
      for (const card of ctx.store.collections.cards.values()) highest = Math.max(highest, card.ordinal)
      const card: Card = {
        id: "world-embedded",
        kind: "world",
        title: WORLD_DISPLAY_NAME,
        status: "active",
        createdAt: Date.now(),
        ordinal: highest + 1,
        payload: {
          documents: snapshot.documents.map((document) => ({
            path: document.path,
            title: document.title,
            confidence: document.confidence
          }))
        }
      }
      ctx.store.dispatch({ type: "card.upsert", actor: "smithers", card })
      return
    }
    ctx.store.dispatch({
      type: "surface.changed",
      actor: "user",
      surface: ctx.store.session().surface === "world" ? "chat" : "world"
    })
  }

  const showConnectors = (): void => {
    if (ctx.commandActor === "smithers") {
      const identity = ctx.store.collections.identitySessions.get("identity")
      let highest = -1
      for (const message of ctx.store.collections.messages.values()) highest = Math.max(highest, message.ordinal)
      for (const card of ctx.store.collections.cards.values()) highest = Math.max(highest, card.ordinal)
      const card: Card = {
        id: "connect-embedded",
        kind: "connect",
        title: "Connect work to Smithers",
        status: "active",
        createdAt: Date.now(),
        ordinal: highest + 1,
        payload: {
          github: {
            connected: identity?.state === "signed-in",
            login: identity?.login ?? null
          },
          nativeAvailable: ctx.repositories.available
        }
      }
      ctx.store.dispatch({ type: "card.upsert", actor: "smithers", card })
      return
    }
    ctx.store.dispatch({
      type: "surface.changed",
      actor: "user",
      surface: ctx.store.session().surface === "connectors" ? "chat" : "connectors"
    })
  }

  const maximizeCard = (id: string): string | void => {
    if (ctx.store.collections.cards.get(id) === undefined) return `There is no card with id ${id}.`
    ctx.store.dispatch({ type: "card.maximized", actor: "user", id })
  }

  const minimizeCard = (): void => {
    ctx.store.dispatch({ type: "card.minimized", actor: "user" })
  }

  const toggleDevtools = (): void => {
    // The command registers only for admins; the guard keeps the state
    // honest even if a stale binding fires in a non-admin session.
    const identity = ctx.store.collections.identitySessions.get("identity")
    if (identity?.state !== "signed-in" || !identity.admin) return
    ctx.store.dispatch({ type: "devtools.toggled", actor: "user", open: !ctx.store.session().devtoolsOpen })
  }

  const toggleSurfacesMenu = (): void => {
    ctx.store.dispatch({
      type: "surfaces-menu.toggled",
      actor: "user",
      open: !ctx.store.session().surfacesMenuOpen
    })
  }

  const toggleConnectMenu = (): void => {
    ctx.store.dispatch({
      type: "connect-menu.toggled",
      actor: "user",
      open: ctx.store.session().connectMenuOpen !== true
    })
  }

  /*
   * Escape, an outside press, and picking an entry all CLOSE — they are not
   * toggles, and dispatching one against an already-closed menu would write a
   * transition that changed nothing into the journal.
   */
  const closeConnectMenu = (): void => {
    if (ctx.store.session().connectMenuOpen !== true) return
    ctx.store.dispatch({ type: "connect-menu.toggled", actor: "user", open: false })
  }

  /*
   * The one backend, named once. `/debug.backend` reports it and the manual
   * checklist quotes it, so drift between what runs and what is claimed shows
   * up as a failing row rather than as a confident wrong sentence.
   */
  const AGENT_BACKEND = "chain (in-browser Agent Chain over /api/model/stream)"

  /*
   * DESIGN.md §14: what drives a turn. A read, not a switch — Smithers has one
   * backend, so there is nothing here to flip and an argument is answered
   * honestly rather than silently ignored.
   */
  const describeAgentBackend = (backend: string): string | { readonly value: string } => {
    const asked = backend.trim()
    if (asked !== "") {
      return `there is one backend and it cannot be switched: ${AGENT_BACKEND}`
    }
    const value = `agent backend: ${AGENT_BACKEND}`
    // A backend answer the human cannot see is a backend they cannot trust.
    if (ctx.commandActor !== "smithers") {
      ctx.store.dispatch({ type: "message.appended", actor: "system", text: value })
    }
    return { value }
  }

  /*
   * The debug reads (§2d): one typed surface the dev-tools panel renders and
   * the agent invokes to answer "what is happening" for admin sessions.
   */
  /*
   * A debug read the HUMAN asked for renders in the transcript.
   *
   * `{ value }` is the agent boundary's channel and never renders on its own
   * (§2b), so a read whose only answer is a value is a silent no-op for the
   * person who typed it. `debug.seams` already showed the shape: surface
   * first, return the value second. These four now do the same. The agent's
   * own invocation still renders nothing — it reads the value in its tool
   * result, and pasting the payload into the chat as well would be noise.
   */
  const DEBUG_READ_LIMIT = 4000
  const surfaceDebugRead = (title: string, payload: string): { readonly value: string } => {
    if (ctx.commandActor !== "smithers") {
      const shown = payload.length <= DEBUG_READ_LIMIT
        ? payload
        : `${
          payload.slice(0, DEBUG_READ_LIMIT)
        }\n\n… truncated at ${DEBUG_READ_LIMIT} of ${payload.length} characters. The dev-tools panel (/admin.devtools) holds the whole read.`
      ctx.store.dispatch({
        type: "message.appended",
        actor: "system",
        text: `${title}\n\n\`\`\`json\n${shown}\n\`\`\``
      })
    }
    return { value: payload }
  }

  const debugSnapshot = (): { readonly value: string } => {
    const identity = ctx.store.collections.identitySessions.get("identity")
    const billing = ctx.store.collections.billingAccounts.get("billing")
    const watched = ctx.store.collections.watchedRepos.get("watched")
    return surfaceDebugRead(
      "App state snapshot",
      JSON.stringify({
        surface: ctx.store.session().surface,
        phase: ctx.store.session().phase,
        revision: ctx.store.session().revision,
        messages: ctx.store.collections.messages.size,
        cards: [...ctx.store.collections.cards.values()].map((card) => `${card.kind}:${card.status}`),
        worldDocuments: ctx.store.collections.worldDocuments.size,
        identity: identity === undefined
          ? null
          : { state: identity.state, login: identity.login, allowlisted: identity.allowlisted, admin: identity.admin },
        billing: billing === undefined ? null : { state: billing.state, totalUsd: billing.totalUsd },
        watchedRepos: watched?.selected ?? null,
        commands: ctx.commands.entries().map((entry) => ({
          name: entry.binding.descriptor.name,
          trigger: entry.binding.descriptor.modelInvocable ? "both" : "user",
          hidden: entry.metadata.hidden === true
        }))
      })
    )
  }

  const debugEvents = (): { readonly value: string } => {
    const tail = [...ctx.store.collections.transitions.values()]
      .sort((left, right) => left.revision - right.revision)
      .slice(-40)
      .map((record) => ({
        revision: record.revision,
        actor: record.actor,
        type: record.type,
        at: new Date(record.createdAt).toISOString()
      }))
    return surfaceDebugRead("Transition journal tail", JSON.stringify(tail))
  }

  const debugChain = (): { readonly value: string } => {
    // The journal fold, whole: every lineage (turns and backgrounds), each
    // link's script, calls, rejections, steering, outcome, and the author
    // contexts — the two-histories view. Full payloads by design: the
    // admin panel is the raw-payload surface the transcript never is.
    return surfaceDebugRead(
      "Chain journal x-ray",
      JSON.stringify(foldLineages([...ctx.store.collections.chainEvents.values()]))
    )
  }

  const netTap = (): string => JSON.stringify([...ctx.netRing].reverse())

  const debugNet = (): { readonly value: string } => surfaceDebugRead("Network tap", netTap())

  const resetGrants = async (): Promise<string | { readonly value: string }> => {
    if (ctx.agent.revokeGrants === undefined) return "this backend holds no grants"
    await ctx.agent.revokeGrants()
    // A revocation the human cannot see is a revocation they cannot trust.
    if (ctx.commandActor !== "smithers") {
      ctx.store.dispatch({
        type: "message.appended",
        actor: "system",
        text: "The chain's session grants are revoked — the next tool call asks for permission again."
      })
    }
    return { value: "chain grants revoked" }
  }

  const debugSeams = async (): Promise<string | void | { readonly value: string }> => {
    // admin.health is a VIEW over this same read, not a separate path.
    await adminHealth()
    const card = ctx.store.collections.cards.get("admin-health")
    if (card === undefined || card.kind !== "admin-health") {
      return "The seam probe didn't land — see the honest line in the chat."
    }
    return { value: JSON.stringify(card.payload) }
  }

  /*
   * The browser tool + surface (§2d/§2d′): the server-side guarded fetch
   * reads the page; the embedded card shows it (iframe when the site allows
   * framing, the honest blocked state when not). The agent's invocation
   * hands the extracted text back as the tool result — the transcript only
   * ever carries the one-line act ("Smithers read <host>").
   */
  const openBrowserImpl = async (url: string): Promise<true | string | { readonly value: string }> => {
    let outcome:
      | {
        status?: unknown
        finalUrl?: unknown
        text?: unknown
        frameable?: unknown
        blockReason?: unknown
      }
      | undefined
    try {
      const response = await ctx.boundedFetch(`${ctx.baseUrl}${TOOLS_BROWSER_FETCH_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url })
      })
      if (!response.ok) {
        const message = await ctx.errorMessageOf(response, "That page couldn't be read.")
        const card = browserCard(url, { error: message })
        ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
        return message
      }
      outcome = (await response.json().catch(() => undefined)) as typeof outcome
    } catch {
      const message = "That page couldn't be read — the browser service didn't answer."
      ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: browserCard(url, { error: message }) })
      return message
    }
    if (outcome === undefined || typeof outcome.status !== "number") {
      const message = "The browser service answered in a shape I didn't understand."
      ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: browserCard(url, { error: message }) })
      return message
    }
    const card = browserCard(url, {
      finalUrl: typeof outcome.finalUrl === "string" ? outcome.finalUrl : url,
      status: outcome.status,
      frameable: outcome.frameable !== false,
      blockReason: typeof outcome.blockReason === "string" ? outcome.blockReason : null
    })
    ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
    const text = typeof outcome.text === "string" ? outcome.text : ""
    if (ctx.commandActor === "smithers") {
      // The read IS the tool result for the model; the card is the surface.
      return { value: text === "" ? `Read ${url} (HTTP ${outcome.status}) — the page had no readable text.` : text }
    }
    return true
  }

  const browserCardId = (url: string): string => `browser-${url}`

  const browserCard = (
    url: string,
    result:
      | { finalUrl: string; status: number; frameable: boolean; blockReason: string | null }
      | { error: string }
  ): Card => {
    const id = browserCardId(url)
    const existing = ctx.store.collections.cards.get(id)
    let highest = -1
    for (const message of ctx.store.collections.messages.values()) highest = Math.max(highest, message.ordinal)
    for (const card of ctx.store.collections.cards.values()) highest = Math.max(highest, card.ordinal)
    const payload: Extract<Card, { kind: "browser" }>["payload"] = "error" in result
      ? { url, finalUrl: null, status: null, frameable: false, blockReason: null, error: result.error }
      : {
        url,
        finalUrl: result.finalUrl,
        status: result.status,
        frameable: result.frameable,
        blockReason: result.blockReason
      }
    return {
      id,
      kind: "browser",
      title: (() => {
        try {
          return new URL(url).host
        } catch {
          return url
        }
      })(),
      status: "error" in result ? "error" : "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? highest + 1,
      payload
    }
  }

  const openBrowser = (url: string): Promise<string | void | { readonly value: string }> => {
    let host = url
    try {
      host = new URL(url).host
    } catch {
      // The invalid-URL case is the impl's honest error.
    }
    return ctx.withToast("browser.fetch", `Reading ${host}…`, `Read ${host}`, () => openBrowserImpl(url)).then(
      (outcome) => {
        if (outcome === true) return undefined
        return outcome
      }
    )
  }

  const toggleTheme = (): void => {
    ctx.store.dispatch({
      type: "theme.changed",
      actor: "user",
      theme: ctx.store.session().theme === "dark" ? "light" : "dark"
    })
  }

  /*
   * The color theme (/theme), the axis orthogonal to the light/dark toggle.
   * Which palette to wear is the human's own choice, so an unrecognized key
   * is never rounded to the nearest one: the answer is the list itself, one
   * calm line, and a bare /theme states where they already are.
   */
  const themePickerCard = (): Extract<Card, { kind: "theme-picker" }> | undefined => {
    const card = ctx.store.collections.cards.get(THEME_PICKER_CARD_ID)
    return card?.kind === "theme-picker" ? card : undefined
  }

  /*
   * Bare /theme answers with the picker card, not a sentence: one swatch per
   * palette, each painted in its own colors, upserted to the transcript's
   * tail like the repo chooser. An unrecognized key opens the same picker —
   * the list of valid answers IS the interface.
   */
  const openThemePicker = (selected: Palette): void => {
    const existing = themePickerCard()
    let highest = -1
    for (const message of ctx.store.collections.messages.values()) highest = Math.max(highest, message.ordinal)
    for (const card of ctx.store.collections.cards.values()) highest = Math.max(highest, card.ordinal)
    ctx.store.dispatch({
      type: "card.upsert",
      actor: "user",
      card: {
        id: THEME_PICKER_CARD_ID,
        kind: "theme-picker",
        title: "Color themes",
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: highest + 1,
        payload: { selected }
      }
    })
  }

  const setPalette = (args: string): string | void => {
    const requested = args.trim().toLowerCase()
    const current = ctx.store.session().palette ?? DEFAULT_PALETTE
    if (requested === "") {
      openThemePicker(current)
      return
    }
    if (!isPalette(requested)) {
      openThemePicker(current)
      return `theme needs one of: ${PALETTES.join(", ")}`
    }
    ctx.store.dispatch({ type: "palette.changed", actor: "user", palette: requested })
    // The open picker follows the choice, so its "current" mark stays honest.
    const picker = themePickerCard()
    if (picker !== undefined) {
      ctx.store.dispatch({
        type: "card.upsert",
        actor: "user",
        card: { ...picker, payload: { selected: requested } }
      })
    }
  }

  return {
    showChat,
    showWorld,
    showConnectors,
    maximizeCard,
    minimizeCard,
    toggleDevtools,
    toggleSurfacesMenu,
    toggleConnectMenu,
    closeConnectMenu,
    describeAgentBackend,
    debugSnapshot,
    debugEvents,
    debugChain,
    netTap,
    debugNet,
    resetGrants,
    debugSeams,
    openBrowser,
    toggleTheme,
    setPalette
  }
}
