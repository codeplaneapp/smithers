import { Button, ChatComposer } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import {
  BookOpen,
  ChevronDown,
  FolderGit2,
  GitPullRequest,
  HardDrive,
  Plug,
  Server
} from "lucide-react"
import { useRef, useState } from "react"
import type { KeyboardEvent, ReactNode, RefObject } from "react"
import { useController } from "./ControllerContext"
import { composeRefs, stampFlows, stampTestIds } from "./FlowStamp"
import { WORLD_DISPLAY_NAME } from "./state/AppState"

/** Stable Playwright handle; spread past ChatComposer's excess-property check. */
const COMPOSER_INPUT_TEST_ID: Record<string, string> = { "data-testid": "composer-input" }

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
  /* The entries are a fixed list, so index-assigned refs stay aligned with the DOM. */
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

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
    <div className="composer-menu composer-surfaces">
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
 * connector.add, GitHub through auth.sign-in / repos.watch, cloud import
 * through repos.import, and full management through /connect.
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
  /*
   * The entries are built as DATA below so index-assigned refs stay aligned
   * with the DOM through every conditional entry. Arrow keys, Escape, and
   * open-and-focus-the-first-entry read these refs — never `document`, whose
   * only job here would be to find nodes this package itself rendered.
   */
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

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
    ...(controller.nativeRepositoriesAvailable && controller.commands.find("connector.add") !== undefined
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
    ...(signedIn && controller.commands.find("repos.watch") !== undefined
      ? [{
        key: "repos.watch",
        flow: "repos.watch",
        content: (
          <>
            <GitPullRequest size={14} aria-hidden="true" />
            Choose GitHub repositories…
          </>
        )
      }]
      : !signedIn && controller.commands.find("auth.sign-in") !== undefined ? [{
        key: "auth.sign-in",
        flow: "auth.sign-in",
        content: (
          <>
            <GitPullRequest size={14} aria-hidden="true" />
            Connect GitHub…
          </>
        )
      }] : []),
    /*
     * §1.1: signed out, sign-in is the ONE offered next step. Both of
     * these need a session — clicking either only defers into the
     * sign-in above it — so presenting them as available work makes
     * the app look like it offers four ways in when it has one.
     */
    ...(signedIn
      ? [
        ...(controller.commands.find("repos.import") === undefined ? [] : [{
          key: "repos.import",
          flow: "repos.import",
          content: (
            <>
              <Server size={14} aria-hidden="true" />
              Import to Smithers Cloud…
            </>
          )
        }]),
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

  if (entries.length === 0) return null

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
    <div className="composer-menu composer-connect">
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
export function Composer({
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
