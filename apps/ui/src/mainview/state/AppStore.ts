import type { StandardSchemaV1 } from "@standard-schema/spec"
import { openBrowserWASQLiteOPFSDatabase } from "@tanstack/browser-db-sqlite-persistence"
import { localStorageCollectionOptions } from "@tanstack/db"
import type { InferSchemaOutput, StorageApi, StorageEventApi } from "@tanstack/db"
import { createCollection, createTransaction } from "@tanstack/react-db"
import type { Transaction } from "@tanstack/react-db"
import {
  APP_SCHEMA_VERSION,
  enforceSchemaVersion,
  readRecordedBackend,
  recordBackend
} from "../chain/SchemaVersion"
import { openSqliteRowStorage } from "../chain/SqliteRowStorage"
import { openTransactionalStorage } from "../chain/TransactionalStorage"
import type { LegacyCollectionSpec, TransactionalStorage } from "../chain/TransactionalStorage"
import { PALETTE_MIRROR_KEY, rememberAppearance, THEME_MIRROR_KEY } from "./Appearance"
import {
  BillingAccountSchema,
  BranchSchema,
  CardSchema,
  cardFrameId,
  ChainEventRecordSchema,
  ConnectorOperationSchema,
  DEFAULT_PALETTE,
  DEFAULT_BRANCH_ID,
  DEFAULT_WORKSPACE_ID,
  FrameSchema,
  HarnessSchema,
  IdentitySessionSchema,
  initialBillingAccount,
  initialConnectorOperation,
  initialIdentitySession,
  initialSession,
  initialWorldDocuments,
  LocalRepositoryConnectorSchema,
  MAIN_TAB_ID,
  mainTab,
  MessageSchema,
  RepoSchema,
  rootFrameId,
  SessionSchema,
  TabSchema,
  ToastSchema,
  ToolCallRecordSchema,
  TransitionRecordSchema,
  WatchedReposSchema,
  WorkspaceSchema,
  WORLD_DISPLAY_NAME,
  WorldDocumentSchema
} from "./AppState"
import type {
  AppTransition,
  BillingAccount,
  Branch,
  Card,
  ChainEventRecord,
  ConnectorOperation,
  Frame,
  Harness,
  IdentitySession,
  LocalRepositoryConnector,
  Message,
  Palette,
  Repo,
  RepositoryCapabilityPattern,
  Session,
  TabRow,
  Toast,
  ToolCallRecord,
  TransitionRecord,
  WatchedRepos,
  Workspace,
  WorldDocument
} from "./AppState"

const SESSION_ID = "main"

/*
 * Retention bounds for the log collections (apps/ui/docs/persistence.md §
 * "Retention and compaction"). Compaction runs inside the same dispatch
 * transaction that appends, so it is part of the atomic commit, and it keeps
 * the newest records: the debuggable tail is the valuable end of a log.
 */
export const MAX_TRANSITION_RECORDS = 500
export const MAX_TOOL_CALL_RECORDS = 250
export const MAX_CHAIN_EVENT_RECORDS = 1000

/**
 * The keys of the records beyond `keep`, oldest first. `order` is the row's
 * position in the log (a revision, a createdAt); ties fall to the key so the
 * choice is stable.
 */
const staleLogKeys = <T extends { readonly id: string }>(
  rows: ReadonlyArray<T>,
  keep: number,
  order: (row: T) => number
): Array<string> => {
  if (rows.length <= keep) return []
  return [...rows]
    .sort((left, right) => order(left) - order(right) || left.id.localeCompare(right.id))
    .slice(0, rows.length - keep)
    .map((row) => row.id)
}

/** The onboarding welcome's stable id, so a boot refresh upserts instead of duplicating. */
export const ONBOARDING_MESSAGE_ID = "message-onboarding"
/** The onboarding chooser's stable id: one chooser at a time, upserted. */
export const REPO_CHOOSER_CARD_ID = "repo-chooser"
/** The /theme picker's stable id: one picker at a time, upserted. */
export const THEME_PICKER_CARD_ID = "theme-picker"

const preferredTheme = (): Session["theme"] =>
  typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"

const applyTheme = (theme: Session["theme"]): void => {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme
  // §20.4: the next boot paints this before the store is even open.
  rememberAppearance(THEME_MIRROR_KEY, theme)
}

/*
 * The color theme, stamped on the same element as data-theme and read by the
 * palette blocks in styles/tokens.css. The default is stamped explicitly too,
 * so the attribute always states which palette is live (tokens.css falls back
 * to night-owl either way).
 */
const applyPalette = (palette: Palette): void => {
  if (typeof document !== "undefined") document.documentElement.dataset.palette = palette
  rememberAppearance(PALETTE_MIRROR_KEY, palette)
}

const transitionPayload = (transition: AppTransition): string => {
  const { actor: _actor, type: _type, ...payload } = transition
  return JSON.stringify(payload)
}

type ApprovalCard = Extract<Card, { kind: "approval" }>

/**
 * The gate an approval card asks about — the thing a decision decides.
 *
 * A workflow gate is the run's node at an iteration; the ask's wording is not
 * part of it, so restating the same gate in different words is still the same
 * decision. A chain park has no node: the runtime reuses one card id per
 * lineage, and what changes between parks is the capability being asked for, so
 * that is the gate's identity there.
 */
const approvalGateKey = (card: ApprovalCard): string => {
  const { runId = "", nodeId, iteration = 0, chain, flow = "", capability } = card.payload
  return nodeId === undefined
    ? `ask:${runId}:${chain === true}:${flow}:${capability}`
    : `gate:${runId}:${nodeId}:${iteration}`
}

/**
 * The card, when it carries a decision a human already made.
 *
 * A recorded decision — not the "acted" status — is what freezes an approval.
 * The status is a generic terminal marker any card kind uses and a streamed
 * frame can set; the decision is the human's authorisation, and it is the thing
 * that must never be given twice. `AppController.runAwaitsApproval` reads the
 * same field to decide whether a run is still parked on a human.
 */
const decidedApproval = (card: Card | undefined): ApprovalCard | undefined =>
  card !== undefined && card.kind === "approval" && card.payload.decision !== undefined
    ? card
    : undefined

/**
 * Which store the running app is reading. "memory" is the degraded launch: the
 * store that holds the user's data could not be opened, so nothing is read and
 * nothing is written over it.
 */
export type PersistenceMode = "opfs" | "localStorage" | "memory"

export type PersistenceBackend =
  | {
    readonly kind: "opfs"
    readonly storage: StorageApi
    readonly storageEventApi: StorageEventApi
    readonly beginBatch: () => void
    readonly commitBatch: () => void
    readonly abortBatch: () => void
    readonly flush: () => Promise<void>
    readonly close: () => Promise<void>
  }
  | {
    readonly kind: "localStorage"
    readonly storage?: StorageApi
  }

interface ResolvedPersistence {
  readonly backend: PersistenceBackend
  readonly mode: PersistenceMode
  /** True when the store holding the user's data could not be opened. */
  readonly degraded: boolean
}

const OPFS_DATABASE_NAME = "smithers-mvp.sqlite"

const PERSISTED_COLLECTION_SPECS: ReadonlyArray<LegacyCollectionSpec> = [
  { id: "app-sessions", schema: SessionSchema },
  { id: "app-messages", schema: MessageSchema },
  { id: "app-connectors", schema: LocalRepositoryConnectorSchema },
  { id: "app-connector-operations", schema: ConnectorOperationSchema },
  { id: "world-documents", schema: WorldDocumentSchema },
  { id: "app-cards", schema: CardSchema },
  { id: "app-transitions", schema: TransitionRecordSchema },
  { id: "app-identity-sessions", schema: IdentitySessionSchema },
  { id: "app-billing-accounts", schema: BillingAccountSchema },
  { id: "app-toasts", schema: ToastSchema },
  { id: "app-watched-repos", schema: WatchedReposSchema },
  { id: "app-tool-calls", schema: ToolCallRecordSchema },
  { id: "app-chain-events", schema: ChainEventRecordSchema },
  { id: "app-tabs", schema: TabSchema },
  { id: "app-harnesses", schema: HarnessSchema },
  { id: "app-repos", schema: RepoSchema },
  { id: "app-workspaces", schema: WorkspaceSchema },
  { id: "app-branches", schema: BranchSchema },
  { id: "app-frames", schema: FrameSchema }
]
/** Attempts spent waiting out a locked access-handle pool. See `openOpfsDatabase`. */
const OPFS_OPEN_ATTEMPTS = 5
/** The whole OPFS open, retries included. A store that never answers must not hang boot. */
const OPFS_OPEN_BUDGET_MS = 4_000

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A localStorage-shaped store that lives only as long as this document. */
const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

/* OPFS has no window `storage` events; localStorage events name another host. */
const inertStorageEvents: StorageEventApi = {
  addEventListener: () => {},
  removeEventListener: () => {}
}

/*
 * Where the boot stamps live. Always window.localStorage, whichever backend
 * holds the data: it is the one store that is synchronous and readable before
 * anything else is open. A browser with storage disabled throws on the property
 * itself, so the read is guarded.
 */
const bootRecordStorage = (): StorageApi | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/*
 * Stamping the backend is bookkeeping, not the boot. A storage that refuses the
 * write (a full or blocked localStorage) costs the next launch its shortcut; it
 * must never cost this one its start.
 */
const stampBackend = (storage: StorageApi, backend: "opfs" | "localStorage"): void => {
  try {
    recordBackend(storage, backend)
  } catch (error) {
    console.warn("Smithers: could not record which store holds this app's data.", error)
  }
}

/*
 * Open the OPFS database, retrying while the access-handle pool is still held.
 *
 * A reload overlaps two documents: the outgoing one still owns wa-sqlite's
 * access handles when the incoming one asks for them, so the first open throws
 * for a database that is present and healthy. Retrying turns that race into a
 * short wait. Callers pass one attempt when nothing is known to live in OPFS,
 * so a browser without OPFS at all still boots without paying the backoff.
 */
const openOpfsDatabase = async (attempts: number) => {
  let failure: unknown = new Error("OPFS was never attempted")
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await wait(100 * 2 ** (attempt - 1))
    try {
      return await openBrowserWASQLiteOPFSDatabase({ databaseName: OPFS_DATABASE_NAME })
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

/*
 * The same open under a wall-clock budget. A worker that neither answers nor
 * fails would otherwise leave the app on a splash screen forever. A database
 * that arrives after the budget is closed rather than abandoned, so it does not
 * sit on the access handles the next launch needs.
 */
const openOpfsDatabaseWithinBudget = async (attempts: number) => {
  const open = openOpfsDatabase(attempts)
  let timer: ReturnType<typeof setTimeout> | undefined
  let won = false
  try {
    const database = await Promise.race([
      open,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`OPFS did not open within ${OPFS_OPEN_BUDGET_MS}ms`)),
          OPFS_OPEN_BUDGET_MS
        )
      })
    ])
    won = true
    return database
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (!won) void open.then((database) => database.close?.()).catch(() => {})
  }
}

/*
 * Choose the store this launch reads, and honour the choice the last launch
 * made (E3.6).
 *
 * The two backends cannot be merged, so "try OPFS, fall back on any error" is
 * not a fallback at all: the launch after a fallback opens the other store,
 * finds it empty, and the user's whole transcript is gone with no message. The
 * recorded backend is therefore authoritative.
 *
 * A recorded OPFS store that will not open is the one case with no good answer.
 * Reading localStorage instead would present a stale store as the current
 * conversation, and writing into it would fork the history; refusing to boot
 * would strand the user completely. This launch runs on a memory store instead:
 * the app starts, the real store is untouched and returns on the next launch,
 * and `persistenceDegraded` plus a console error say so rather than passing the
 * empty surface off as a fresh start.
 */
const resolvePersistence = async (): Promise<ResolvedPersistence> => {
  const record = bootRecordStorage()
  const recorded = record === undefined ? null : readRecordedBackend(record)
  if (recorded === "localStorage") {
    return {
      backend: { kind: "localStorage", storage: record },
      mode: "localStorage",
      degraded: false
    }
  }
  try {
    const database = await openOpfsDatabaseWithinBudget(recorded === "opfs" ? OPFS_OPEN_ATTEMPTS : 1)
    const sqlite = await openSqliteRowStorage(database, {
      collections: PERSISTED_COLLECTION_SPECS,
      schemaVersion: APP_SCHEMA_VERSION
    }).catch(async (error) => {
      await database.close?.()
      throw error
    })
    if (record !== undefined) stampBackend(record, "opfs")
    return {
      backend: {
        kind: "opfs",
        storage: sqlite.storage,
        storageEventApi: inertStorageEvents,
        beginBatch: sqlite.beginBatch,
        commitBatch: sqlite.commitBatch,
        abortBatch: sqlite.abortBatch,
        flush: sqlite.flush,
        close: sqlite.close
      },
      mode: "opfs",
      degraded: false
    }
  } catch (error) {
    if (recorded === "opfs") {
      console.error(
        "Smithers: this app's data lives in OPFS SQLite and that store could not be opened, so this session starts empty and saves nothing. The conversation is still on disk and comes back once the store opens again.",
        error
      )
      return { backend: { kind: "localStorage", storage: memoryStorage() }, mode: "memory", degraded: true }
    }
    if (record === undefined) {
      console.error(
        "Smithers: neither OPFS SQLite nor localStorage is available in this browser context, so this session saves nothing.",
        error
      )
      return { backend: { kind: "localStorage", storage: memoryStorage() }, mode: "memory", degraded: true }
    }
    console.warn(
      "Smithers: OPFS SQLite persistence is unavailable in this browser context; falling back to localStorage persistence.",
      error
    )
    stampBackend(record, "localStorage")
    return { backend: { kind: "localStorage", storage: record }, mode: "localStorage", degraded: false }
  }
}

/*
 * The storage object a localStorage-backed store actually reads, so the schema
 * gate runs over the same bytes the collections do. TanStack resolves an
 * omitted `storage` to window.localStorage, then to its own in-memory store;
 * the last case has nothing persisted to gate.
 */
const storageOf = (backend: PersistenceBackend): StorageApi | undefined =>
  backend.kind === "opfs" ? backend.storage : (backend.storage ?? bootRecordStorage())

interface CollectionSpec<TSchema extends StandardSchemaV1> {
  readonly id: string
  readonly getKey: (item: InferSchemaOutput<TSchema>) => string
  readonly schema: TSchema
}

const createPersistedCollection = <TSchema extends StandardSchemaV1>(
  backend: PersistenceBackend,
  spec: CollectionSpec<TSchema>
) => {
  const options = localStorageCollectionOptions({
    id: spec.id,
    storageKey: `smithers-mvp.${spec.id}`,
    getKey: spec.getKey,
    schema: spec.schema,
    ...(backend.storage === undefined ? {} : { storage: backend.storage }),
    ...(backend.kind === "opfs" ? { storageEventApi: backend.storageEventApi } : {})
  })
  return createCollection({ ...options, schema: spec.schema })
}

export interface AppCollections {
  readonly sessions: ReturnType<typeof createSessionCollection>
  readonly messages: ReturnType<typeof createMessageCollection>
  readonly connectors: ReturnType<typeof createConnectorCollection>
  readonly connectorOperations: ReturnType<typeof createConnectorOperationCollection>
  readonly worldDocuments: ReturnType<typeof createWorldDocumentCollection>
  readonly cards: ReturnType<typeof createCardCollection>
  readonly transitions: ReturnType<typeof createTransitionCollection>
  readonly identitySessions: ReturnType<typeof createIdentitySessionCollection>
  readonly billingAccounts: ReturnType<typeof createBillingAccountCollection>
  readonly toasts: ReturnType<typeof createToastCollection>
  readonly watchedRepos: ReturnType<typeof createWatchedReposCollection>
  readonly toolCalls: ReturnType<typeof createToolCallCollection>
  readonly chainEvents: ReturnType<typeof createChainEventCollection>
  /* The local-app tab strip and what its `+` menu and repo chip read (docs/LOCAL-APP.md). */
  readonly tabs: ReturnType<typeof createTabCollection>
  readonly harnesses: ReturnType<typeof createHarnessCollection>
  readonly repos: ReturnType<typeof createRepoCollection>
  readonly workspaces: ReturnType<typeof createWorkspaceCollection>
  readonly branches: ReturnType<typeof createBranchCollection>
  readonly frames: ReturnType<typeof createFrameCollection>
}

export interface WorldStateSnapshot {
  readonly capturedAt: number
  readonly revision: number
  readonly documents: ReadonlyArray<WorldDocument>
  readonly markdown: string
}

export interface AgentContextSnapshot {
  readonly capturedAt: number
  readonly revision: number
  readonly messages: ReadonlyArray<Message>
  readonly connectors: ReadonlyArray<LocalRepositoryConnector>
  readonly worldState: WorldStateSnapshot
}

export interface AppStore {
  readonly collections: AppCollections
  readonly dispatch: (transition: AppTransition) => Transaction
  readonly persistenceMode: PersistenceMode
  /**
   * True when the store holding this user's data could not be opened, so the
   * session runs on memory and saves nothing. A surface that shows a
   * conversation must say this rather than render the empty one as current.
   */
  readonly persistenceDegraded: boolean
  readonly session: () => Session
  readonly worldStateSnapshot: () => WorldStateSnapshot
  readonly agentContextSnapshot: () => AgentContextSnapshot
  /** Release persistence resources acquired for this store. */
  readonly dispose?: () => void
}

const createSessionCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-sessions",
    getKey: (session: Session) => session.id,
    schema: SessionSchema
  })

const createMessageCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-messages",
    getKey: (message: Message) => message.id,
    schema: MessageSchema
  })

const createConnectorCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-connectors",
    getKey: (connector: LocalRepositoryConnector) => connector.id,
    schema: LocalRepositoryConnectorSchema
  })

const createConnectorOperationCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-connector-operations",
    getKey: (operation: ConnectorOperation) => operation.id,
    schema: ConnectorOperationSchema
  })

const createWorldDocumentCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "world-documents",
    getKey: (document: WorldDocument) => document.id,
    schema: WorldDocumentSchema
  })

const createCardCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-cards",
    getKey: (card: Card) => card.id,
    schema: CardSchema
  })

const createTransitionCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-transitions",
    getKey: (transition: TransitionRecord) => transition.id,
    schema: TransitionRecordSchema
  })

const createIdentitySessionCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-identity-sessions",
    getKey: (session: IdentitySession) => session.id,
    schema: IdentitySessionSchema
  })

const createBillingAccountCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-billing-accounts",
    getKey: (account: BillingAccount) => account.id,
    schema: BillingAccountSchema
  })

const createToastCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-toasts",
    getKey: (toast: Toast) => toast.id,
    schema: ToastSchema
  })

const createWatchedReposCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-watched-repos",
    getKey: (watched: WatchedRepos) => watched.id,
    schema: WatchedReposSchema
  })

const createToolCallCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-tool-calls",
    getKey: (record: ToolCallRecord) => record.id,
    schema: ToolCallRecordSchema
  })

const createChainEventCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-chain-events",
    getKey: (record: ChainEventRecord) => record.id,
    schema: ChainEventRecordSchema
  })

const createTabCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-tabs",
    getKey: (tab: TabRow) => tab.id,
    schema: TabSchema
  })

const createHarnessCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-harnesses",
    getKey: (harness: Harness) => harness.id,
    schema: HarnessSchema
  })

const createRepoCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-repos",
    getKey: (repo: Repo) => repo.id,
    schema: RepoSchema
  })

const createWorkspaceCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-workspaces",
    getKey: (workspace: Workspace) => workspace.id,
    schema: WorkspaceSchema
  })

const createBranchCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-branches",
    getKey: (branch: Branch) => branch.id,
    schema: BranchSchema
  })

const createFrameCollection = (backend: PersistenceBackend) =>
  createPersistedCollection(backend, {
    id: "app-frames",
    getKey: (frame: Frame) => frame.id,
    schema: FrameSchema
  })

/** The strip's order: main first, then creation order. */
const orderedTabs = (collections: Pick<AppCollections, "tabs">): Array<TabRow> =>
  [...collections.tabs.values()].sort((left, right) => left.ordinal - right.ordinal)

const seed = async (collections: AppCollections): Promise<void> => {
  await Promise.all([
    collections.sessions.preload(),
    collections.messages.preload(),
    collections.connectors.preload(),
    collections.connectorOperations.preload(),
    collections.worldDocuments.preload(),
    collections.cards.preload(),
    collections.transitions.preload(),
    collections.identitySessions.preload(),
    collections.billingAccounts.preload(),
    collections.toasts.preload(),
    collections.watchedRepos.preload(),
    collections.toolCalls.preload(),
    collections.chainEvents.preload(),
    collections.tabs.preload(),
    collections.harnesses.preload(),
    collections.repos.preload(),
    collections.workspaces.preload(),
    collections.branches.preload(),
    collections.frames.preload()
  ])

  if (collections.sessions.get(SESSION_ID) === undefined) {
    await collections.sessions.insert(initialSession(preferredTheme())).isPersisted.promise
  } else {
    /*
     * Heal a session row persisted before newer required fields existed
     * (updates validate the FULL row, so one missing field would wedge every
     * later dispatch — composer typing included). Seed values fill exactly
     * the absent keys, once, so the schema stays strict with no migration
     * table. Generic over the seed so the next added field heals too.
     */
    const persisted = collections.sessions.get(SESSION_ID) as unknown as Record<string, unknown>
    const seed = initialSession(preferredTheme()) as unknown as Record<string, unknown>
    const missing = Object.keys(seed).filter((key) => persisted[key] === undefined)
    if (missing.length > 0) {
      collections.sessions.update(SESSION_ID, (draft) => {
        const target = draft as unknown as Record<string, unknown>
        for (const key of missing) target[key] = seed[key]
      })
    }
  }
  // Wave 14 §1: nothing seeds the transcript. Signed out, the auth message is
  // the whole conversation; signed in and never-chosen, the repo chooser's
  // welcome is the first message. See AppState's note on the removed welcome.
  if (collections.connectorOperations.get("connector-operation") === undefined) {
    await collections.connectorOperations
      .insert(initialConnectorOperation())
      .isPersisted.promise
  }
  if (collections.worldDocuments.size === 0) {
    await collections.worldDocuments.insert([...initialWorldDocuments()]).isPersisted.promise
  }
  if (collections.identitySessions.get("identity") === undefined) {
    await collections.identitySessions.insert(initialIdentitySession()).isPersisted.promise
  }
  if (collections.billingAccounts.get("billing") === undefined) {
    await collections.billingAccounts.insert(initialBillingAccount()).isPersisted.promise
  }
  if (collections.tabs.get(MAIN_TAB_ID) === undefined) {
    await collections.tabs.insert(mainTab()).isPersisted.promise
  }
  if (collections.workspaces.get(DEFAULT_WORKSPACE_ID) === undefined) {
    await collections.workspaces.insert({
      id: DEFAULT_WORKSPACE_ID,
      title: "Smithers",
      createdAt: Date.now(),
      revision: 0
    }).isPersisted.promise
  }
  if (collections.branches.get(DEFAULT_BRANCH_ID) === undefined) {
    await collections.branches.insert({
      id: DEFAULT_BRANCH_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: "Main",
      parentBranchId: null,
      forkedFromFrameId: null,
      forkedAtRevision: null,
      createdAt: Date.now(),
      revision: 0
    }).isPersisted.promise
  }
  const defaultRootFrameId = rootFrameId(DEFAULT_BRANCH_ID)
  if (collections.frames.get(defaultRootFrameId) === undefined) {
    await collections.frames.insert({
      id: defaultRootFrameId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      branchId: DEFAULT_BRANCH_ID,
      kind: "root",
      parentFrameId: null,
      cardId: null,
      presentation: "embedded",
      stateRevision: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 0
    }).isPersisted.promise
  }
  const session = collections.sessions.get(SESSION_ID)
  const workspaceId = session?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID
  const branchId = session?.activeBranchId ?? DEFAULT_BRANCH_ID
  for (const card of collections.cards.values()) {
    const id = cardFrameId(branchId, card.id)
    if (collections.frames.get(id) !== undefined) continue
    await collections.frames.insert({
      id,
      workspaceId,
      branchId,
      kind: "card",
      parentFrameId: rootFrameId(branchId),
      cardId: card.id,
      presentation: session?.maximizedCardId === card.id ? "maximized" : "embedded",
      stateRevision: session?.revision ?? 0,
      createdAt: card.createdAt,
      updatedAt: Date.now(),
      revision: session?.revision ?? 0
    }).isPersisted.promise
  }
  if (session?.maximizedCardId !== null && session?.maximizedCardId !== undefined) {
    const id = cardFrameId(branchId, session.maximizedCardId)
    if (collections.frames.get(id) !== undefined && session.activeFrameId !== id) {
      await collections.sessions.update(SESSION_ID, (draft) => {
        draft.activeWorkspaceId = workspaceId
        draft.activeBranchId = branchId
        draft.activeFrameId = id
      }).isPersisted.promise
    }
  }
}

const repositoryCapabilities = (
  root: string,
  access: LocalRepositoryConnector["access"]
): ReadonlyArray<RepositoryCapabilityPattern> => {
  const resource = `${root.replace(/\/$/, "")}/**`
  return [
    { action: "fs:read", resource },
    ...(access === "read-write" ? ([{ action: "fs:write", resource }] as const) : [])
  ]
}

/*
 * The next place at the END of the transcript.
 *
 * Messages and cards are ONE ordered list, so they must number themselves off
 * one counter. Numbering a message over the messages alone put every message
 * posted after a card above that card — and because the ordinals persist, the
 * wrong order survived a reload (§7.5).
 */
/*
 * Everything on screen that belonged to the account that just left.
 *
 * The transcript, its cards and the balance are persisted, so signing out and
 * reloading still rendered the previous account's repository names, balance
 * and open cards — on a shared machine, to whoever sits down next (§2.4).
 * Signing out empties them.
 *
 * World notes are deliberately NOT dropped: they are the product's memory of
 * the work on this machine, sign-out is not "delete my data", and losing them
 * is not undoable.
 */
const forgetAccountState = (collections: AppCollections): void => {
  for (
    const collection of [
      collections.messages,
      collections.cards,
      collections.toasts,
      collections.watchedRepos,
      collections.toolCalls,
      collections.chainEvents,
      collections.transitions
    ]
  ) {
    const keys = [...(collection as { keys: () => Iterable<string> }).keys()]
    if (keys.length > 0) (collection as { delete: (keys: string[]) => void }).delete(keys)
  }
  const cardFrameKeys = [...collections.frames.values()]
    .filter((frame) => frame.kind === "card")
    .map((frame) => frame.id)
  if (cardFrameKeys.length > 0) collections.frames.delete(cardFrameKeys)
  collections.sessions.update(SESSION_ID, (draft) => {
    const branchId = draft.activeBranchId ?? DEFAULT_BRANCH_ID
    draft.maximizedCardId = null
    draft.activeFrameId = rootFrameId(branchId)
  })
  const reset = initialBillingAccount()
  if (collections.billingAccounts.get("billing") === undefined) {
    collections.billingAccounts.insert(reset)
  } else {
    collections.billingAccounts.update("billing", (draft) => {
      draft.state = reset.state
      draft.totalUsd = reset.totalUsd
      draft.allowedToStartWork = reset.allowedToStartWork
      draft.lifetimeChargedUsd = reset.lifetimeChargedUsd
      draft.chargeCount = reset.chargeCount
      draft.refreshedAt = reset.refreshedAt
      draft.revision = reset.revision
    })
  }
}

const nextOrdinal = (collections: Pick<AppCollections, "messages" | "cards">): number => {
  let highest = -1
  for (const message of collections.messages.values()) highest = Math.max(highest, message.ordinal)
  for (const card of collections.cards.values()) highest = Math.max(highest, card.ordinal)
  return highest + 1
}

export const createAppStore = async (
  backend?: PersistenceBackend
): Promise<AppStore> => {
  const resolved: ResolvedPersistence = backend === undefined
    ? await resolvePersistence()
    : { backend, mode: backend.kind, degraded: false }
  let resolvedBackend = resolved.backend
  /*
   * E14.2: the localStorage backend gets the version gate the OPFS backend
   * gets from `schemaMismatchPolicy`. It runs here, before the first
   * collection exists, because a collection reads its rows out of storage as
   * soon as it is preloaded and TanStack never validates them.
   */
  const persistedLocally = storageOf(resolvedBackend)
  let transactional: TransactionalStorage | undefined
  if (persistedLocally !== undefined && resolvedBackend.kind === "localStorage") {
    enforceSchemaVersion(persistedLocally)
    /* Open recovers any interrupted localStorage commit and migrates or
     * quarantines the envelope before the first collection reads it. */
    transactional = await openTransactionalStorage(persistedLocally, {
      collections: PERSISTED_COLLECTION_SPECS
    })
    resolvedBackend = { ...resolvedBackend, storage: transactional.storage }
  }
  const collections: AppCollections = {
    sessions: createSessionCollection(resolvedBackend),
    messages: createMessageCollection(resolvedBackend),
    connectors: createConnectorCollection(resolvedBackend),
    connectorOperations: createConnectorOperationCollection(resolvedBackend),
    worldDocuments: createWorldDocumentCollection(resolvedBackend),
    cards: createCardCollection(resolvedBackend),
    transitions: createTransitionCollection(resolvedBackend),
    identitySessions: createIdentitySessionCollection(resolvedBackend),
    billingAccounts: createBillingAccountCollection(resolvedBackend),
    toasts: createToastCollection(resolvedBackend),
    watchedRepos: createWatchedReposCollection(resolvedBackend),
    toolCalls: createToolCallCollection(resolvedBackend),
    chainEvents: createChainEventCollection(resolvedBackend),
    tabs: createTabCollection(resolvedBackend),
    harnesses: createHarnessCollection(resolvedBackend),
    repos: createRepoCollection(resolvedBackend),
    workspaces: createWorkspaceCollection(resolvedBackend),
    branches: createBranchCollection(resolvedBackend),
    frames: createFrameCollection(resolvedBackend)
  }

  await seed(collections)
  if (resolvedBackend.kind === "opfs") await resolvedBackend.flush()
  applyTheme(collections.sessions.get(SESSION_ID)?.theme ?? "light")
  applyPalette(collections.sessions.get(SESSION_ID)?.palette ?? DEFAULT_PALETTE)

  const session = (): Session => {
    const current = collections.sessions.get(SESSION_ID)
    if (current === undefined) throw new Error("Smithers app state is not initialized")
    return current
  }

  const worldStateSnapshot = (): WorldStateSnapshot => {
    const capturedAt = Date.now()
    const documents = [...collections.worldDocuments.values()].sort((left, right) =>
      left.path.localeCompare(right.path)
    )
    const markdown = documents
      .map(
        (document) =>
          `<!-- world-document: ${document.path}; confidence: ${document.confidence}; sources: ${
            document.sources.join(", ")
          } -->\n${document.body.trim()}`
      )
      .filter((document) => document.length > 0)
      .join("\n\n---\n\n")
    return { capturedAt, revision: session().revision, documents, markdown }
  }

  const agentContextSnapshot = (): AgentContextSnapshot => {
    const capturedAt = Date.now()
    return {
      capturedAt,
      revision: session().revision,
      messages: [...collections.messages.values()].sort(
        (left, right) => left.ordinal - right.ordinal
      ),
      connectors: [...collections.connectors.values()].sort((left, right) => left.name.localeCompare(right.name)),
      worldState: worldStateSnapshot()
    }
  }

  const persist = async (transaction: Parameters<typeof collections.sessions.utils.acceptMutations>[0]) => {
    const fanOut = (): Promise<unknown[]> =>
      Promise.all([
        collections.sessions.utils.acceptMutations(transaction),
        collections.messages.utils.acceptMutations(transaction),
        collections.connectors.utils.acceptMutations(transaction),
        collections.connectorOperations.utils.acceptMutations(transaction),
        collections.worldDocuments.utils.acceptMutations(transaction),
        collections.cards.utils.acceptMutations(transaction),
        collections.transitions.utils.acceptMutations(transaction),
        collections.identitySessions.utils.acceptMutations(transaction),
        collections.billingAccounts.utils.acceptMutations(transaction),
        collections.toasts.utils.acceptMutations(transaction),
        collections.watchedRepos.utils.acceptMutations(transaction),
        collections.toolCalls.utils.acceptMutations(transaction),
        collections.chainEvents.utils.acceptMutations(transaction),
        collections.tabs.utils.acceptMutations(transaction),
        collections.harnesses.utils.acceptMutations(transaction),
        collections.repos.utils.acceptMutations(transaction),
        collections.workspaces.utils.acceptMutations(transaction),
        collections.branches.utils.acceptMutations(transaction),
        collections.frames.utils.acceptMutations(transaction)
      ])
    /*
     * One atomic commit per logical transition: SQLite batches row changes in
     * one transaction; localStorage batches collection strings in one WAL
     * envelope. Every projection changes or none does.
     */
    const batch = resolvedBackend.kind === "opfs" ? resolvedBackend : transactional
    if (batch === undefined) {
      await fanOut()
      return
    }
    /*
     * Between begin and commit every collection write accumulates in the
     * backend's transaction, so every projection changes or none does
     * (docs/persistence.md). The commit runs synchronously as the fan-out
     * settles — deferring it even a microtask would leave the transaction
     * uncommitted when the next dispatch mutates, which TanStack answers
     * with an optimistic rollback/replay that revisits a revision.
     */
    batch.beginBatch()
    try {
      await fanOut()
      batch.commitBatch()
      if (resolvedBackend.kind === "opfs") await resolvedBackend.flush()
    } catch (error) {
      batch.abortBatch()
      throw error
    }
  }

  const dispatch = (transition: AppTransition): Transaction => {
    const current = session()
    const revision = current.revision + 1
    const createdAt = Date.now()
    const transaction = createTransaction({
      id: `app-transition-${revision}`,
      metadata: { actor: transition.actor, type: transition.type },
      mutationFn: ({ transaction }) => persist(transaction)
    })

    transaction.mutate(() => {
      const activeWorkspaceId = current.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID
      const activeBranchId = current.activeBranchId ?? DEFAULT_BRANCH_ID
      const ensureCardFrame = (cardId: string): Frame => {
        const id = cardFrameId(activeBranchId, cardId)
        const existing = collections.frames.get(id)
        if (existing !== undefined) return existing
        const frame: Frame = {
          id,
          workspaceId: activeWorkspaceId,
          branchId: activeBranchId,
          kind: "card",
          parentFrameId: rootFrameId(activeBranchId),
          cardId,
          presentation: "embedded",
          stateRevision: revision,
          createdAt,
          updatedAt: createdAt,
          revision
        }
        collections.frames.insert(frame)
        return frame
      }
      switch (transition.type) {
        case "composer.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.draft = transition.draft
            draft.revision = revision
          })
          break

        case "message.submitted": {
          const text = transition.text.trim()
          if (text === "" || current.phase !== "idle") return
          collections.messages.insert({
            id: `message-${transition.turnId}-user`,
            role: "user",
            text,
            status: "complete",
            createdAt,
            ordinal: nextOrdinal(collections)
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.draft = ""
            draft.phase = "responding"
            draft.revision = revision
          })
          break
        }

        case "message.response.delta": {
          if (transition.delta === "" || current.phase !== "responding") return
          const messageId = `message-${transition.turnId}-smithers`
          if (collections.messages.get(messageId) === undefined) {
            collections.messages.insert({
              id: messageId,
              role: "smithers",
              text: transition.channel === "text" ? transition.delta : "",
              reasoning: transition.channel === "reasoning" ? transition.delta : undefined,
              status: "complete",
              createdAt,
              ordinal: nextOrdinal(collections)
            })
          } else {
            collections.messages.update(messageId, (draft) => {
              if (transition.channel === "reasoning") {
                draft.reasoning = (draft.reasoning ?? "") + transition.delta
              } else {
                draft.text += transition.delta
              }
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "message.response.completed":
          // A chain turn may legitimately complete with no prose bubble
          // (act rows or a park told the story), so completion settles the
          // phase unconditionally.
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "idle"
            draft.revision = revision
          })
          break

        case "message.response.failed": {
          const messageId = `message-${transition.turnId}-smithers`
          if (collections.messages.get(messageId) === undefined) {
            collections.messages.insert({
              id: messageId,
              role: "smithers",
              text: `I couldn't complete that turn. ${transition.message}`,
              status: "failed",
              createdAt,
              ordinal: nextOrdinal(collections)
            })
          } else {
            collections.messages.update(messageId, (draft) => {
              draft.status = "failed"
              draft.statusDetail = transition.message
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "idle"
            draft.revision = revision
          })
          break
        }

        case "message.retried": {
          // The turn's own answer (and its act rows) make way for the
          // re-run; the user's message stays exactly where it was.
          if (current.phase !== "idle") return
          const userMessage = collections.messages.get(`message-${transition.turnId}-user`)
          if (userMessage === undefined) return
          const answerId = `message-${transition.turnId}-smithers`
          if (collections.messages.get(answerId) !== undefined) {
            collections.messages.delete(answerId)
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "responding"
            draft.revision = revision
          })
          break
        }

        case "message.response.cancelled": {
          const messageId = `message-${transition.turnId}-smithers`
          const detail = transition.detail ?? "Stopped the current response."
          if (collections.messages.get(messageId) !== undefined) {
            collections.messages.update(messageId, (draft) => {
              draft.status = "interrupted"
              draft.statusDetail = detail
            })
          } else {
            // Killed before the first delta: there is no response to mark
            // up, so say what happened on that turn rather than leaving the
            // user's message hanging with nothing after it — same discipline
            // as `session.turn.orphaned`. A kill must never read as silence.
            collections.messages.insert({
              id: messageId,
              role: "smithers",
              text: detail,
              status: "interrupted",
              createdAt,
              ordinal: nextOrdinal(collections)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "idle"
            draft.revision = revision
          })
          break
        }

        case "session.turn.orphaned": {
          // The restored session claimed a turn was streaming, but the app
          // was closed — that stream is gone. Mark that turn's response
          // interrupted with the honest line; never restore a silently stuck
          // pending surface.
          //
          // The in-flight turn is the most recent user message, and its
          // response lives at the id derived from that turn — resolving it
          // that way (rather than "the last Smithers message") is what keeps
          // the reconciliation honest: if the app died between the submit and
          // the first delta there is no response yet, and an earlier turn that
          // genuinely completed must not be relabelled as interrupted.
          if (current.phase !== "responding") return
          const inFlight = [...collections.messages.values()]
            .filter((message) => message.role === "user")
            .sort((left, right) => left.ordinal - right.ordinal)
            .at(-1)
          const turnId = inFlight?.id.match(/^message-(.+)-user$/)?.[1]
          const orphaned = turnId === undefined
            ? undefined
            : collections.messages.get(`message-${turnId}-smithers`)
          if (orphaned !== undefined) {
            collections.messages.update(orphaned.id, (draft) => {
              draft.status = "interrupted"
              draft.statusDetail = "That turn was interrupted when the app closed."
            })
          } else if (turnId !== undefined) {
            // Died before the first delta: the turn has no response at all.
            // Say so on that turn rather than leaving the user's message
            // hanging with nothing after it (Launch Checklist B-1 asks for
            // restored work to be *correctly described*, not merely unstuck).
            collections.messages.insert({
              id: `message-${turnId}-smithers`,
              role: "smithers",
              text: "That turn was interrupted when the app closed.",
              status: "interrupted",
              createdAt,
              ordinal: nextOrdinal(collections)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "idle"
            draft.revision = revision
          })
          break
        }

        case "conversation.reset": {
          const keys = [...collections.messages.keys()]
          if (keys.length > 0) collections.messages.delete(keys)
          // A reset conversation is empty — it does not re-seed a welcome.
          const cardKeys = [...collections.cards.keys()]
          if (cardKeys.length > 0) collections.cards.delete(cardKeys)
          const cardFrameKeys = [...collections.frames.values()].filter((frame) => frame.kind === "card").map((frame) => frame.id)
          if (cardFrameKeys.length > 0) collections.frames.delete(cardFrameKeys)
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.draft = ""
            draft.phase = "idle"
            draft.composerOwner = "user"
            draft.maximizedCardId = null
            draft.activeFrameId = rootFrameId(activeBranchId)
            draft.resetConfirmOpen = false
            draft.revision = revision
          })
          break
        }

        case "conversation.reset.asked":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.resetConfirmOpen = transition.open
            draft.revision = revision
          })
          break

        case "conversation.cleared": {
          // /clear (§2h): the sweep already kept what mattered in world
          // notes; the chat clears and one calm line states what was kept.
          const keys = [...collections.messages.keys()]
          if (keys.length > 0) collections.messages.delete(keys)
          const cardKeys = [...collections.cards.keys()]
          if (cardKeys.length > 0) collections.cards.delete(cardKeys)
          const cardFrameKeys = [...collections.frames.values()].filter((frame) => frame.kind === "card").map((frame) => frame.id)
          if (cardFrameKeys.length > 0) collections.frames.delete(cardFrameKeys)
          collections.messages.insert({
            id: `message-${revision}-cleared`,
            role: "smithers",
            text: transition.kept === 0
              ? "Cleared — there was nothing new worth keeping."
              : `Saved ${transition.kept} note${transition.kept === 1 ? "" : "s"} to ${WORLD_DISPLAY_NAME}. Cleared.`,
            status: "complete",
            createdAt,
            ordinal: 0
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.draft = ""
            draft.phase = "idle"
            draft.composerOwner = "user"
            draft.maximizedCardId = null
            draft.activeFrameId = rootFrameId(activeBranchId)
            draft.revision = revision
          })
          break
        }

        case "card.maximized":
          if (collections.cards.get(transition.id) === undefined) return
          {
            const frame = ensureCardFrame(transition.id)
            const previousFrameId = current.activeFrameId
            if (previousFrameId !== undefined && previousFrameId !== frame.id && collections.frames.get(previousFrameId) !== undefined) {
              collections.frames.update(previousFrameId, (draft) => {
                draft.presentation = "embedded"
                draft.updatedAt = createdAt
                draft.revision = revision
              })
            }
            collections.frames.update(frame.id, (draft) => {
              draft.presentation = "maximized"
              draft.stateRevision = revision
              draft.updatedAt = createdAt
              draft.revision = revision
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.maximizedCardId = transition.id
            draft.activeWorkspaceId = activeWorkspaceId
            draft.activeBranchId = activeBranchId
            draft.activeFrameId = cardFrameId(activeBranchId, transition.id)
            draft.revision = revision
          })
          break

        case "card.minimized":
          if (current.activeFrameId !== undefined && collections.frames.get(current.activeFrameId) !== undefined) {
            collections.frames.update(current.activeFrameId, (draft) => {
              draft.presentation = "embedded"
              draft.updatedAt = createdAt
              draft.revision = revision
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.maximizedCardId = null
            draft.activeWorkspaceId = activeWorkspaceId
            draft.activeBranchId = activeBranchId
            draft.activeFrameId = rootFrameId(activeBranchId)
            draft.revision = revision
          })
          break

        case "frame.navigated": {
          const workspace = collections.workspaces.get(transition.workspaceId)
          const branch = collections.branches.get(transition.branchId)
          const frame = collections.frames.get(transition.frameId)
          if (
            workspace === undefined ||
            branch?.workspaceId !== workspace.id ||
            frame?.workspaceId !== workspace.id ||
            frame.branchId !== branch.id ||
            (frame.cardId !== null && collections.cards.get(frame.cardId) === undefined)
          ) return
          if (current.activeFrameId !== undefined && current.activeFrameId !== frame.id && collections.frames.get(current.activeFrameId) !== undefined) {
            collections.frames.update(current.activeFrameId, (draft) => {
              draft.presentation = "embedded"
              draft.updatedAt = createdAt
              draft.revision = revision
            })
          }
          collections.frames.update(frame.id, (draft) => {
            draft.presentation = frame.kind === "card" ? "maximized" : "embedded"
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.activeWorkspaceId = workspace.id
            draft.activeBranchId = branch.id
            draft.activeFrameId = frame.id
            draft.maximizedCardId = frame.cardId
            draft.revision = revision
          })
          break
        }

        case "frame.forked":
          if (
            collections.branches.get(transition.branch.id) !== undefined ||
            collections.frames.get(transition.rootFrame.id) !== undefined ||
            collections.frames.get(transition.selectedFrame.id) !== undefined ||
            transition.branch.workspaceId !== transition.rootFrame.workspaceId ||
            transition.branch.workspaceId !== transition.selectedFrame.workspaceId ||
            transition.branch.id !== transition.rootFrame.branchId ||
            transition.branch.id !== transition.selectedFrame.branchId
          ) return
          collections.branches.insert(transition.branch)
          collections.frames.insert(transition.rootFrame)
          if (transition.selectedFrame.id !== transition.rootFrame.id) collections.frames.insert(transition.selectedFrame)
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.activeWorkspaceId = transition.branch.workspaceId
            draft.activeBranchId = transition.branch.id
            draft.activeFrameId = transition.selectedFrame.id
            draft.maximizedCardId = transition.selectedFrame.cardId
            draft.revision = revision
          })
          break

        case "devtools.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.devtoolsOpen = transition.open
            draft.revision = revision
          })
          break

        case "surfaces-menu.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.surfacesMenuOpen = transition.open
            draft.revision = revision
          })
          break

        case "connect-menu.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.connectMenuOpen = transition.open
            draft.revision = revision
          })
          break

        case "command.deferred":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.pendingCommand = {
              name: transition.name,
              args: transition.args,
              requirement: transition.requirement,
              requestedAt: createdAt
            }
            draft.revision = revision
          })
          break

        case "command.deferral.cleared":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.pendingCommand = null
            draft.revision = revision
          })
          break

        case "command.ran":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.recentCommands = [
              transition.name,
              ...(draft.recentCommands ?? []).filter((name) => name !== transition.name)
            ].slice(0, 20)
            draft.revision = revision
          })
          break

        case "toolcall.recorded":
          collections.toolCalls.insert({
            id: `toolcall-${revision}`,
            turnId: transition.turnId,
            name: transition.name,
            arguments: transition.arguments,
            result: transition.result,
            createdAt
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "chain.event.appended":
          collections.chainEvents.insert({
            id: `chain-${transition.lineageId}-${transition.seq}`,
            lineageId: transition.lineageId,
            seq: transition.seq,
            event: transition.event,
            createdAt
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "chain.turn.resumed":
          if (current.phase !== "idle") return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "responding"
            draft.revision = revision
          })
          break

        case "repos.selection.needed": {
          // Onboarding's one question: a short welcome plus the chooser
          // card, in the transcript.
          const seedOnly = collections.messages.size === 1 &&
            [...collections.messages.keys()][0]?.endsWith("-welcome-smithers") === true
          if (seedOnly && collections.messages.get(ONBOARDING_MESSAGE_ID) === undefined) {
            const seedKey = [...collections.messages.keys()][0]
            if (seedKey !== undefined) collections.messages.delete(seedKey)
          }
          if (collections.messages.get(ONBOARDING_MESSAGE_ID) === undefined) {
            collections.messages.insert({
              id: ONBOARDING_MESSAGE_ID,
              role: "smithers",
              text:
                "Welcome — before I read anything, choose which repositories I should watch. Nothing else is touched.",
              status: "complete",
              createdAt,
              ordinal: seedOnly ? 0 : nextOrdinal(collections)
            })
          }
          const existingChooser = collections.cards.get(REPO_CHOOSER_CARD_ID)
          let highest = 0
          for (const message of collections.messages.values()) highest = Math.max(highest, message.ordinal)
          for (const card of collections.cards.values()) highest = Math.max(highest, card.ordinal)
          const chooser: Card = {
            id: REPO_CHOOSER_CARD_ID,
            kind: "repo-chooser",
            title: "Choose the repositories Smithers watches",
            status: "active",
            createdAt: existingChooser?.createdAt ?? createdAt,
            ordinal: existingChooser?.ordinal ?? highest + 1,
            payload: {
              candidates: transition.candidates.map((candidate) => ({ ...candidate })),
              selected: existingChooser?.kind === "repo-chooser" ? [...existingChooser.payload.selected] : [],
              via: "onboarding",
              phase: "choosing"
            }
          }
          if (existingChooser === undefined) {
            collections.cards.insert(chooser)
          } else {
            collections.cards.update(REPO_CHOOSER_CARD_ID, (draft) => {
              Object.assign(draft, chooser)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "watched.replaced": {
          const watched: WatchedRepos = {
            id: "watched",
            selected: [...transition.selected],
            selectedAt: transition.selectedAt,
            via: transition.via,
            updatedAt: createdAt,
            revision
          }
          if (collections.watchedRepos.get("watched") === undefined) {
            collections.watchedRepos.insert(watched)
          } else {
            collections.watchedRepos.update("watched", (draft) => {
              Object.assign(draft, watched)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "theme.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.theme = transition.theme
            draft.revision = revision
          })
          applyTheme(transition.theme)
          break

        case "palette.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.palette = transition.palette
            draft.revision = revision
          })
          applyPalette(transition.palette)
          break

        case "composer.control.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.composerOwner = transition.owner
            if (transition.draft !== undefined) draft.draft = transition.draft
            draft.revision = revision
          })
          break

        case "surface.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.surface = transition.surface
            draft.revision = revision
          })
          break

        case "world.document.selected":
          if (collections.worldDocuments.get(transition.id) === undefined) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.selectedWorldDocumentId = transition.id
            draft.revision = revision
          })
          break

        case "world.document.upserted": {
          const document: WorldDocument = {
            ...transition.document,
            updatedAt: createdAt,
            updatedBy: transition.actor,
            revision
          }
          if (collections.worldDocuments.get(document.id) === undefined) {
            collections.worldDocuments.insert(document)
          } else {
            collections.worldDocuments.update(document.id, (draft) => {
              Object.assign(draft, document)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            if (transition.select !== false) draft.selectedWorldDocumentId = document.id
            draft.revision = revision
          })
          break
        }

        case "world.delete.asked": {
          if (transition.id !== null && collections.worldDocuments.get(transition.id) === undefined) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.pendingWorldDeleteId = transition.id
            draft.revision = revision
          })
          break
        }

        case "world.document.removed": {
          if (collections.worldDocuments.get(transition.id) === undefined) return
          collections.worldDocuments.delete(transition.id)
          const remaining = [...collections.worldDocuments.values()].find(
            (document) => document.id !== transition.id
          )
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.selectedWorldDocumentId = remaining?.id ?? null
            // The question this answered is closed with it.
            if (draft.pendingWorldDeleteId === transition.id) draft.pendingWorldDeleteId = null
            draft.revision = revision
          })
          break
        }

        case "connector.local.requested":
          collections.connectorOperations.update("connector-operation", (draft) => {
            draft.phase = "selecting-local-repository"
            draft.requestedAccess = transition.access
            draft.error = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "connector.local.cancelled":
          collections.connectorOperations.update("connector-operation", (draft) => {
            draft.phase = "idle"
            draft.requestedAccess = null
            draft.error = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "connector.local.failed":
          collections.connectorOperations.update("connector-operation", (draft) => {
            draft.phase = "idle"
            draft.requestedAccess = null
            draft.error = transition.message
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "connector.local.connected": {
          const id = `local-repository:${transition.repository.root}`
          const existing = collections.connectors.get(id)
          const connector: LocalRepositoryConnector = {
            id,
            kind: "local-repository",
            status: "connected",
            access: transition.access,
            name: transition.repository.name,
            root: transition.repository.root,
            head: transition.repository.head,
            branch: transition.repository.branch,
            remoteUrl: transition.repository.remoteUrl,
            capabilities: [...repositoryCapabilities(transition.repository.root, transition.access)],
            createdAt: existing?.createdAt ?? createdAt,
            updatedAt: createdAt,
            revision
          }
          if (existing === undefined) {
            collections.connectors.insert(connector)
          } else {
            collections.connectors.update(id, (draft) => {
              Object.assign(draft, connector)
            })
          }
          collections.connectorOperations.update("connector-operation", (draft) => {
            draft.phase = "idle"
            draft.requestedAccess = null
            draft.error = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "connector.access.changed":
          if (collections.connectors.get(transition.id) === undefined) return
          collections.connectors.update(transition.id, (draft) => {
            draft.access = transition.access
            draft.capabilities = [
              ...repositoryCapabilities(draft.root, transition.access)
            ]
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "connector.removal.asked":
          if (transition.id !== null && collections.connectors.get(transition.id) === undefined) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.pendingConnectorRemovalId = transition.id
            draft.revision = revision
          })
          break

        case "connector.removed":
          if (collections.connectors.get(transition.id) === undefined) return
          collections.connectors.delete(transition.id)
          collections.sessions.update(SESSION_ID, (draft) => {
            if (draft.pendingConnectorRemovalId === transition.id) draft.pendingConnectorRemovalId = null
            draft.revision = revision
          })
          break

        case "card.upsert": {
          const existing = collections.cards.get(transition.card.id)
          /*
           * A decided approval owns its id. An approval is a human
           * authorising an action, so a frame from the model's own
           * stream must never be able to un-decide one — and a frame
           * that replaced the card with some other kind would launder
           * the freeze away, so nothing but a new gate displaces it.
           *
           * The freeze is per-decision, not per-card: the chain runtime
           * reuses `chain-approval-<lineage>` for every park on a
           * lineage, so freezing the id would swallow the NEXT ask and
           * strand the run with no gate on screen. A frame naming a
           * different gate is a different question, and it replaces the
           * answered one.
           */
          const decided = decidedApproval(existing)
          if (decided !== undefined) {
            const incoming = transition.card.kind === "approval" ? transition.card : undefined
            if (incoming === undefined || approvalGateKey(incoming) === approvalGateKey(decided)) return
          }
          if (existing === undefined) {
            collections.cards.insert(transition.card)
          } else {
            collections.cards.update(transition.card.id, (draft) => {
              Object.assign(draft, transition.card)
            })
          }
          const frame = ensureCardFrame(transition.card.id)
          collections.frames.update(frame.id, (draft) => {
            draft.stateRevision = revision
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "card.updated":
          if (collections.cards.get(transition.id) === undefined) return
          // A patch carries no gate of its own, so the only thing it can
          // do to a decided approval is reopen the one already answered.
          if (decidedApproval(collections.cards.get(transition.id)) !== undefined) return
          collections.cards.update(transition.id, (draft) => {
            Object.assign(draft, transition.patch)
          })
          for (const frame of collections.frames.values()) {
            if (frame.cardId !== transition.id || frame.branchId !== activeBranchId) continue
            collections.frames.update(frame.id, (draft) => {
              draft.stateRevision = revision
              draft.updatedAt = createdAt
              draft.revision = revision
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "card.approval.decision.pending": {
          const card = collections.cards.get(transition.id)
          if (card === undefined || card.kind !== "approval" || card.status === "acted") return
          collections.cards.update(transition.id, (draft) => {
            if (draft.kind === "approval") {
              draft.payload.pending = true
              draft.payload.error = undefined
            }
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "card.approval.decision.failed": {
          const card = collections.cards.get(transition.id)
          if (card === undefined || card.kind !== "approval" || card.status === "acted") return
          collections.cards.update(transition.id, (draft) => {
            draft.status = "error"
            if (draft.kind === "approval") {
              draft.payload.pending = false
              draft.payload.error = transition.message
            }
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "card.approval.decided": {
          const card = collections.cards.get(transition.id)
          // A failed decision attempt stays retryable, so "error" can still decide.
          if (card === undefined || card.kind !== "approval" || card.status === "acted") return
          collections.cards.update(transition.id, (draft) => {
            draft.status = "acted"
            if (draft.kind === "approval") {
              draft.payload.decision = transition.decision
              draft.payload.decidedAt = transition.decidedAt
              draft.payload.pending = false
              draft.payload.error = undefined
            }
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "identity.session.loaded": {
          const existing = collections.identitySessions.get("identity")
          if (existing === undefined) return
          /*
           * A session that was signed in and is not any more — an expired
           * cookie, a revocation, a sign-out in another tab — leaves the
           * previous account's transcript and balance persisted on screen.
           * "unavailable" is not that: it means the seam could not answer,
           * and the last known state stays honest-but-stale.
           */
          const accountChanged = transition.state === "signed-in" &&
            existing.state === "signed-in" &&
            existing.login !== transition.login
          if (
            (existing.state === "signed-in" && transition.state === "signed-out") ||
            accountChanged
          ) {
            forgetAccountState(collections)
          }
          collections.identitySessions.update("identity", (draft) => {
            draft.state = transition.state
            draft.login = transition.login
            draft.allowlisted = transition.allowlisted
            draft.admin = transition.admin
            if (transition.scopesPlain !== null) draft.scopesPlain = transition.scopesPlain
            if (transition.state !== "signed-in") draft.accessRequested = false
            if (transition.state === "signed-in") draft.accessError = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "identity.access.requested": {
          const identity = collections.identitySessions.get("identity")
          if (identity === undefined || identity.state !== "signed-in") return
          collections.identitySessions.update("identity", (draft) => {
            draft.accessRequested = true
            draft.accessError = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "identity.access.failed": {
          if (collections.identitySessions.get("identity") === undefined) return
          collections.identitySessions.update("identity", (draft) => {
            draft.accessError = transition.message
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "identity.session.cleared": {
          if (collections.identitySessions.get("identity") === undefined) return
          forgetAccountState(collections)
          collections.identitySessions.update("identity", (draft) => {
            draft.state = "signed-out"
            draft.login = null
            draft.allowlisted = false
            draft.admin = false
            draft.accessRequested = false
            draft.accessError = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "billing.refreshed": {
          if (collections.billingAccounts.get("billing") === undefined) return
          collections.billingAccounts.update("billing", (draft) => {
            draft.state = transition.state
            draft.totalUsd = transition.totalUsd
            draft.allowedToStartWork = transition.allowedToStartWork
            draft.lifetimeChargedUsd = transition.lifetimeChargedUsd
            draft.chargeCount = transition.chargeCount
            draft.refreshedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "billing.unavailable": {
          const account = collections.billingAccounts.get("billing")
          if (account === undefined) return
          collections.billingAccounts.update("billing", (draft) => {
            // Keep the last known balance honest-but-stale; only an account
            // that never loaded falls back to plain "unavailable".
            if (draft.state === "unknown") draft.state = "unavailable"
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "toast.shown": {
          const id = `toast-${transition.key}`
          const existing = collections.toasts.get(id)
          const toast: Toast = {
            id,
            key: transition.key,
            title: transition.title,
            status: "running",
            detail: "",
            createdAt: existing?.createdAt ?? createdAt,
            updatedAt: createdAt
          }
          if (existing === undefined) {
            collections.toasts.insert(toast)
          } else {
            collections.toasts.update(id, (draft) => {
              Object.assign(draft, toast)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "toast.resolved": {
          const id = `toast-${transition.key}`
          if (collections.toasts.get(id) === undefined) return
          collections.toasts.update(id, (draft) => {
            draft.status = transition.status
            if (transition.title !== undefined) draft.title = transition.title
            draft.detail = transition.detail
            draft.updatedAt = createdAt
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "toast.dismissed":
          if (collections.toasts.get(transition.id) === undefined) return
          collections.toasts.delete(transition.id)
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "card.removed":
          if (collections.cards.get(transition.id) === undefined) return
          collections.cards.delete(transition.id)
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break

        case "message.steered": {
          const steered = transition.text.trim()
          if (steered === "" || current.phase !== "responding") return
          collections.messages.insert({
            id: `message-steer-${revision}`,
            role: "user",
            text: steered,
            status: "complete",
            createdAt,
            ordinal: nextOrdinal(collections)
          })
          // The turn's prose continues AFTER the steer, so the turn bubble
          // moves below it; deltas keep appending to the same message.
          const turnBubble = collections.messages.get(`message-${transition.turnId}-smithers`)
          if (turnBubble !== undefined) {
            collections.messages.update(turnBubble.id, (draft) => {
              draft.ordinal = nextOrdinal(collections)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.draft = ""
            draft.revision = revision
          })
          break
        }

        case "message.tool.executed": {
          collections.messages.insert({
            id: `message-act-${revision}`,
            role: "smithers",
            text: transition.text,
            act: transition.text,
            status: "complete",
            createdAt,
            ordinal: nextOrdinal(collections)
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "message.claim.substituted": {
          // The turn's whole answer becomes the deterministic line: a
          // partially-suppressed claim is still a claim on screen.
          const messageId = `message-${transition.turnId}-smithers`
          if (collections.messages.get(messageId) === undefined) {
            collections.messages.insert({
              id: messageId,
              role: "smithers",
              text: transition.text,
              status: "complete",
              createdAt,
              ordinal: nextOrdinal(collections)
            })
          } else {
            collections.messages.update(messageId, (draft) => {
              draft.text = transition.text
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "message.appended": {
          collections.messages.insert({
            id: `message-appended-${revision}`,
            role: "smithers",
            text: transition.text,
            ...(transition.action === undefined ? {} : { action: transition.action }),
            status: "complete",
            createdAt,
            ordinal: nextOrdinal(collections)
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        /*
         * The local-app tabs (docs/LOCAL-APP.md "Tabs"): main is seeded and
         * never inserted or removed; every other tab takes the next place
         * in the strip and becomes the active one as it opens.
         */
        case "tab.opened": {
          if (transition.tab.kind === "main" || collections.tabs.get(transition.tab.id) !== undefined) return
          let highest = 0
          for (const tab of collections.tabs.values()) highest = Math.max(highest, tab.ordinal)
          collections.tabs.insert({ ...transition.tab, ordinal: highest + 1 })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.activeTabId = transition.tab.id
            draft.tabMenuOpen = false
            draft.revision = revision
          })
          break
        }

        case "tab.selected":
          if (collections.tabs.get(transition.id) === undefined) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.activeTabId = transition.id
            draft.revision = revision
          })
          break

        case "tab.close.asked": {
          const asked = transition.id === null ? undefined : collections.tabs.get(transition.id)
          if (transition.id !== null && (asked === undefined || asked.kind === "main")) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.pendingTabCloseId = transition.id
            draft.revision = revision
          })
          break
        }

        case "tab.closed": {
          const closing = collections.tabs.get(transition.id)
          if (closing === undefined || closing.kind === "main") return
          // The tab to the left takes over when the closed tab was active.
          const ordered = orderedTabs(collections)
          const index = ordered.findIndex((candidate) => candidate.id === closing.id)
          const fallback = ordered[index - 1]?.id ?? MAIN_TAB_ID
          collections.tabs.delete(closing.id)
          collections.sessions.update(SESSION_ID, (draft) => {
            if ((draft.activeTabId ?? MAIN_TAB_ID) === closing.id) draft.activeTabId = fallback
            if (draft.pendingTabCloseId === closing.id) draft.pendingTabCloseId = null
            draft.revision = revision
          })
          break
        }

        case "tab.menu.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.tabMenuOpen = transition.open
            draft.revision = revision
          })
          break

        case "pty.exited": {
          for (const tab of collections.tabs.values()) {
            if ((tab.kind === "terminal" || tab.kind === "harness") && tab.sessionId === transition.sessionId) {
              collections.tabs.update(tab.id, (draft) => {
                if (draft.kind === "terminal" || draft.kind === "harness") draft.exitCode = transition.code
              })
            }
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        /*
         * A reload replaces the list: rows the server still names update in
         * place, new rows insert, the rest delete. One transaction cannot
         * delete and re-insert the same key ("Unhandled mutation combination:
         * delete-insert"), so a wholesale clear-then-insert threw on every
         * reload whose list overlapped the last one.
         */

        case "harnesses.loaded": {
          const next = new Set<string>(transition.harnesses.map((harness) => harness.id))
          const stale = [...collections.harnesses.keys()].filter((id) => !next.has(id))
          if (stale.length > 0) collections.harnesses.delete(stale)
          for (const harness of transition.harnesses) {
            if (collections.harnesses.get(harness.id) === undefined) collections.harnesses.insert({ ...harness })
            else {
              collections.harnesses.update(harness.id, (draft) => {
                Object.assign(draft, harness)
              })
            }
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }

        case "repos.loaded": {
          const next = new Set(transition.repos.map((repo) => repo.id))
          const stale = [...collections.repos.keys()].filter((id) => !next.has(id))
          if (stale.length > 0) collections.repos.delete(stale)
          for (const repo of transition.repos) {
            if (collections.repos.get(repo.id) === undefined) collections.repos.insert({ ...repo })
            else {
              collections.repos.update(repo.id, (draft) => {
                Object.assign(draft, repo)
              })
            }
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.revision = revision
          })
          break
        }
      }

      collections.transitions.insert({
        id: `transition-${revision}`,
        revision,
        actor: transition.actor,
        type: transition.type,
        payload: transitionPayload(transition),
        createdAt
      })
      /*
       * Retention (docs/persistence.md): the log collections compact inside
       * the appending transaction, so the bound is part of the atomic commit
       * and a crash can never leave a half-swept log.
       */
      const staleTransitions = staleLogKeys(
        [...collections.transitions.values()],
        MAX_TRANSITION_RECORDS,
        (record) => record.revision
      )
      if (staleTransitions.length > 0) collections.transitions.delete(staleTransitions)
      const staleToolCalls = staleLogKeys(
        [...collections.toolCalls.values()],
        MAX_TOOL_CALL_RECORDS,
        (record) => record.createdAt
      )
      if (staleToolCalls.length > 0) collections.toolCalls.delete(staleToolCalls)
      const staleChainEvents = staleLogKeys(
        [...collections.chainEvents.values()],
        MAX_CHAIN_EVENT_RECORDS,
        (record) => record.createdAt
      )
      if (staleChainEvents.length > 0) collections.chainEvents.delete(staleChainEvents)
    })

    return transaction
  }

  // Boot reconciliation: a persisted "responding" phase means the app went
  // away mid-turn — no done frame can ever arrive for that stream. Name it
  // through the dispatcher (journaled, actor system) instead of restoring a
  // silently stuck pending surface (Launch Checklist B-1).
  // Awaited like every other boot write in `seed`: the reconciliation is durable
  // before the store is handed out, and its persistence failure surfaces as a
  // rejected boot rather than an unhandled rejection nobody sees.
  if (collections.sessions.get(SESSION_ID)?.phase === "responding") {
    await dispatch({ type: "session.turn.orphaned", actor: "system" }).isPersisted.promise
  }

  /*
   * Boot reconciliation: a question is not state either. A pending
   * `/world.delete` confirm that survived a restart opened its modal over an
   * app the user had not asked anything of — and the overlay swallowed every
   * pointer press, so the whole app was unreachable. An unanswered question
   * is dropped, never re-asked.
   */
  if (collections.sessions.get(SESSION_ID)?.pendingWorldDeleteId != null) {
    await dispatch({ type: "world.delete.asked", actor: "system", id: null }).isPersisted.promise
  }

  // Boot reconciliation: toasts are notifications, not state — a toast left
  // behind by a closed session would resurrect a "running" notice for work
  // that is gone. They never survive a restart.
  for (const key of [...collections.toasts.keys()]) {
    await dispatch({ type: "toast.dismissed", actor: "system", id: key }).isPersisted.promise
  }

  /*
   * Boot reconciliation for the tabs: a terminal or harness tab names a PTY
   * session of the server that is gone with the last launch, and a card tab
   * whose card was cleared has nothing to show. Both close, through the
   * dispatcher, so the strip never opens onto a dead process. The selected
   * tab falls back to main when it no longer exists, and neither the `+`
   * menu nor a pending close question survives a restart (a question is
   * not state).
   */
  for (const tab of orderedTabs(collections)) {
    const stale = tab.kind === "terminal" || tab.kind === "harness" ||
      (tab.kind === "card" && collections.cards.get(tab.cardId) === undefined)
    if (stale) await dispatch({ type: "tab.closed", actor: "system", id: tab.id }).isPersisted.promise
  }
  if (collections.tabs.get(collections.sessions.get(SESSION_ID)?.activeTabId ?? MAIN_TAB_ID) === undefined) {
    await dispatch({ type: "tab.selected", actor: "system", id: MAIN_TAB_ID }).isPersisted.promise
  }
  if (collections.sessions.get(SESSION_ID)?.tabMenuOpen === true) {
    await dispatch({ type: "tab.menu.toggled", actor: "system", open: false }).isPersisted.promise
  }
  if (collections.sessions.get(SESSION_ID)?.pendingTabCloseId != null) {
    await dispatch({ type: "tab.close.asked", actor: "system", id: null }).isPersisted.promise
  }

  /*
   * A degraded launch runs on a memory store: the transcript is empty and
   * nothing typed in this session will survive it. Refusing to read or
   * overwrite the recorded store is the right call, but the person looking at
   * the empty surface has to be told why, or an honest recovery reads as
   * silent data loss. The failure toast is the one notice that stays until
   * dismissed, which is what this state needs — it is true for the whole
   * session, not for 300ms.
   *
   * Raised after the stale-toast sweep above so it is not swept with them.
   */
  if (resolved.degraded) {
    await dispatch({
      type: "toast.shown",
      actor: "system",
      key: "store.degraded",
      title: "This session will not be saved"
    }).isPersisted.promise
    await dispatch({
      type: "toast.resolved",
      actor: "system",
      key: "store.degraded",
      status: "failed",
      title: "This session will not be saved",
      detail:
        "The saved conversation could not be opened, so this session is running in memory. Nothing typed now will be kept. The saved conversation is untouched and returns on the next launch."
    }).isPersisted.promise
  }

  return {
    collections,
    dispatch,
    persistenceMode: resolved.mode,
    persistenceDegraded: resolved.degraded,
    session,
    worldStateSnapshot,
    agentContextSnapshot,
    dispose: resolvedBackend.kind === "opfs" ? () => void resolvedBackend.close() : undefined
  }
}
