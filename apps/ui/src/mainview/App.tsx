import {
  Badge,
  Button,
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
import { useLiveQuery } from "@tanstack/react-db"
import {
  BookOpen,
  Copy,
  Moon,
  Plus,
  RotateCcw,
  Sparkles,
  Sun,
  Trash2
} from "lucide-react"
import { lazy, Suspense, useRef, useState } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"
import { CardView } from "./ChatCards"
import { Composer } from "./Composer"
import { ConnectorsSurface } from "./ConnectorsSurface"
import { useController } from "./ControllerContext"
import { DevtoolsPanel } from "./DevtoolsPanel"
import { stampFlows } from "./FlowStamp"
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

const MarkdownEditorSurface = lazy(() =>
  import("./MarkdownEditorSurface").then((module) => ({ default: module.MarkdownEditorSurface }))
)

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
      activeWorkspaceId: session.activeWorkspaceId,
      activeBranchId: session.activeBranchId,
      activeFrameId: session.activeFrameId,
      devtoolsOpen: session.devtoolsOpen,
      surfacesMenuOpen: session.surfacesMenuOpen,
      connectMenuOpen: session.connectMenuOpen,
      pendingWorldDeleteId: session.pendingWorldDeleteId,
      activeTabId: session.activeTabId,
      tabMenuOpen: session.tabMenuOpen,
      resetConfirmOpen: session.resetConfirmOpen
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
   * Outside-pointer dismissal belongs to the shell that owns both menus.
   * Capture keeps the original click working and removes global listeners —
   * React remains a projection, and controller disposal owns every external
   * subscription. If focus was inside Surfaces, return it to its trigger.
   */
  const onShellPointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (session.surfacesMenuOpen && target.closest(".composer-surfaces") === null) {
      const heldFocus = document.activeElement?.closest(".composer-surfaces") !== null
      controller.runCommand("surfaces")
      if (heldFocus) requestAnimationFrame(() => surfacesTriggerRef.current?.focus())
    }
    if (session.connectMenuOpen === true && target.closest(".composer-connect") === null) {
      controller.closeConnectMenu()
    }
  }
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
        "This host doesn't provide Smithers identity, so GitHub sign-in and jjhub account features are unavailable. Commands supported by this host remain available below. Use a jjhub Cloud deployment with identity configured for the signed-in experience.",
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
    (watched === undefined || watched.selected === null) &&
    controller.commands.find("repos.watch") !== undefined
  const suggestions: ReadonlyArray<SuggestionBinding> = needsSelection
    ? [{ id: "choose-repos", label: "Choose repos to watch", flow: "repos.watch", emphasis: "primary" }]
    : []
  // Admin chrome follows the same capability-filtered registry as every act.
  const isAdmin = controller.commands.find("admin.devtools") !== undefined

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
      data-frame-maximized={session.maximizedCardId !== null}
      data-flows={controller.commands.all().map((command) => command.name).join(" ")}
      onPointerDownCapture={onShellPointerDownCapture}
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
                    onFrameBack={() => controller.runCommand("frame.back")}
                    onFrameForward={() => controller.runCommand("frame.forward")}
                    onForkFrame={() => controller.runCommand("frame.fork")}
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
            {billing !== undefined && billing.state !== "unknown" &&
                controller.commands.find("billing.balance") !== undefined ?
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
                  data-flow="admin.reset.ask"
                  aria-label="Reset conversation"
                  title="Reset conversation"
                  onClick={() => controller.runCommand("admin.reset.ask")}
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
                          <Suspense fallback={<p className="smithers-card-note">Loading editor…</p>}>
                            <MarkdownEditorSurface
                              value={selectedWorldDocument.body}
                              resetKey={selectedWorldDocument.id}
                              label={`Edit ${selectedWorldDocument.title}`}
                              onChange={(body) => controller.changeWorldDocument(selectedWorldDocument.id, body)}
                            />
                          </Suspense>
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
        open={session.resetConfirmOpen === true}
        title="Start a fresh conversation?"
        body={`${
          messages.length === 1 ? "1 message" : `${messages.length} messages`
        } and everything on screen will be discarded. Nothing is kept.`}
        confirmLabel="Discard and start fresh"
        destructive
        onConfirm={() => {
          controller.runCommand("reset")
        }}
        onCancel={() => controller.runCommand("admin.reset.cancel")}
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
