import { CardPatchSchema, CardPlanItemSchema, CardSchema } from "smithers-shared/Cards"
import { HARNESS_IDS, HarnessSchema, RepoSchema } from "smithers-shared/LocalApp"
import type { Harness, Repo } from "smithers-shared/LocalApp"
import { REPOSITORY_ACCESS_VALUES } from "smithers-shared/NativeRepository"
import type { LocalRepositoryInspection, RepositoryAccess } from "smithers-shared/NativeRepository"
import { z } from "zod"

export { CardPatchSchema, CardPlanItemSchema, CardSchema }
import type { Card, CardPatch } from "smithers-shared/Cards"
export type { Card, CardPatch, CardPlanItem } from "smithers-shared/Cards"
export { HARNESS_IDS, HarnessSchema, RepoSchema }
export type { Harness, Repo }

export const ActorSchema = z.enum(["user", "smithers", "system"])
export type Actor = z.infer<typeof ActorSchema>

export const MessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "smithers"]),
  text: z.string(),
  reasoning: z.string().optional(),
  status: z.enum(["complete", "failed", "interrupted"]),
  statusDetail: z.string().optional(),
  /** A message-ridden action (sign-in rides the opening message; retry rides the failed-OAuth one). */
  action: z.object({ flow: z.string(), label: z.string() }).optional(),
  /** A one-line visible tool act ("Smithers ran /world.new-note") renders as a marker row, not a bubble. */
  act: z.string().optional(),
  createdAt: z.number(),
  ordinal: z.number().int().nonnegative()
})
export type Message = z.infer<typeof MessageSchema>

export const DEFAULT_WORKSPACE_ID = "workspace-main"
export const DEFAULT_BRANCH_ID = "branch-main"

export const rootFrameId = (branchId: string): string => `frame-root:${branchId}`
export const cardFrameId = (branchId: string, cardId: string): string => `frame-card:${branchId}:${cardId}`

export const WorkspaceSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type Workspace = z.infer<typeof WorkspaceSchema>

export const BranchSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  parentBranchId: z.string().nullable(),
  forkedFromFrameId: z.string().nullable(),
  forkedAtRevision: z.number().int().nonnegative().nullable(),
  createdAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type Branch = z.infer<typeof BranchSchema>

export const FrameSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  branchId: z.string(),
  kind: z.enum(["root", "card"]),
  parentFrameId: z.string().nullable(),
  cardId: z.string().nullable(),
  presentation: z.enum(["embedded", "maximized"]),
  stateRevision: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type Frame = z.infer<typeof FrameSchema>

/*
 * The shared toast stack (the 300ms law, 2026-08-09): background work that has
 * not settled within 300ms states what is running on ONE store-backed corner
 * surface; work under 300ms never flashes anything. Toasts are notifications,
 * not state mutations — they never gate the app, and a failure toast is
 * honest and stays until dismissed.
 */
export const ToastSchema = z.object({
  id: z.string(),
  /** The work identity ("repos.first-run"): one toast per background flow. */
  key: z.string(),
  title: z.string(),
  status: z.enum(["running", "ok", "failed"]),
  detail: z.string(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Toast = z.infer<typeof ToastSchema>

/*
 * The world's display name, centralized (will is renaming "world"; the rename
 * is a one-line change HERE when he names it — `world` stays the internal id).
 * Every user-visible label and command summary reads this constant.
 */
export const WORLD_DISPLAY_NAME = "World"

/*
 * Wave 10 (§2a/§2f) — pills are flow BINDINGS, never prompt strings: a
 * suggestion carries the flow it invokes directly, and the suggestion set
 * is DERIVED in App.tsx from live state (the genuinely-next step) — never
 * fabricated, never stored.
 */
export interface Suggestion {
  readonly id: string
  readonly label: string
  readonly flow: string
  readonly args?: string
  readonly emphasis: "primary" | "secondary"
}

/*
 * The color themes (/theme), the axis ORTHOGONAL to light/dark (/dark-mode):
 * a palette names a set of semantic color values, and each one ships both a
 * light and a dark variant in styles/tokens.css. This table is the one typed
 * authority for the keys and labels — the store's validation, the command's
 * argument spec, the /theme picker's swatch list, and the contrast gate all
 * derive from it, so adding a palette is one entry here plus its two CSS
 * blocks (and its swatch preview in cards/ThemePickerCard.tsx).
 */
export const PALETTE_METADATA = [
  { key: "night-owl", label: "Night Owl" },
  { key: "paper", label: "Paper" },
  { key: "fucory", label: "Fucory" },
  { key: "one", label: "One" },
  { key: "github", label: "GitHub" },
  { key: "catppuccin", label: "Catppuccin" },
  { key: "solarized", label: "Solarized" },
  { key: "gruvbox", label: "Gruvbox" },
  { key: "rose-pine", label: "Rosé Pine" }
] as const
export type Palette = (typeof PALETTE_METADATA)[number]["key"]
export const PALETTES = PALETTE_METADATA.map((entry) => entry.key) as unknown as readonly [
  Palette,
  ...Array<Palette>
]
/** The palette a session that has never chosen one gets (and the CSS default). */
export const DEFAULT_PALETTE: Palette = "night-owl"

export const isPalette = (value: string): value is Palette => (PALETTES as ReadonlyArray<string>).includes(value)

export const SessionSchema = z.object({
  id: z.literal("main"),
  draft: z.string(),
  phase: z.enum(["idle", "responding"]),
  theme: z.enum(["light", "dark"]),
  /*
   * The color theme. Optional (missing = DEFAULT_PALETTE) so sessions
   * persisted before the field parse without a schema reset — the same
   * discipline pendingCommand follows below; a zod default
   * would fork the schema's input and output types and break collection
   * inference.
   */
  palette: z.enum(PALETTES).optional(),
  composerOwner: z.enum(["user", "smithers"]),
  surface: z.enum(["chat", "world", "connectors"]),
  selectedWorldDocumentId: z.string().nullable(),
  /** The card currently maximized (a presentation transition; null = embedded). */
  maximizedCardId: z.string().nullable(),
  /** Durable navigation scope; optional only for rows written before frames existed. */
  activeWorkspaceId: z.string().optional(),
  activeBranchId: z.string().optional(),
  activeFrameId: z.string().optional(),
  /** The admin dev-tools panel (§2b/§2d) — only ever true for admin sessions. */
  devtoolsOpen: z.boolean(),
  /** The composer surfaces menu (the /surfaces command's open state). */
  surfacesMenuOpen: z.boolean(),
  /*
   * The composer connect menu's open state. A component is a projection and
   * never an authority, so the menu that used to live in a `useState` lives
   * here — opened and closed through the transition dispatcher with the actor
   * recorded, exactly like surfacesMenuOpen above. Optional (missing = closed)
   * so sessions persisted before the field parse without a schema reset.
   *
   * The requirement reads "boolean default false", and the default lives in
   * `initialSession` below, not in a `z.boolean().default(false)`. A zod
   * default would never run on the rows this actually has to survive: a
   * collection reads its rows straight out of storage on preload and TanStack
   * never validates them (see the version gate in AppStore). The default would
   * only widen the inferred type to a non-optional `boolean` while a session
   * persisted before the field still handed back `undefined`. Every read is
   * `=== true` / `!== true` for that reason.
   */
  connectMenuOpen: z.boolean().optional(),
  /** Admin reset confirmation; optional for sessions persisted before this field. */
  resetConfirmOpen: z.boolean().optional(),
  /*
   * The note `/world.delete` is asking about (§10.6, §28.4). Deleting is not
   * undoable, so the flow ASKS and the answer is an act of its own — and the
   * question lives in the store rather than in a component's local state,
   * because a component is a projection and never an authority. Optional so
   * sessions persisted before the field parse without a schema reset.
   */
  pendingWorldDeleteId: z.string().nullable().optional(),
  /** Repository whose disconnect confirmation is open. */
  pendingConnectorRemovalId: z.string().nullable().optional(),
  /*
   * The one deferred command (requirement axis): a user-invoked command whose
   * requirement (e.g. signed-in) was unmet parks HERE while the fulfilling
   * command runs, and resumes when the requirement's predicate flips true.
   * Persisted because sign-in is a full OAuth redirect — the intent must
   * survive the reload. Optional (missing = none) so persisted sessions from
   * before the field parse without a schema reset, like palette above.
   * Latest wins: deferring a second command replaces the first.
   */
  pendingCommand: z
    .object({
      name: z.string(),
      args: z.string().nullable(),
      /** The requirement id the command is waiting on. */
      requirement: z.string(),
      requestedAt: z.number()
    })
    .nullable()
    .optional(),
  /*
   * The user's recently run visible commands, most recent first (capped in
   * the reducer): the slash menu's recency ranking past its cap. Optional
   * (missing = none) so persisted sessions parse without a schema reset.
   */
  recentCommands: z.array(z.string()).optional(),
  /*
   * The local-app tab strip (docs/LOCAL-APP.md "Tabs"). The selected tab,
   * the `+` menu's open state, and the tab a close is asking about all live
   * here for the same reason as connectMenuOpen and pendingWorldDeleteId: a
   * component is a projection, never an authority. Optional (missing =
   * main / closed / none) so sessions persisted before the fields parse.
   */
  activeTabId: z.string().optional(),
  tabMenuOpen: z.boolean().optional(),
  pendingTabCloseId: z.string().nullable().optional(),
  revision: z.number().int().nonnegative()
})
export type Session = z.infer<typeof SessionSchema>

/*
 * The local-app tabs (docs/LOCAL-APP.md "Tabs"). `Tab` is the contract union
 * verbatim; `TabRow` is what the collection stores: the same record plus its
 * place in the strip (creation order) and, for a process tab, the exit code
 * once the PTY ends (undefined while it is alive).
 */
export type Tab =
  | { id: "main"; kind: "main"; title: "Smithers" }
  | { id: string; kind: "terminal"; title: string; sessionId: string; cwd: string }
  | { id: string; kind: "harness"; title: string; sessionId: string; harnessId: Harness["id"]; cwd: string }
  | { id: string; kind: "card"; title: string; cardId: string }

const tabRowShape = {
  ordinal: z.number().int().nonnegative()
}
const processTabShape = {
  ...tabRowShape,
  sessionId: z.string(),
  cwd: z.string(),
  exitCode: z.number().nullable().optional()
}

export const TabSchema = z.discriminatedUnion("kind", [
  z.object({ ...tabRowShape, id: z.literal("main"), kind: z.literal("main"), title: z.literal("Smithers") }),
  z.object({ ...processTabShape, id: z.string(), kind: z.literal("terminal"), title: z.string() }),
  z.object({
    ...processTabShape,
    id: z.string(),
    kind: z.literal("harness"),
    title: z.string(),
    harnessId: z.enum(HARNESS_IDS)
  }),
  z.object({ ...tabRowShape, id: z.string(), kind: z.literal("card"), title: z.string(), cardId: z.string() })
])
export type TabRow = z.infer<typeof TabSchema>

export const MAIN_TAB_ID = "main"

export const mainTab = (): TabRow => ({ id: "main", kind: "main", title: "Smithers", ordinal: 0 })

/*
 * The watched-repos selection (Wave 10): a local mirror of the identity
 * seam's GET /api/identity/watched answer. `selected: null` = never chosen (a real
 * distinct state, NOT "all repos"); an empty array = deliberately chose none.
 */
export const WatchedReposSchema = z.object({
  id: z.literal("watched"),
  selected: z.array(z.string()).nullable(),
  selectedAt: z.string().nullable(),
  via: z.enum(["onboarding", "command", "agent"]).nullable(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type WatchedRepos = z.infer<typeof WatchedReposSchema>

/*
 * The tool-call stream the admin dev-tools panel reads (Wave 10, §2b): the
 * full arguments AND result of every agent tool act. Persisted like
 * everything else, recorded with actor smithers, and rendered ONLY in the
 * admin panel — the transcript itself never carries raw payloads.
 */
export const ToolCallRecordSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  name: z.string(),
  arguments: z.string(),
  result: z.string(),
  createdAt: z.number()
})
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>

export const TransitionRecordSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  actor: ActorSchema,
  type: z.string(),
  payload: z.string(),
  createdAt: z.number()
})
export type TransitionRecord = z.infer<typeof TransitionRecordSchema>

/*
 * One chain journal event (DESIGN.md §14) — the durable evidence of a chain
 * turn. `event` is the @smthrs/chain Event as plain JSON: stored opaque here
 * because state schemas stay runtime-free, and schema-validated by the chain
 * journal layer on read. `seq` orders events within one lineage. This
 * collection is the app-layer stand-in for the flows engine journal; when the
 * engine mounts it becomes a sync-fed projection and readers do not change.
 */
export const ChainEventRecordSchema = z.object({
  id: z.string(),
  lineageId: z.string(),
  seq: z.number().int().nonnegative(),
  event: z.unknown(),
  createdAt: z.number()
})
export type ChainEventRecord = z.infer<typeof ChainEventRecordSchema>

export const WorldDocumentSchema = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  body: z.string(),
  links: z.array(z.string()),
  tags: z.array(z.string()),
  sources: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  updatedAt: z.number(),
  updatedBy: ActorSchema,
  revision: z.number().int().nonnegative()
})
export type WorldDocument = z.infer<typeof WorldDocumentSchema>

export const RepositoryCapabilityPatternSchema = z.object({
  action: z.enum(["fs:read", "fs:write"]),
  resource: z.string()
})
export type RepositoryCapabilityPattern = z.infer<typeof RepositoryCapabilityPatternSchema>

export const LocalRepositoryConnectorSchema = z.object({
  id: z.string(),
  kind: z.literal("local-repository"),
  status: z.literal("connected"),
  access: z.enum(REPOSITORY_ACCESS_VALUES),
  name: z.string(),
  root: z.string(),
  head: z.string().nullable(),
  branch: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  capabilities: z.array(RepositoryCapabilityPatternSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type LocalRepositoryConnector = z.infer<typeof LocalRepositoryConnectorSchema>

export const ConnectorOperationSchema = z.object({
  id: z.literal("connector-operation"),
  phase: z.enum(["idle", "selecting-local-repository"]),
  requestedAccess: z.enum(REPOSITORY_ACCESS_VALUES).nullable(),
  error: z.string().nullable(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type ConnectorOperation = z.infer<typeof ConnectorOperationSchema>

/*
 * The identity session record: one row, driven only by real answers from the
 * identity seam (GET /api/auth/session). "unknown" is pre-load; "unavailable"
 * is an honest seam failure — neither changes the chat, because neither is a
 * definitive answer about the person. Signed-out and non-allowlisted are
 * definitive and change what the chat CONTAINS (the opening Smithers message
 * carries the one available action) — never which page exists.
 */
export const IdentitySessionSchema = z.object({
  id: z.literal("identity"),
  state: z.enum(["unknown", "signed-out", "signed-in", "unavailable"]),
  login: z.string().nullable(),
  allowlisted: z.boolean(),
  admin: z.boolean(),
  accessRequested: z.boolean(),
  accessError: z.string().nullable(),
  /** Plain-words scope list fetched from GET /api/auth/scopes; null = honest fallback copy. */
  scopesPlain: z.string().nullable(),
  updatedAt: z.number(),
  revision: z.number().int().nonnegative()
})
export type IdentitySession = z.infer<typeof IdentitySessionSchema>

/*
 * The billing record: one row, dollars only (no credit abstraction). Chat is
 * complimentary during the alpha (the billing seam records true cost, debits
 * zero), so a definitive $0 NEVER pauses the composer or the chat — the pause
 * discipline applies only to non-complimentary (paid) work, and the dollar
 * balance chip stays visible either way.
 */
export const BillingAccountSchema = z.object({
  id: z.literal("billing"),
  state: z.enum(["unknown", "ok", "low", "empty", "unavailable"]),
  totalUsd: z.string().nullable(),
  allowedToStartWork: z.boolean(),
  lifetimeChargedUsd: z.string().nullable(),
  chargeCount: z.number().int().nonnegative(),
  refreshedAt: z.number().nullable(),
  revision: z.number().int().nonnegative()
})
export type BillingAccount = z.infer<typeof BillingAccountSchema>

export type AppTransition =
  | { type: "composer.changed"; actor: Actor; draft: string }
  | { type: "message.submitted"; actor: "user" | "smithers"; turnId: string; text: string }
  | {
    type: "message.response.delta"
    actor: "smithers"
    turnId: string
    channel: "text" | "reasoning"
    delta: string
  }
  | {
    type: "message.response.completed"
    actor: "smithers"
    turnId: string
  }
  | {
    type: "message.response.failed"
    actor: "system"
    turnId: string
    message: string
  }
  | {
    /*
     * /retry re-RUNS the last turn: the answer that turn produced is
     * dropped and the same turn id launches again. Re-SENDING the prompt
     * instead appended a second user bubble per retry, so the transcript
     * grew a duplicate pair every time and every retry re-sent a longer
     * history than the one before it.
     */
    type: "message.retried"
    actor: "user"
    turnId: string
  }
  | {
    type: "message.response.cancelled"
    // "user" pressed stop; "system" is a server-side kill ending the stream.
    actor: "user" | "system"
    turnId: string
    /** One honest line naming what was stopped. */
    detail?: string
  }
  | {
    /*
     * Boot reconciliation: the persisted session said a turn was in
     * flight when the app went away, so the stream is orphaned — there
     * is no turnId to cancel and no done frame will ever arrive. The
     * boot names what happened (the in-flight message is marked
     * interrupted, the phase returns to idle) instead of restoring a
     * silently stuck "responding" surface.
     */
    type: "session.turn.orphaned"
    actor: "system"
  }
  | { type: "conversation.reset"; actor: "user" }
  | { type: "conversation.reset.asked"; actor: "user"; open: boolean }
  | {
    /*
     * /clear (Wave 10, §2h): the sweep already ran and kept what
     * mattered; the chat clears and ONE calm line states what was kept.
     */
    type: "conversation.cleared"
    actor: "user"
    kept: number
  }
  | { type: "theme.changed"; actor: "user" | "system"; theme: Session["theme"] }
  /* The color theme (/theme) — the axis orthogonal to light/dark. */
  | { type: "palette.changed"; actor: "user"; palette: Palette }
  | {
    /* Maximize/minimize an embedded card — a presentation transition, user-only. */
    type: "card.maximized"
    actor: "user"
    id: string
  }
  | { type: "card.minimized"; actor: "user" }
  | {
    type: "frame.navigated"
    actor: "user" | "system"
    workspaceId: string
    branchId: string
    frameId: string
  }
  | {
    type: "frame.forked"
    actor: "user"
    branch: Branch
    rootFrame: Frame
    selectedFrame: Frame
  }
  | {
    /* The admin dev-tools panel opens/closes (registered only for admins). */
    type: "devtools.toggled"
    actor: "user"
    open: boolean
  }
  | {
    /* The composer surfaces menu opens/closes (the surfaces command). */
    type: "surfaces-menu.toggled"
    actor: "user"
    open: boolean
  }
  | {
    /* The composer connect menu opens/closes (trigger, Escape, outside press). */
    type: "connect-menu.toggled"
    actor: "user"
    open: boolean
  }
  | {
    /*
     * A user-invoked command parked on an unmet requirement (requirement
     * axis): the fulfilling command runs now; this record resumes the
     * original when the requirement's predicate flips true.
     */
    type: "command.deferred"
    actor: "user"
    name: string
    args: string | null
    requirement: string
  }
  | {
    /* The deferred command resumed (or went stale) — the parking spot clears. */
    type: "command.deferral.cleared"
    actor: "system"
  }
  | {
    /* A visible command ran for the user — the slash menu's recency signal. */
    type: "command.ran"
    actor: "user"
    name: string
  }
  | {
    /* The full-fidelity record of one agent tool act (dev-tools panel only). */
    type: "toolcall.recorded"
    actor: "smithers"
    turnId: string
    name: string
    arguments: string
    result: string
  }
  | {
    /* One chain journal event appended; seq is per lineage (DESIGN.md §14). */
    type: "chain.event.appended"
    actor: "smithers" | "system"
    lineageId: string
    seq: number
    event: unknown
  }
  | {
    /*
     * A parked chain lineage resumes after an approval decision: the
     * session re-enters responding for the same turn id (DESIGN.md §14).
     */
    type: "chain.turn.resumed"
    actor: "system"
    turnId: string
  }
  | {
    type: "composer.control.changed"
    actor: "smithers" | "system"
    owner: Session["composerOwner"]
    draft?: string
  }
  | {
    type: "surface.changed"
    actor: Actor
    surface: Session["surface"]
  }
  | {
    type: "world.document.selected"
    actor: Actor
    id: string
  }
  | {
    type: "world.document.upserted"
    actor: Actor
    document: Omit<WorldDocument, "updatedAt" | "updatedBy" | "revision">
    /*
     * false = write without stealing the world surface's selection. The
     * user-facing editor keeps the default; agent memory writes pass
     * false so a background remember never moves what the human reads.
     */
    select?: boolean
  }
  | {
    type: "world.document.removed"
    actor: Actor
    id: string
  }
  | {
    /*
     * The delete question, asked and answered (§10.6). `id: null` is the
     * answer "no" — the dialog closes and the note stays.
     */
    type: "world.delete.asked"
    actor: Actor
    id: string | null
  }
  | {
    type: "connector.local.requested"
    actor: "user"
    access: RepositoryAccess
  }
  | {
    type: "connector.local.cancelled"
    actor: "user" | "system"
  }
  | {
    type: "connector.local.failed"
    actor: "system"
    message: string
  }
  | {
    type: "connector.local.connected"
    actor: "system"
    access: RepositoryAccess
    repository: LocalRepositoryInspection
  }
  | {
    type: "connector.access.changed"
    actor: "user"
    id: string
    access: RepositoryAccess
  }
  | { type: "connector.removal.asked"; actor: "user"; id: string | null }
  | {
    type: "connector.removed"
    actor: "user"
    id: string
  }
  | { type: "card.upsert"; actor: Actor; card: Card }
  | { type: "card.updated"; actor: Actor; id: string; patch: CardPatch }
  | {
    type: "card.approval.decision.pending"
    actor: "user"
    id: string
  }
  | {
    type: "card.approval.decision.failed"
    actor: "system"
    id: string
    message: string
  }
  | {
    type: "card.approval.decided"
    actor: "user"
    id: string
    decision: "approved" | "denied"
    decidedAt: number
  }
  | {
    type: "identity.session.loaded"
    actor: "system"
    state: "signed-out" | "signed-in" | "unavailable"
    login: string | null
    allowlisted: boolean
    admin: boolean
    scopesPlain: string | null
  }
  | { type: "identity.access.requested"; actor: "user" }
  | { type: "identity.access.failed"; actor: "system"; message: string }
  | { type: "identity.session.cleared"; actor: "user" }
  | {
    type: "billing.refreshed"
    actor: "system"
    state: "ok" | "low" | "empty"
    totalUsd: string
    allowedToStartWork: boolean
    lifetimeChargedUsd: string
    chargeCount: number
  }
  | { type: "billing.unavailable"; actor: "system" }
  | {
    /* The 300ms toast law: slow background work states what is running. */
    type: "toast.shown"
    actor: "system"
    key: string
    title: string
  }
  | {
    /* Settled: ok resolves (auto-dismisses); failed stays honest until dismissed. */
    type: "toast.resolved"
    actor: "system"
    key: string
    status: "ok" | "failed"
    /** The settled title, so a done toast stops reading as still running. */
    title?: string
    detail: string
  }
  | { type: "toast.dismissed"; actor: "user" | "system"; id: string }
	| {
			/*
			 * First login with no watched-repos selection yet — open the
			 * repo-chooser card in the transcript with the inline candidates.
			 */
			type: "repos.selection.needed";
			actor: "system";
			candidates: ReadonlyArray<{
				fullName: string;
				private: boolean;
				pushedAt: string | null;
				openIssues: number;
			}>;
	  }
	| {
			/* The watched-repos selection changed (onboarding, /repos.watch, or asking). */
			type: "watched.replaced";
			actor: Actor;
			selected: string[];
			selectedAt: string | null;
			via: "onboarding" | "command" | "agent" | null;
	  }
	| { type: "card.removed"; actor: Actor; id: string }
  | {
    /* The visible one-line record of an agent tool execution. */
    type: "message.tool.executed"
    actor: "smithers"
    turnId: string
    text: string
  }
  | {
    /*
     * Mid-turn input admitted as steering (DESIGN.md §14): the user's
     * words render as their own bubble without touching the turn phase;
     * the running chain drains them at its next link boundary.
     */
    type: "message.steered"
    actor: "user"
    turnId: string
    text: string
  }
  | {
    /*
     * Wave 12 §1 — the deterministic claim surface. A turn that launched a
     * run does not get to narrate it: the client replaces the model's prose
     * for that turn with the one line it is willing to stand behind. Actor
     * system, journaled, so the substitution is a recorded act rather than
     * an invisible edit.
     */
    type: "message.claim.substituted"
    actor: "system"
    turnId: string
    text: string
  }
  | {
    /* A complete one-line Smithers message (admin results, honest states, auth replies). */
    type: "message.appended"
    actor: "system"
    text: string
    /** The action that rides the message (sign-in, request access, retry). */
    action?: { flow: string; label: string }
  }
  /* The local-app tabs (docs/LOCAL-APP.md "Tabs"). */
  | { type: "tab.opened"; actor: "user"; tab: Tab }
  | { type: "tab.selected"; actor: Actor; id: string }
  | {
    /* The close question for a tab whose process is alive; `id: null` answers "keep it". */
    type: "tab.close.asked"
    actor: Actor
    id: string | null
  }
  | { type: "tab.closed"; actor: "user" | "system"; id: string }
  | { type: "tab.menu.toggled"; actor: Actor; open: boolean }
  | { type: "pty.exited"; actor: "system"; sessionId: string; code: number | null }
  | { type: "harnesses.loaded"; actor: "system"; harnesses: ReadonlyArray<Harness> }
  | { type: "repos.loaded"; actor: "system"; repos: ReadonlyArray<Repo> }

export const initialSession = (theme: Session["theme"]): Session => ({
  id: "main",
  draft: "",
  phase: "idle",
  theme,
  palette: DEFAULT_PALETTE,
  composerOwner: "user",
  surface: "chat",
  selectedWorldDocumentId: "world-home",
  maximizedCardId: null,
  activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  activeBranchId: DEFAULT_BRANCH_ID,
  activeFrameId: rootFrameId(DEFAULT_BRANCH_ID),
  devtoolsOpen: false,
  surfacesMenuOpen: false,
  connectMenuOpen: false,
  resetConfirmOpen: false,
  pendingWorldDeleteId: null,
  pendingConnectorRemovalId: null,
  activeTabId: MAIN_TAB_ID,
  tabMenuOpen: false,
  pendingTabCloseId: null,
  revision: 0
})

export const initialWorldDocuments = (createdAt = Date.now()): ReadonlyArray<WorldDocument> => [
  {
    id: "world-home",
    path: "World.md",
    title: "World",
    body: "# World\n\n",
    links: [],
    tags: [],
    sources: ["system:bootstrap"],
    confidence: 1,
    updatedAt: createdAt,
    updatedBy: "system",
    revision: 0
  }
]

export const initialConnectorOperation = (createdAt = Date.now()): ConnectorOperation => ({
  id: "connector-operation",
  phase: "idle",
  requestedAccess: null,
  error: null,
  updatedAt: createdAt,
  revision: 0
})

export const initialIdentitySession = (createdAt = Date.now()): IdentitySession => ({
  id: "identity",
  state: "unknown",
  login: null,
  allowlisted: false,
  admin: false,
  accessRequested: false,
  accessError: null,
  scopesPlain: null,
  updatedAt: createdAt,
  revision: 0
})

export const initialBillingAccount = (): BillingAccount => ({
  id: "billing",
  state: "unknown",
  totalUsd: null,
  allowedToStartWork: true,
  lifetimeChargedUsd: null,
  chargeCount: 0,
  refreshedAt: null,
  revision: 0
})

/*
 * Wave 14 §1: there is no seeded opening message, in either auth state.
 *
 * A generic "Hey — I'm Smithers, tell me what you're working on" rendered as
 * the OPENING message before the honest content arrived, and the opening
 * message is the one the product is judged by. Signed out, the opening (and
 * only) message IS the auth conversation state — App.tsx derives it, nothing
 * is seeded under it. Signed in and never-chosen, the FIRST message is the
 * repo chooser's welcome; signed in with a selection, the transcript opens
 * clean. A filler line ahead of either is invention, because it claims a
 * conversation before there is one.
 *
 * That leaves the transcript empty while the first-run watched read is in
 * flight. Empty-while-loading is a valid state: the 300ms toast law already
 * says out loud what is running ("Reading your repositories…"), so the wait is
 * narrated by the toast rather than papered over by a message that says
 * nothing true.
 */
