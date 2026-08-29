/**
 * The shell's state: one immutable snapshot behind `useSyncExternalStore`.
 *
 * No `useEffect` anywhere in the app. Everything that is not derived during
 * render is either an event handler calling an action here, or a module-level
 * subscription (see router.ts). Fetches run in actions and publish a new
 * snapshot when they resolve.
 *
 * Selectors must return a referentially stable slice, so the exposed hooks
 * only read whole fields.
 */
import { useSyncExternalStore } from "react"
import type { AppCard, TurnFrame } from "../api.ts"
import * as client from "./client.ts"

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type TranscriptEntry =
  | { readonly kind: "message"; readonly id: string; readonly role: "user" | "assistant" | "system"; readonly text: string }
  | { readonly kind: "cell"; readonly id: string; readonly ordinal: number; readonly source: string }
  | {
      readonly kind: "call"
      readonly id: string
      readonly flow: string
      readonly input: unknown
      readonly outcome: "success" | "failure"
      readonly message?: string
    }
  | { readonly kind: "card"; readonly id: string; readonly cardId: string }

export type TurnStatus = "idle" | "streaming" | "error"

export interface AppState {
  /** Current route path, e.g. "/build". Owned here so pages derive during render. */
  readonly route: string
  readonly sidebarCollapsed: boolean
  readonly search: string
  /** The Recent column, newest first, as `GET /api/session` returned it. */
  readonly sessions: ReadonlyArray<client.SessionSummary>
  /**
   * Whether `sessions` has been read from the Worker yet. "api" once a read
   * succeeded, including a read that returned nothing; "mock" while no read has
   * succeeded, which is the state a page shows before its first refresh and
   * after a failed one.
   *
   * TODO(shell): the value is no longer a data source, so the field wants the
   * name `sessionsLoaded` and the note at `app/build/page.tsx:102` wants copy
   * that says the column is empty rather than "Sample data".
   */
  readonly sessionsSource: "mock" | "api"
  readonly sessionId: string
  readonly draft: string
  readonly entries: ReadonlyArray<TranscriptEntry>
  readonly cards: Readonly<Record<string, AppCard>>
  readonly status: TurnStatus
  readonly error: string | undefined
  /** Card id presented as a fullscreen overlay, if any. */
  readonly maximizedCardId: string | undefined
  /** Whether the "Browse all" template drawer is open. */
  readonly templatesOpen: boolean
  /** Composer model label; the Build page's "Aomi" dropdown. */
  readonly model: string
  readonly previewEnabled: boolean
}

const newId = (prefix: string): string =>
  `${prefix}_${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`

let state: AppState = {
  route: "/build",
  sidebarCollapsed: false,
  search: "",
  sessions: [],
  sessionsSource: "mock",
  sessionId: newId("ses"),
  draft: "",
  entries: [],
  cards: {},
  status: "idle",
  error: undefined,
  maximizedCardId: undefined,
  templatesOpen: false,
  model: "Aomi",
  previewEnabled: false
}

const listeners = new Set<() => void>()

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getSnapshot = (): AppState => state

const set = (next: Partial<AppState>): void => {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

export const store = { subscribe, getSnapshot }

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** The whole snapshot. Stable between changes, so destructuring is safe. */
export const useAppState = (): AppState => useSyncExternalStore(subscribe, getSnapshot)

export const useRoute = (): string => useSyncExternalStore(subscribe, () => state.route)

/** The Recent column's sessions. */
export const useSessions = (): ReadonlyArray<client.SessionSummary> =>
  useSyncExternalStore(subscribe, () => state.sessions)

export const useTranscript = (): ReadonlyArray<TranscriptEntry> =>
  useSyncExternalStore(subscribe, () => state.entries)

// ---------------------------------------------------------------------------
// Frame reduction
// ---------------------------------------------------------------------------

/** Appends `text` to the trailing assistant message, or opens a new one. */
const appendDelta = (entries: ReadonlyArray<TranscriptEntry>, text: string): ReadonlyArray<TranscriptEntry> => {
  const last = entries[entries.length - 1]
  if (last !== undefined && last.kind === "message" && last.role === "assistant") {
    return [...entries.slice(0, -1), { ...last, text: last.text + text }]
  }
  return [...entries, { kind: "message", id: newId("msg"), role: "assistant", text }]
}

/** Folds one frame into the snapshot. Exported for tests. */
export const applyFrame = (previous: AppState, frame: TurnFrame): Partial<AppState> => {
  switch (frame.type) {
    case "delta":
      return { entries: appendDelta(previous.entries, frame.text) }
    case "cell":
      return {
        entries: [...previous.entries, { kind: "cell", id: newId("cell"), ordinal: frame.ordinal, source: frame.source }]
      }
    case "call":
      return {
        entries: [
          ...previous.entries,
          {
            kind: "call",
            id: newId("call"),
            flow: frame.flow,
            input: frame.input,
            outcome: frame.outcome,
            ...(frame.message === undefined ? {} : { message: frame.message })
          }
        ]
      }
    case "card":
      return {
        cards: { ...previous.cards, [frame.card.id]: frame.card },
        entries: [...previous.entries, { kind: "card", id: newId("card"), cardId: frame.card.id }]
      }
    case "card.update": {
      const known = previous.cards[frame.card.id] !== undefined
      return {
        cards: { ...previous.cards, [frame.card.id]: frame.card },
        entries: known
          ? previous.entries
          : [...previous.entries, { kind: "card", id: newId("card"), cardId: frame.card.id }]
      }
    }
    case "park":
      return {
        entries: [
          ...previous.entries,
          { kind: "message", id: newId("msg"), role: "system", text: `${frame.reason}: ${frame.message}` }
        ]
      }
    case "done":
      return { status: "idle" }
    case "error":
      return {
        status: "error",
        error: frame.message,
        entries: [...previous.entries, { kind: "message", id: newId("msg"), role: "system", text: frame.message }]
      }
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

let inflight: AbortController | undefined

/** How often a running flow re-reads its card, and how long it keeps trying. */
const FLOW_POLL_MS = 750
const FLOW_POLL_TICKS = 320

/** Whether a `flow-run` card has reached a phase that will not change again. */
const isSettled = (card: AppCard | undefined): boolean =>
  card !== undefined && card.kind === "flow-run" && card.phase !== "running" && card.phase !== "waiting-approval"

export const actions = {
  setRoute: (route: string): void => set({ route }),
  setDraft: (draft: string): void => set({ draft }),
  setSearch: (search: string): void => set({ search }),
  setModel: (model: string): void => set({ model }),
  togglePreview: (): void => set({ previewEnabled: !state.previewEnabled }),
  toggleSidebar: (): void => set({ sidebarCollapsed: !state.sidebarCollapsed }),
  openTemplates: (): void => set({ templatesOpen: true }),
  closeTemplates: (): void => set({ templatesOpen: false }),
  maximizeCard: (cardId: string): void => set({ maximizedCardId: cardId }),
  restoreCard: (): void => set({ maximizedCardId: undefined }),

  /** Clears the transcript and starts a fresh session id. */
  newSession: (): void => {
    inflight?.abort()
    inflight = undefined
    set({ sessionId: newId("ses"), entries: [], cards: {}, draft: "", status: "idle", error: undefined })
  },

  selectSession: (sessionId: string): void => {
    set({ sessionId, entries: [], cards: {}, status: "idle", error: undefined })
    void actions.loadSession(sessionId)
  },

  /**
   * Replaces the Recent column from `GET /api/session`.
   *
   * An empty answer is a real answer: a Worker with no runs has an empty
   * column, and showing the last successful read instead would claim sessions
   * that are gone. A failed read keeps whatever is on screen, because a network
   * blip is not a reason to empty the column.
   */
  refreshSessions: async (): Promise<void> => {
    try {
      set({ sessions: await client.listSessions(), sessionsSource: "api" })
    } catch {
      set({ sessionsSource: "mock" })
    }
  },

  /** Rehydrates one session's transcript from `GET /api/session?id=`. */
  loadSession: async (sessionId: string): Promise<void> => {
    try {
      const session = await client.getSession(sessionId)
      const cards: Record<string, AppCard> = {}
      for (const card of session.cards) cards[card.id] = card
      set({
        sessionId: session.id,
        cards,
        entries: [
          ...session.messages.map((message): TranscriptEntry => ({
            kind: "message",
            id: message.id,
            role: message.role,
            text: message.text
          })),
          ...session.cards.map((card): TranscriptEntry => ({ kind: "card", id: newId("card"), cardId: card.id }))
        ],
        status: session.busy ? "streaming" : "idle"
      })
    } catch (cause) {
      set({ status: "error", error: cause instanceof Error ? cause.message : String(cause) })
    }
  },

  /** Posts a turn and folds its NDJSON frames into the transcript. */
  submit: async (message: string, flowId = "chat"): Promise<void> => {
    const text = message.trim()
    if (text.length === 0 || state.status === "streaming") return
    const controller = new AbortController()
    inflight = controller
    set({
      draft: "",
      status: "streaming",
      error: undefined,
      entries: [...state.entries, { kind: "message", id: newId("msg"), role: "user", text }]
    })
    try {
      for await (const frame of client.streamTurn({ sessionId: state.sessionId, flowId, message: text }, controller.signal)) {
        set(applyFrame(state, frame))
      }
      // Re-read: a `done` or `error` frame may already have settled the turn.
      if (store.getSnapshot().status === "streaming") set({ status: "idle" })
    } catch (cause) {
      if (controller.signal.aborted) {
        set({ status: "idle" })
      } else {
        const detail = cause instanceof Error ? cause.message : String(cause)
        set({
          status: "error",
          error: detail,
          entries: [...state.entries, { kind: "message", id: newId("msg"), role: "system", text: detail }]
        })
      }
    } finally {
      if (inflight === controller) inflight = undefined
    }
  },

  /**
   * Starts a pipeline flow and follows its `flow-run` card to a settled phase.
   *
   * `POST /api/flows/run` answers with an execution id and nothing else: the
   * run outlives the request and writes its progress into the session as one
   * card that it keeps replacing. There is no stream to read it from, so the
   * card is re-read on a timer until it settles. A poll rather than a socket is
   * the whole cost of the fire-and-forget route, and it is bounded so a run
   * that never settles does not poll forever.
   *
   * TODO(worker): serve the run's `card.update` frames on a stream of their own
   * so this loop becomes a subscription (worker/router.ts, `Routes.flowRun`).
   */
  runFlow: async (flowId: string, payload: unknown): Promise<void> => {
    const sessionId = state.sessionId
    let executionId: string
    try {
      executionId = await client.runFlow({ sessionId, flowId, payload })
    } catch (cause) {
      set({ status: "error", error: cause instanceof Error ? cause.message : String(cause) })
      return
    }
    for (let tick = 0; tick < FLOW_POLL_TICKS; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, FLOW_POLL_MS))
      // The user moved on. The run keeps going in the Worker; its card is
      // waiting in the session whenever they come back to it.
      if (store.getSnapshot().sessionId !== sessionId) return
      await actions.loadSession(sessionId)
      await actions.refreshSessions()
      if (isSettled(store.getSnapshot().cards[executionId])) return
    }
  },

  /** Stops the streaming turn locally and tells the Worker to drop it. */
  stop: (): void => {
    inflight?.abort()
    inflight = undefined
    set({ status: "idle" })
    void client.cancelTurn(state.sessionId).catch(() => undefined)
  }
}
