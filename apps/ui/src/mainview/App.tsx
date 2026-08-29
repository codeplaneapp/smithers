import {
  Badge,
  Button,
  ChatComposer,
  ChatMessage,
  ChatTranscript,
  EmptyState,
  FileTree,
  Marker,
  Reasoning,
  SmithersUiStyles,
  Suggestion,
  SuggestionGroup
} from "@smthrs/ui"
import { MarkdownEditor, MarkdownEditorStyles } from "@smthrs/ui/adapters/markdown-editor"
import { useLiveQuery } from "@tanstack/react-db"
import {
  BookOpen,
  ChevronDown,
  Copy,
  FolderGit2,
  GitPullRequest,
  HardDrive,
  Moon,
  Plug,
  Plus,
  RotateCcw,
  Server,
  Sparkles,
  Sun,
  Trash2
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { KeyboardEvent, ReactNode, RefObject } from "react"
import { CardView } from "./ChatCards"
import { ConnectorsSurface } from "./ConnectorsSurface"
import { useController } from "./ControllerContext"
import { DevtoolsPanel } from "./DevtoolsPanel"
import { composeRefs, stampFlows, stampTestIds } from "./FlowStamp"

/** The Playwright contract's handle on the composer textarea (LOCAL-APP.md); spread past the prop type's excess check. */
const COMPOSER_INPUT_TEST_ID: Record<string, string> = { "data-testid": "composer-input" }
import { tabOutOf } from "./FocusRing"
import { RichMarkdown } from "./RichMarkdown"
import type { Card, Message, Suggestion as SuggestionBinding } from "./state/AppState"
import { WORLD_DISPLAY_NAME } from "./state/AppState"
import { scrubToolEcho } from "./state/MessageScrub"
import { MAIN_TAB_ID } from "./state/AppState"
import { ConfirmDialog, SurfaceHeader } from "./SurfaceChrome"
import { ChromeBar } from "./tabs/ChromeBar"
import { TabBodies } from "./tabs/TabBodies"
import { timeLabel } from "./Timestamps"
import { ToastStack } from "./ToastStack"
import { useCardRows } from "./state/useCardRows"

const systemNoteLabel = (message: Message): string => {
  if (message.statusDetail !== undefined) return `Turn interrupted — ${message.statusDetail}`
  return message.status === "failed" ? "Turn failed" : "Turn interrupted"
}

type TranscriptEntry =
  | { readonly kind: "message"; readonly message: Message }
  | { readonly kind: "card"; readonly card: Card }

const entryOrdinal = (entry: TranscriptEntry): number =>
  entry.kind === "message" ? entry.message.ordinal : entry.card.ordinal

const entryCreatedAt = (entry: TranscriptEntry): number =>
  entry.kind === "message" ? entry.message.createdAt : entry.card.createdAt

function CopyMessageButton({
  text,
  onCopy
}: {
  readonly text: string
  readonly onCopy: (text: string) => void
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="icon"
      className="message-action"
      data-flow="copy-message"
      aria-label={copied ? "Copied" : "Copy message"}
      title={copied ? "Copied" : "Copy message"}
      onClick={() => {
        onCopy(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <span className="message-action-copied">Copied</span> : <Copy size={12} />}
    </Button>
  )
}

/*
 * The composer's surface menu (§2c′): the surface buttons collapse into ONE
 * compact dropdown so the toolbar never accumulates horizontally. Every
 * entry is a direct command binding (never a prompt string), state-aware,
 * keyboard-complete (ArrowDown opens, arrows move, Enter invokes, Escape
 * closes). `/` remains the full command surface; this is the pointer subset.
 *
 * C-1 (wave 13): the trigger itself is the /surfaces command — the open state
 * lives in the session collection and the button dispatches through the
 * registry, so the affordance and the command are the same act.
 */
function ComposerMenu({
  surface,
  open,
  triggerRef
}: {
  readonly surface: "chat" | "world" | "connectors"
  readonly open: boolean
  /*
   * The trigger is owned here but refocused from two places — this menu's own
   * exits, and the shell's Escape handler — so the shell holds the ref and
   * hands it down. Reaching back through `document` for a node this package
   * renders is a query against our own DOM; a ref IS the handle.
   */
  readonly triggerRef: RefObject<HTMLButtonElement | null>
}) {
  const controller = useController()
  const [highlighted, setHighlighted] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  /* The entries are a fixed list, so index-assigned refs stay aligned with the DOM. */
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  /*
   * A pointer press outside the menu dismisses it.
   *
   * §5.15: dismissing by pointer used to leave focus wherever the press
   * landed, because the item that HAD focus was unmounted with the menu — so
   * a Tab after a pointer dismissal restarted from the transcript viewport.
   * Dismissing returns to the trigger, exactly as Escape does, so the menu
   * has one exit however it is closed.
   */
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const root = menuRef.current
      if (root === null || !(event.target instanceof Node) || root.contains(event.target)) return
      const heldFocus = root.contains(document.activeElement)
      controller.runCommand("surfaces")
      if (!heldFocus) return
      requestAnimationFrame(() => {
        triggerRef.current?.focus()
      })
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [open, controller, triggerRef])

  const entries = [
    {
      flow: "connect",
      label: "Connect",
      icon: <Plug size={14} aria-hidden="true" />,
      active: surface === "connectors"
    },
    {
      flow: "world",
      label: WORLD_DISPLAY_NAME,
      icon: <BookOpen size={14} aria-hidden="true" />,
      active: surface === "world"
    }
  ] as const

  const openMenu = (): void => {
    setHighlighted(0)
    controller.runCommand("surfaces")
    requestAnimationFrame(() => {
      itemRefs.current[0]?.focus()
    })
  }

  const closeMenu = (): void => {
    controller.runCommand("surfaces")
    requestAnimationFrame(() => {
      triggerRef.current?.focus()
    })
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      if (open) {
        closeMenu()
      } else {
        openMenu()
      }
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault()
      closeMenu()
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const next = event.key === "ArrowDown"
        ? (highlighted + 1) % entries.length
        : (highlighted + entries.length - 1) % entries.length
      setHighlighted(next)
      itemRefs.current[next]?.focus()
    }
  }

  return (
    <div className="composer-menu" ref={menuRef}>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        className="composer-action composer-menu-trigger"
        data-flow="surfaces"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Surfaces"
        title="Surfaces"
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <Plug size={14} aria-hidden="true" />
        <ChevronDown size={12} aria-hidden="true" />
      </Button>
      {open ?
        (
          <div className="composer-menu-list" role="menu" aria-label="Surfaces" onKeyDown={onMenuKeyDown}>
            {entries.map((entry, index) => (
              <button
                type="button"
                key={entry.flow}
                ref={(node) => {
                  itemRefs.current[index] = node
                }}
                role="menuitem"
                className="composer-menu-item"
                data-flow={entry.flow}
                data-active={entry.active}
                aria-pressed={entry.active}
                tabIndex={index === highlighted ? 0 : -1}
                onFocus={() => setHighlighted(index)}
                onClick={() => {
                  if (open) controller.runCommand("surfaces")
                  controller.runCommand(entry.flow)
                }}
              >
                {entry.icon}
                {entry.label}
              </button>
            ))}
          </div>
        ) :
        null}
    </div>
  )
}

/*
 * The composer's connect corner (bottom-left): the connection state as a chip,
 * the repository origins as a menu. Disconnected it reads "Connect";
 * connected it names the repository (`+N` for the rest) or the GitHub login.
 * Every entry is a command binding: local repositories pick through
 * connector.add, GitHub through auth.sign-in / repos.watch, Smithers Cloud
 * stays an honest "coming soon", and full management is one entry away
 * through /connect.
 */
function ComposerConnect({
  open,
  triggerRef
}: {
  /* C-1 mirror: the open state is the session's, not this component's. */
  readonly open: boolean
  /* The shell closes this session menu too, so it owns the focus handle. */
  readonly triggerRef: RefObject<HTMLButtonElement | null>
}) {
  const controller = useController()
  const { collections } = controller.store
  const { data: connectorRows } = useLiveQuery(collections.connectors)
  const { data: operationRows } = useLiveQuery(collections.connectorOperations)
  const { data: identityRows } = useLiveQuery(collections.identitySessions)
  const menuRef = useRef<HTMLDivElement>(null)
  /*
   * The entries are built as DATA below so index-assigned refs stay aligned
   * with the DOM through every conditional entry. Arrow keys, Escape, and
   * open-and-focus-the-first-entry read these refs — never `document`, whose
   * only job here would be to find nodes this package itself rendered.
   */
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  /* A pointer press outside the menu dismisses it without moving focus. */
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const root = menuRef.current
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        controller.closeConnectMenu()
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [open, controller])

  const connectors = [...connectorRows].sort((left, right) => left.name.localeCompare(right.name))
  const operation = operationRows.find((candidate) => candidate.id === "connector-operation") ??
    collections.connectorOperations.get("connector-operation")
  const selecting = operation?.phase === "selecting-local-repository"
  const identity = identityRows[0]
  const signedIn = identity?.state === "signed-in"
  const connected = signedIn || connectors.length > 0
  const label = connectors.length > 0
    ? `${connectors[0].name}${connectors.length > 1 ? ` +${connectors.length - 1}` : ""}`
    : signedIn
    ? `GitHub · ${identity?.login ?? "connected"}`
    : "Connect"

  const entries: ReadonlyArray<{
    readonly key: string
    readonly flow: string
    readonly active?: boolean
    readonly disabled?: boolean
    readonly content: ReactNode
    /* The command the entry invokes, and its argument when it takes one. */
    readonly args?: string
  }> = [
    ...connectors.map((connector) => ({
      key: connector.id,
      flow: "connect",
      active: true,
      content: (
        <>
          <FolderGit2 size={14} aria-hidden="true" />
          <span className="composer-connect-name">{connector.name}</span>
          <span className="composer-connect-branch">{connector.branch ?? "detached"}</span>
        </>
      )
    })),
    ...(controller.nativeRepositoriesAvailable
      ? [
        {
          key: "connector.add",
          flow: "connector.add",
          disabled: selecting,
          content: (
            <>
              <HardDrive size={14} aria-hidden="true" />
              {selecting ? "Choosing a repository…" : "Add local repository…"}
            </>
          ),
          args: "read"
        }
      ]
      : []),
    signedIn
      ? {
        key: "repos.watch",
        flow: "repos.watch",
        content: (
          <>
            <GitPullRequest size={14} aria-hidden="true" />
            Choose GitHub repositories…
          </>
        )
      }
      : {
        key: "auth.sign-in",
        flow: "auth.sign-in",
        content: (
          <>
            <GitPullRequest size={14} aria-hidden="true" />
            Connect GitHub…
          </>
        )
      },
    /*
     * §1.1: signed out, sign-in is the ONE offered next step. Both of
     * these need a session — clicking either only defers into the
     * sign-in above it — so presenting them as available work makes
     * the app look like it offers four ways in when it has one.
     */
    ...(signedIn
      ? [
        {
          key: "repos.import",
          flow: "repos.import",
          content: (
            <>
              <Server size={14} aria-hidden="true" />
              Import to Smithers Cloud…
            </>
          )
        },
        {
          key: "connect",
          flow: "connect",
          content: (
            <>
              <Plug size={14} aria-hidden="true" />
              Open connectors
            </>
          )
        }
      ]
      : [])
  ]

  /* The entry indices a keyboard can land on; a disabled entry is skipped. */
  const enabledEntries = entries.flatMap((entry, index) => (entry.disabled === true ? [] : [index]))

  const toggleConnectMenu = (): void => {
    controller.toggleConnectMenu()
    if (!open) {
      requestAnimationFrame(() => {
        itemRefs.current[enabledEntries[0] ?? -1]?.focus()
      })
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault()
      controller.closeConnectMenu()
      triggerRef.current?.focus()
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (enabledEntries.length === 0) return
      const current = enabledEntries.findIndex(
        (index) => itemRefs.current[index] === document.activeElement
      )
      const next = event.key === "ArrowDown"
        ? (current + 1) % enabledEntries.length
        : (current - 1 + enabledEntries.length) % enabledEntries.length
      itemRefs.current[enabledEntries[next] ?? -1]?.focus()
    }
  }

  return (
    <div className="composer-menu composer-connect" ref={menuRef}>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        className="composer-action composer-connect-trigger"
        data-flow="connect"
        data-connected={connected}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={connected ? `Connected: ${label}` : "Connect a repository"}
        title={connected ? "Connected repositories" : "Connect a repository"}
        onClick={toggleConnectMenu}
      >
        {connectors.length > 0 ? <FolderGit2 size={14} aria-hidden="true" /> : <Plug size={14} aria-hidden="true" />}
        <span className="composer-connect-label">{label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </Button>
      {open ?
        (
          <div
            className="composer-menu-list composer-connect-list"
            role="menu"
            aria-label="Repository connections"
            onKeyDown={onMenuKeyDown}
          >
            {entries.map((entry, index) => (
              <button
                type="button"
                key={entry.key}
                ref={(node) => {
                  itemRefs.current[index] = node
                }}
                role="menuitem"
                className="composer-menu-item"
                data-flow={entry.flow}
                data-active={entry.active === true ? "true" : undefined}
                disabled={entry.disabled}
                onClick={() => {
                  controller.closeConnectMenu()
                  if (entry.args === undefined) controller.runCommand(entry.flow)
                  else controller.runCommandArgs(entry.flow, entry.args)
                }}
              >
                {entry.content}
              </button>
            ))}
          </div>
        ) :
        null}
    </div>
  )
}

/*
 * The composer, and everything a keystroke touches.
 *
 * §hot path: the draft is the ONE piece of session state that changes per
 * character, and it used to be read by the shell — so every keystroke
 * re-rendered App, and App renders the entire transcript. The draft
 * subscription lives HERE instead, behind the shell's draft-less projection,
 * so typing re-renders this subtree and nothing above it. The slash menu is
 * part of the same hot path (it is a function of the draft) and moved with it.
 */
function Composer({
  typing,
  surface,
  surfacesMenuOpen,
  connectMenuOpen,
  surfacesTriggerRef,
  connectTriggerRef,
  autoFocus,
  placeholder
}: {
  readonly typing: boolean
  readonly surface: "chat" | "world" | "connectors"
  readonly surfacesMenuOpen: boolean
  readonly connectMenuOpen: boolean
  readonly surfacesTriggerRef: RefObject<HTMLButtonElement | null>
  readonly connectTriggerRef: RefObject<HTMLButtonElement | null>
  readonly autoFocus: boolean
  readonly placeholder: string
}) {
  const controller = useController()
  const { collections } = controller.store
  const { data: draftRows } = useLiveQuery((q) =>
    q
      .from({ session: collections.sessions })
      .select(({ session }) => ({ id: session.id, draft: session.draft }))
  )
  const [slashMenu, setSlashMenu] = useState<{ draft: string; index: number; dismissed: boolean }>({
    draft: "",
    index: 0,
    dismissed: false
  })
  const draft = draftRows[0]?.draft ?? controller.store.session().draft

  const slashQuery = draft.startsWith("/") && !draft.slice(1).includes(" ")
    ? draft.slice(1).toLowerCase()
    : undefined
  /*
   * §5.2: the listing used to be suppressed for the whole duration of a turn,
   * which made `typing -> chat.stop` — the first clause of the recommendation
   * order — unreachable in the shipped UI, and left the composer with no way
   * to invoke any flow mid-turn (the component blocks submit while busy, so
   * Enter only reaches a flow through this menu).
   */
  const slashMatches = slashQuery === undefined ? [] : controller.slashItems(slashQuery)
  const slashMenuLive = slashMenu.draft === draft ? slashMenu : { draft, index: 0, dismissed: false }
  const slashOpen = slashMatches.length > 0 && !slashMenuLive.dismissed
  const slashHighlighted = Math.min(slashMenuLive.index, slashMatches.length - 1)

  const runSlashCommand = (name: string): void => {
    setSlashMenu({ draft: "", index: 0, dismissed: false })
    controller.changeDraft("")
    controller.runCommand(name)
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape" && typing) {
      event.preventDefault()
      controller.runCommand("chat.stop")
      return
    }
    if (!slashOpen) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setSlashMenu({
        draft,
        index: (slashHighlighted + 1) % slashMatches.length,
        dismissed: false
      })
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setSlashMenu({
        draft,
        index: (slashHighlighted + slashMatches.length - 1) % slashMatches.length,
        dismissed: false
      })
      return
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      const command = slashMatches.length === 1 ? slashMatches[0] : slashMatches[slashHighlighted]
      if (command !== undefined) runSlashCommand(command.flow.name)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      setSlashMenu({ draft, index: slashHighlighted, dismissed: true })
    }
  }

  return (
    <>
      {slashOpen ?
        (
          <div className="slash-menu" role="listbox" aria-label="Slash commands">
            {slashMatches.map((item, index) => (
              <button
                type="button"
                key={item.flow.name}
                role="option"
                aria-selected={index === slashHighlighted}
                data-highlighted={index === slashHighlighted ? "true" : "false"}
                data-gold={item.recommended}
                data-flow={item.flow.name}
                className="slash-menu-item"
                onMouseEnter={() => setSlashMenu({ draft, index, dismissed: false })}
                onClick={() => runSlashCommand(item.flow.name)}
              >
                <span className="slash-menu-name">/{item.flow.name}</span>
                <span className="slash-menu-description">{item.flow.summary}</span>
              </button>
            ))}
          </div>
        ) :
        null}
      {
        /*
         * §6.1: Send and Stop are rendered by the composer component,
         * which takes no pass-through attributes, so the law's own
         * marker is stamped here. See LIBRARY-CHANGE-REQUESTS.md.
         */
      }
      <div
        className="composer-flow-stamp"
        ref={composeRefs(
          stampFlows([
            [".sui-chat-composer-send", "send"],
            [".sui-chat-composer-stop", "chat.stop"]
          ]),
          stampTestIds([
            [".sui-chat-composer-input", "composer-input"],
            [".sui-chat-composer-send", "composer-send"]
          ])
        )}
      >
        <ChatComposer
          className="smithers-composer"
          value={draft}
          onValueChange={controller.changeDraft}
          onSubmit={(text) => {
            controller.runCommandArgs("send", text)
          }}
          onStop={() => controller.runCommand("chat.stop")}
          placeholder={placeholder}
          lifecycleStatus={typing ? "submitted" : "ready"}
          textareaProps={{ autoFocus, onKeyDown: onComposerKeyDown, ...COMPOSER_INPUT_TEST_ID }}
          actions={
            <div className="composer-actions">
              <ComposerConnect
                open={connectMenuOpen}
                triggerRef={connectTriggerRef}
              />
              <ComposerMenu
                surface={surface}
                open={surfacesMenuOpen}
                triggerRef={surfacesTriggerRef}
              />
            </div>
          }
        />
      </div>
    </>
  )
}

function App() {
  const controller = useController()
  const { collections } = controller.store
  /*
   * The transcript's order is the QUERY's order (§hot path): sorting a copy of
   * every row on every render made each keystroke O(messages log messages) on
   * top of the render it should not have caused at all. The collection sorts
   * incrementally and hands back rows already in order.
   */
  const { data: messageRows } = useLiveQuery((q) =>
    q.from({ message: collections.messages }).orderBy(({ message }) => message.ordinal)
  )
  /*
   * The shell reads the session WITHOUT the draft.
   *
   * The draft changes on every keystroke, and this subscription carried it —
   * so typing one character re-rendered App, and App renders the whole
   * transcript. The projection is consolidated by the query, so a draft-only
   * write produces no change here at all and the transcript stays still;
   * `Composer` below subscribes to the draft, one component deep, and is the
   * only thing a keystroke re-renders.
   */
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: collections.sessions }).select(({ session }) => ({
      id: session.id,
      phase: session.phase,
      theme: session.theme,
      surface: session.surface,
      selectedWorldDocumentId: session.selectedWorldDocumentId,
      maximizedCardId: session.maximizedCardId,
      devtoolsOpen: session.devtoolsOpen,
      surfacesMenuOpen: session.surfacesMenuOpen,
      connectMenuOpen: session.connectMenuOpen,
      pendingWorldDeleteId: session.pendingWorldDeleteId,
      activeTabId: session.activeTabId,
      tabMenuOpen: session.tabMenuOpen
    }))
  )
  const { data: worldDocumentRows } = useLiveQuery(collections.worldDocuments)
  const cardRows = useCardRows(collections.cards)
  const { data: identityRows } = useLiveQuery(collections.identitySessions)
  const { data: billingRows } = useLiveQuery(collections.billingAccounts)
  const { data: toastRows } = useLiveQuery((q) =>
    q.from({ toast: collections.toasts }).orderBy(({ toast }) => toast.createdAt)
  )
  const { data: watchedRows } = useLiveQuery(collections.watchedRepos)
  /*
   * §10.6: the delete question lives in the store, not here — a component is
   * a projection, never an authority, and the local-state version was
   * bypassed entirely by `/world.delete <id>` typed into the composer.
   */
  /* §28.4: the transcript is destroyed with no undo, so the act asks first. */
  const [confirmReset, setConfirmReset] = useState(false)
  /* The surfaces trigger, refocused by this shell's Escape and by the menu itself. */
  const surfacesTriggerRef = useRef<HTMLButtonElement>(null)
  /* The connect trigger has the same shell-level Escape exit as surfaces. */
  const connectTriggerRef = useRef<HTMLButtonElement>(null)
  const messages = messageRows
  const worldDocuments = [...worldDocumentRows].sort((left, right) => left.path.localeCompare(right.path))
  const session = sessionRows[0] ?? controller.store.session()
  const pendingWorldDelete = worldDocuments.find(
    (document) => document.id === (session.pendingWorldDeleteId ?? null)
  )
  const selectedWorldDocument = worldDocuments.find((document) => document.id === session.selectedWorldDocumentId) ??
    worldDocuments[0]
  const typing = session.phase === "responding"
  const dark = session.theme === "dark"
  const activeTabId = session.activeTabId ?? MAIN_TAB_ID
  const streamingMessageId = typing ? messages[messages.length - 1]?.id : undefined
  const identity = identityRows[0]
  const billing = billingRows[0]
  const toasts = toastRows
  /*
   * One page: the chat. Auth is a conversation state, never a view — a
   * definitive signed-out or non-allowlisted answer opens the transcript
   * with the Smithers message whose action IS the one available step.
   * "Unknown" is not a definitive answer and changes nothing. "Unavailable"
   * IS one about the BUILD: a deployment with no identity seam can never
   * sign in, and pretending otherwise walked live users into empty choosers
   * and dead sign-in flows — so the state names itself up front, once,
   * derived like the rest (never stored, gone the moment a seam answers).
   */
  const authMessage: Message | undefined = identity?.state === "signed-in" && !identity.allowlisted
    ? {
      id: "auth-state",
      role: "smithers",
      text: `${
        identity.accessRequested
          ? "Your request is in — we'll let you know as soon as there's a spot."
          : `You're signed in as ${
            identity.login ?? "a GitHub user"
          }, but Smithers is open to design partners only right now.`
      }${identity.accessError !== null ? `\n\n${identity.accessError}` : ""}${
        identity.accessRequested ? "" : "\n\nType /auth.sign-out to use a different GitHub account."
      }`,
      status: "complete",
      ...(identity.accessRequested
        ? {}
        : { action: { flow: "auth.request-access", label: "Request access" } }),
      createdAt: 0,
      ordinal: 0
    }
    : identity?.state === "unavailable"
    ? {
      id: "auth-state",
      role: "smithers",
      text:
        "This build isn't connected to Smithers' identity service, so GitHub sign-in and repository features are off here. Everything local still works — the World, the browser, local repositories, and workflows on connected work. Use the deployed app for the signed-in experience.",
      status: "complete",
      createdAt: 0,
      ordinal: 0
    }
    : undefined

  /*
   * The one step the auth state offers, named once because it renders twice:
   * inside the message that explains it, and again as the keyboard shortcut
   * below.
   */
  const authAction = authMessage?.action

  /*
   * The suggestion row is DERIVED (§2a/§2f — never stored, never
   * fabricated): the genuinely-next state-derived step when one exists
   * (signed-out → Sign in; never-chosen → Choose repos). An empty pill row
   * is a correct state; a fabricated one is a violation.
   */
  const watched = watchedRows[0]
  const needsSelection = identity?.state === "signed-in" && identity.allowlisted &&
    (watched === undefined || watched.selected === null)
  const suggestions: ReadonlyArray<SuggestionBinding> = needsSelection
    ? [{ id: "choose-repos", label: "Choose repos to watch", flow: "repos.watch", emphasis: "primary" }]
    : []
  // A Vite dev build unlocks the admin chrome (devtools, reset) with no
  // session — dev has no identity seam to grant admin, and the machinery
  // panel is what dev is for. Mirrors the registry snapshot's rule.
  const isAdmin = (identity?.state === "signed-in" && identity.admin) ||
    (import.meta.env.DEV as boolean | string | undefined) === true

  /*
   * §2a″ (wave 12 §4): auth is a conversation STATE, and a state shows only
   * itself. Signed out, the auth message is the whole transcript. Wave 14 §1
   * removed the seeded welcome that used to sit under it, so there is no
   * longer a filler message to filter out here — the transcript is exactly
   * what the session actually said.
   */
  const entries: ReadonlyArray<TranscriptEntry> = [
    ...(authMessage === undefined ? [] : [{ kind: "message", message: authMessage } as const]),
    ...messages.map((message): TranscriptEntry => ({ kind: "message", message })),
    ...[...cardRows].map((card): TranscriptEntry => ({ kind: "card", card }))
  ].sort((left, right) => {
    if (entryOrdinal(left) !== entryOrdinal(right)) return entryOrdinal(left) - entryOrdinal(right)
    return entryCreatedAt(left) - entryCreatedAt(right)
  })

  return (
    // data-flows is the live registry manifest (visible AND hidden names):
    // under commands-are-the-app the registry is not secret — the agent tool
    // lists it to the model — and the launch checklist verifies every
    // data-flow binding against exactly this surface.
    <div
      className="app-shell"
      data-flows={controller.commands.all().map((command) => command.name).join(" ")}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return
        if (event.key === "Escape" && session.maximizedCardId !== null) {
          controller.runCommand("card.minimize")
          return
        }
        // The `+` menu is one more session menu the shell closes on Escape.
        if (event.key === "Escape" && session.tabMenuOpen === true) {
          event.preventDefault()
          controller.runCommand("tab.menu")
          return
        }
        // §21.4 — an open menu closes before anything else the shell owns.
        if (event.key === "Escape" && session.surfacesMenuOpen) {
          event.preventDefault()
          controller.runCommand("surfaces")
          requestAnimationFrame(() => {
            surfacesTriggerRef.current?.focus()
          })
          return
        }
        // §21.4: both menus are session state now, so the shell closes whichever is open.
        if (event.key === "Escape" && session.connectMenuOpen === true) {
          event.preventDefault()
          controller.closeConnectMenu()
          requestAnimationFrame(() => {
            connectTriggerRef.current?.focus()
          })
          return
        }
        // The dev-tools keyboard path (§2b): unregistered for non-admins, so a no-op there.
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "d") {
          event.preventDefault()
          controller.runCommand("admin.devtools")
        }
      }}
    >
      <SmithersUiStyles />
      <MarkdownEditorStyles />

      {/* The chrome bar: the tab strip upper-left, the repo chip and chrome actions right. */}
      <ChromeBar />

      {
        /*
         * The main tab's body IS the chat. Every tab body stays mounted; an
         * inactive one is hidden, never unmounted (docs/LOCAL-APP.md "Tabs").
         */
      }
      <div className="tab-body" data-kind="main" data-testid="tab-body-main" hidden={activeTabId !== MAIN_TAB_ID}>
      <div className="chat-frame" data-pane={session.surface === "chat" ? undefined : session.surface}>
        <div className="chat-column">
          {
            /*
             * The one available step, first in the focus ring.
             *
             * While auth is the conversation state this is the only thing a
             * visitor can do, but the message's own CTA cannot be the document's
             * first tab stop: it renders inside the transcript, and @smthrs/ui
             * wraps the transcript in a scroller viewport that carries
             * tabindex="0". That tabindex is the dependency's keyboard access to
             * a scrollable region and is not ours to delete, and moving the CTA
             * out of the message would take the action away from the state that
             * explains it. So the step renders a second time here, ahead of the
             * scroller, as the control one Tab reaches from the document. It is
             * out of flow and clipped until focused, so the page looks the same
             * and the shortcut appears exactly when it is the thing you are on.
             */
          }
          {authAction !== undefined ?
            (
              <Button
                className="auth-shortcut"
                data-flow={authAction.flow}
                onClick={() => controller.runCommand(authAction.flow)}
              >
                {authAction.label}
              </Button>
            ) :
            null}

          <ChatTranscript
            className="smithers-transcript"
            data-testid="transcript"
            pending={typing}
            pendingLabel="Smithers is responding"
            aria-label="Conversation"
            empty={
              <EmptyState
                className="transcript-empty"
                icon={<Sparkles size={20} />}
                title="Nothing here yet"
                description="Ask Smithers anything to get started."
              />
            }
          >
            {entries.map((entry) =>
              entry.kind === "card" ?
                (
                  <CardView
                    key={entry.card.id}
                    card={entry.card}
                    onDecideApproval={(id, decision) =>
                      controller.runCommandArgs(
                        decision === "approved" ? "approval.approve" : "approval.deny",
                        id
                      )}
                    onGrantConfirm={(id) => controller.runCommandArgs("admin.grant.confirm", id)}
                    onGrantCancel={(id) => controller.runCommandArgs("admin.grant.cancel", id)}
                    onQueueApprove={(login) => controller.runCommandArgs("admin.queue.approve", login)}
                    onRepoToggle={(name) => controller.runCommandArgs("repos.watch.toggle", name)}
                    onReposSelectAll={() => controller.runCommand("repos.watch.all")}
                    onReposSelectNone={() => controller.runCommand("repos.watch.none")}
                    onReposConfirm={() => controller.runCommand("repos.watch.confirm")}
                    maximized={session.maximizedCardId === entry.card.id}
                    onMaximize={(id) => controller.runCommandArgs("card.maximize", id)}
                    onMinimize={() => controller.runCommand("card.minimize")}
                    onOpenInTab={(id) => controller.runCommandArgs("tab.card", id)}
                    onConnectGitHub={() => controller.runCommand("auth.sign-in")}
                    onConnectLocal={() => controller.runCommandArgs("connector.add", "read")}
                    onRunWorkflow={(name) => controller.runCommandArgs("flow.run", name)}
                    onStopRun={(id) => controller.runCommandArgs("flow.run.stop", id)}
                    onRetryRun={(id) => controller.runCommandArgs("flow.run.retry", id)}
                    onChooseWorkflowRepo={(name) => controller.runCommandArgs("flow.repo.choose", name)}
                    worldDocuments={worldDocuments}
                    onChangeWorldDocument={(id, body) => controller.changeWorldDocument(id, body)}
                    onRunCommand={(name, commandArgs) =>
                      commandArgs === undefined
                        ? controller.runCommand(name)
                        : controller.runCommandArgs(name, commandArgs)}
                  />
                ) :
                entry.message.act !== undefined ?
                (
                  <Marker
                    key={entry.message.id}
                    variant="note"
                    className="bubble-system-note tool-act-line"
                  >
                    {entry.message.text}
                  </Marker>
                ) :
                (
                  <ChatMessage
                    className="smithers-chat-message"
                    key={entry.message.id}
                    role={entry.message.role === "user" ? "user" : "assistant"}
                    meta={entry.message.status !== "complete" ?
                      (
                        <Marker variant="note" live className="bubble-system-note">
                          {systemNoteLabel(entry.message)}
                        </Marker>
                      ) :
                      undefined}
                  >
                    {entry.message.reasoning !== undefined && entry.message.reasoning !== "" ?
                      (
                        <Reasoning
                          className="message-reasoning"
                          streaming={entry.message.id === streamingMessageId}
                          title="Reasoning"
                        >
                          <div className="message-reasoning-text">{entry.message.reasoning}</div>
                        </Reasoning>
                      ) :
                      null}
                    {entry.message.text !== "" ?
                      (
                        // scrubToolEcho: a weak model's tool call written into prose
                        // is wire debris, never content — stripped at render only;
                        // the store and dev-tools keep the raw truth.
                        <RichMarkdown
                          className="message-markdown"
                          content={scrubToolEcho(entry.message.text)}
                        />
                      ) :
                      null}
                    {/* The synthetic auth message has no clock time to tell. */}
                    {entry.message.createdAt > 0 ?
                      (
                        <time
                          className="message-time"
                          dateTime={new Date(entry.message.createdAt).toISOString()}
                        >
                          {timeLabel(entry.message.createdAt)}
                        </time>
                      ) :
                      null}
                    {entry.message.action !== undefined ?
                      (
                        <Button
                          className="message-cta"
                          data-flow={entry.message.action.flow}
                          autoFocus={entry.message.id === "auth-state"}
                          onClick={() => controller.runCommand(entry.message.action?.flow ?? "")}
                        >
                          {entry.message.action.label}
                        </Button>
                      ) :
                      null}
                    <span className="message-actions">
                      <CopyMessageButton
                        text={entry.message.text}
                        onCopy={(text) => controller.runCommandArgs("copy-message", text)}
                      />
                      {entry.message.status === "failed" ?
                        (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="message-action"
                            aria-label="Retry turn"
                            title="Retry turn"
                            onClick={() => controller.runCommand("retry")}
                          >
                            <RotateCcw size={12} />
                          </Button>
                        ) :
                        null}
                    </span>
                  </ChatMessage>
                )
            )}
          </ChatTranscript>

          <div className="composer-wrap">
            <SuggestionGroup className="smithers-suggestions">
              {suggestions.map((suggestion) => (
                <Suggestion
                  className="smithers-suggestion"
                  data-gold={suggestion.emphasis === "primary"}
                  data-flow={suggestion.flow}
                  key={suggestion.id}
                  suggestion={suggestion.label}
                  disabled={typing}
                  onClick={() =>
                    suggestion.args === undefined
                      ? controller.runCommand(suggestion.flow)
                      : controller.runCommandArgs(suggestion.flow, suggestion.args)}
                >
                  <Sparkles size={12} />
                  {suggestion.label}
                </Suggestion>
              ))}
            </SuggestionGroup>
            <Composer
              typing={typing}
              surface={session.surface}
              surfacesMenuOpen={session.surfacesMenuOpen}
              connectMenuOpen={session.connectMenuOpen === true}
              surfacesTriggerRef={surfacesTriggerRef}
              connectTriggerRef={connectTriggerRef}
              autoFocus={authMessage === undefined}
              placeholder="Ask Smithers to work on something…"
            />
          </div>

          {
            /*
             * The corner chrome is chat chrome (balance, reset the conversation,
             * theme), so it lives with the conversation rather than floating over
             * the whole window. Anchored to the viewport it sat on top of an open
             * pane's own header and made the pane's back-to-conversation button
             * unclickable; anchored to the chat column it stays exactly where it
             * was whenever the chat is alone, and clears the pane when one is open.
             *
             * It renders LAST because DOM order is focus order and these three
             * controls are chrome, not the conversation. Rendered first they put
             * the theme toggle ahead of the only action a signed-out visitor has.
             * `.corner-chrome` is absolutely positioned, so where it sits in the
             * column changes the tab ring and nothing else.
             */
          }
          <div className="corner-chrome">
            {billing !== undefined && billing.state !== "unknown" ?
              (
                <Button
                  variant="outline"
                  size="sm"
                  className="corner-balance-chip"
                  data-flow="billing.balance"
                  data-empty={billing.state === "empty"}
                  aria-label="Show your balance"
                  title="Show your balance"
                  onClick={() => controller.runCommand("billing.balance")}
                >
                  {billing.state === "unavailable" ? "Balance unavailable" : `$${billing.totalUsd ?? "0"}`}
                </Button>
              ) :
              null}
            {/* The bare reset is admin-only dev tooling (§2); users get /clear. */}
            {isAdmin ?
              (
                <Button
                  variant="outline"
                  size="icon"
                  className="corner-reset-btn"
                  data-flow="reset"
                  aria-label="Reset conversation"
                  title="Reset conversation"
                  onClick={() => setConfirmReset(true)}
                >
                  <RotateCcw size={14} />
                </Button>
              ) :
              null}
            <Button
              variant="outline"
              size="icon"
              className="corner-theme-btn"
              data-flow="dark-mode"
              aria-label="Toggle light and dark mode"
              title="Toggle light and dark mode"
              onClick={() => controller.runCommand("dark-mode")}
            >
              {dark ? <Sun size={14} /> : <Moon size={14} />}
            </Button>
          </div>
        </div>

        {session.surface === "world" ?
          (
            <section className="world-surface embedded-pane" aria-label={`Smithers ${WORLD_DISPLAY_NAME} state`}>
              <SurfaceHeader
                icon={<BookOpen size={17} aria-hidden="true" />}
                title={WORLD_DISPLAY_NAME}
                subtitle="What Smithers currently understands"
                closeCommand="chat"
                onClose={() => controller.runCommand("chat")}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  data-flow="world.new-note"
                  onClick={() => controller.runCommand("world.new-note")}
                >
                  <Plus size={14} aria-hidden="true" />
                  New note
                </Button>
              </SurfaceHeader>

              <div className="world-workspace">
                <aside
                  className="world-sidebar"
                  aria-label={`${WORLD_DISPLAY_NAME} notes`}
                  ref={stampFlows([["button", "world.select"]])}
                >
                  <FileTree
                    nodes={worldDocuments.map((document) => ({
                      path: document.path,
                      label: document.title
                    }))}
                    selected={selectedWorldDocument?.path}
                    onSelect={(path) => {
                      const document = worldDocuments.find((candidate) => candidate.path === path)
                      if (document) controller.runCommandArgs("world.select", document.id)
                    }}
                  />
                </aside>

                <main className="world-document">
                  {selectedWorldDocument ?
                    (
                      <>
                        <div className="world-document-meta">
                          <span>{selectedWorldDocument.path}</span>
                          <div>
                            <Badge variant="outline">
                              {Math.round(selectedWorldDocument.confidence * 100)}% confidence
                            </Badge>
                            <Badge variant="muted">
                              {selectedWorldDocument.sources.length} source
                              {selectedWorldDocument.sources.length === 1 ? "" : "s"}
                            </Badge>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="world-delete-btn"
                              data-flow="world.delete"
                              aria-label={`Delete ${selectedWorldDocument.title}`}
                              title="Delete note"
                              onClick={() => controller.runCommandArgs("world.delete", selectedWorldDocument.id)}
                            >
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        </div>
                        {
                          /*
                           * §21.2: ProseMirror binds Tab to "insert indentation",
                           * so the editor swallowed every forward Tab and a
                           * keyboard user could not get past it. The document's
                           * own Tab order is restored around the region here,
                           * at the mount site — the editor is library code.
                           */
                        }
                        <div
                          className="world-editor-region"
                          onKeyDownCapture={(event) => {
                            tabOutOf(event, event.currentTarget)
                          }}
                        >
                          <MarkdownEditor
                            value={selectedWorldDocument.body}
                            resetKey={selectedWorldDocument.id}
                            aria-label={`Edit ${selectedWorldDocument.title}`}
                            onChange={(body) => controller.changeWorldDocument(selectedWorldDocument.id, body)}
                          />
                        </div>
                      </>
                    ) :
                    (
                      <EmptyState
                        icon={<BookOpen size={20} />}
                        title={`No ${WORLD_DISPLAY_NAME} notes yet`}
                        description="Smithers will keep what it learns here."
                        action={<Button onClick={() => controller.runCommand("world.new-note")}>Create a note</Button>}
                      />
                    )}
                </main>
              </div>
              <ConfirmDialog
                open={pendingWorldDelete !== undefined}
                title={`Delete ${pendingWorldDelete?.title ?? "note"}?`}
                body="This note leaves Smithers' world. You can write it again, but Smithers will treat it as new."
                confirmLabel="Delete"
                destructive
                onConfirm={() => controller.runCommand("world.delete.confirm")}
                onCancel={() => controller.runCommand("world.delete.cancel")}
              />
            </section>
          ) :
          session.surface === "connectors" ?
          <ConnectorsSurface /> :
          null}

        {/* Admin-only: the panel is absent — not hidden — for everyone else. */}
        {isAdmin && session.devtoolsOpen ? <DevtoolsPanel /> : null}
      </div>
      </div>

      {/* Terminal, harness, and card tabs; hidden while inactive, never unmounted. */}
      <TabBodies />

      {
        /*
         * §28.4: reset destroys the transcript with no undo, so it names what
         * goes before it goes. The count is the transcript's own, so the
         * confirm cannot claim more or less than is actually there.
         */
      }
      <ConfirmDialog
        open={confirmReset}
        title="Start a fresh conversation?"
        body={`${
          messages.length === 1 ? "1 message" : `${messages.length} messages`
        } and everything on screen will be discarded. Nothing is kept.`}
        confirmLabel="Discard and start fresh"
        destructive
        onConfirm={() => {
          setConfirmReset(false)
          controller.runCommand("reset")
        }}
        onCancel={() => setConfirmReset(false)}
      />

      {/* The one shared toast stack: every background flow past 300ms reports here. */}
      <ToastStack
        toasts={toasts}
        onDismiss={(id) => controller.runCommandArgs("toast.dismiss", id)}
      />
    </div>
  )
}

export default App
