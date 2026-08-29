/*
 * Every interactive capability in the app, as a flow.
 *
 * A capability is a `Flow.make` declaration — name, description, capability
 * claims, and typed payload/success schemas — paired with the controller call
 * that runs it through `FlowBinding.make`. The pair is the whole capability:
 * the projected `FlowDescriptor` is what the agent's catalog discloses, and the
 * binding's `run` is what answers the call, so the catalog shown to the model
 * and the code that executes cannot drift apart.
 *
 * Two axes live on the declaration rather than on the UI wrapper:
 *  - capability claims (DESIGN.md §14's three-tier policy): `outbound:*` always
 *    asks, `session:*` asks once per session, `approve:*` is structurally denied
 *    to the agent, and the `app:act` default is free;
 *  - the trigger axis, as `modelInvocable`. A user-only flow is browser
 *    mechanics the human clicks (sign-in, theme, stop, send, maximize); the
 *    descriptor says so, so it never reaches the agent's catalog.
 *
 * Handlers take a DECODED payload. No handler parses argument text: the slash
 * boundary turns `/name <text>` into the flow's payload once, in SlashPayload.ts.
 */
import * as Flow from "@smthrs/core/Flow"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Effect, Schema } from "effect"
import type { RepositoryAccess } from "smithers-shared/NativeRepository"
import type { AppController } from "../state/AppController"
import { PALETTES, WORLD_DISPLAY_NAME } from "../state/AppState"
import type { CommandState, FlowEntry, FlowMetadata } from "./registry"

/**
 * What a flow handler resolves: nothing, an honest error string, or a success
 * VALUE (`{ value }`) — the payload an invocation hands back to its caller
 * (e.g. the browser flow's extracted text). Agent tool payloads never render
 * raw in the transcript (DESIGN.md §3, trigger axis); the controller may
 * surface a HUMAN caller's value as that command's embedded answer.
 */
export type CommandResult = void | string | { readonly value: string }

/**
 * The controller actions flows bind to. This is the AppController surface minus
 * the dispatch members themselves, so the registry never calls back through its
 * own run path.
 */
export type CommandActions =
  & Omit<
    AppController,
    | "store"
    | "nativeAgentAvailable"
    | "nativeRepositoriesAvailable"
    | "slashCommands"
    | "slashItems"
    | "runCommand"
    | "runCommandArgs"
    | "commands"
    | "tappedFetch"
    // The scope close is the composition root's act, never a flow's.
    | "dispose"
  >
  & {
    readonly snapshot: () => CommandState
    /*
     * Run work as the AGENT actor: every agent invocation dispatches under
     * actor smithers, so agent-driven flows render embedded cards and record
     * via:"agent", never user chrome (THE EMBED LAW, §2c″).
     */
    readonly withAgentActor: <T>(work: () => Promise<T>) => Promise<T>
  }

/**
 * The success schema every app flow shares.
 *
 * These flows act on the app rather than compute a result, so the honest
 * success payload is "it ran", optionally carrying the one string the agent
 * boundary hands back to the model.
 */
export const Ack = Schema.Struct({ value: Schema.optional(Schema.String) })

/** The default claim: acting on the app the human is already looking at. */
const APP_ACT: ReadonlyArray<string> = ["app:act"]

/**
 * Runs a controller call as the flow's handler.
 *
 * The controller's string return is its honest refusal, so it becomes the
 * typed error channel — which `FlowBinding` renders as a catchable `failure`
 * call result rather than a harness failure. A throw is the same kind of
 * refusal and is reported with its message instead of escaping as a defect.
 */
const act = (
  run: () => CommandResult | Promise<CommandResult>
): Effect.Effect<{ readonly value?: string }, string> =>
  Effect.flatMap(
    Effect.tryPromise({
      try: async () => run(),
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause))
    }),
    (result) =>
      typeof result === "string"
        ? Effect.fail(result)
        : Effect.succeed(
          typeof result === "object" && result !== null ? { value: result.value } : {}
        )
  )

/**
 * The payload schemas a flow may declare: anything that decodes from unknown
 * without asking the host for a service, which is the contract `FlowBinding`
 * needs in order to decode a call's input on its own.
 */
type Payload = Schema.Top & Schema.ConstraintDecoder<unknown, never>

/** Everything one registered flow declares, in one literal. */
interface Declaration<I extends Payload> extends FlowMetadata {
  readonly name: string
  readonly input: I
  readonly handler: (payload: I["Type"]) => CommandResult | Promise<CommandResult>
  /** Capability claims; the free `app:act` default when omitted. */
  readonly capabilities?: ReadonlyArray<string>
  /** Browser mechanics the human clicks: never disclosed to, or callable by, the model. */
  readonly userOnly?: boolean
}

/**
 * Declares one flow and binds it to its handler.
 *
 * The declaration's description is the catalog line the MODEL reads, so it
 * carries the argument hint; `metadata.summary` stays the human's catalog copy.
 */
const flow = <I extends Payload>(declaration: Declaration<I>): FlowEntry => {
  const { name, input, handler, capabilities, userOnly, ...metadata } = declaration
  const described = metadata.args === undefined ? metadata.summary : `${metadata.summary} (args: ${metadata.args})`
  return {
    binding: FlowBinding.make({
      flow: Flow.make({
        name,
        description: described,
        input,
        output: Ack,
        capabilities: capabilities ?? APP_ACT
      }),
      modelInvocable: userOnly !== true,
      handler: (payload) => act(() => handler(payload))
    }),
    metadata
  }
}

/** The payload of a flow that takes nothing. */
const NoPayload = Schema.Struct({})
/** An optional trailing `owner/repo` target. */
const RepoTarget = Schema.Struct({ repo: Schema.optional(Schema.String) })
/** A card id, the handle every id-scoped card act takes. */
const CardTarget = Schema.Struct({ cardId: Schema.String })
/** A Smithers target: the repository it belongs to and its label. */
const TargetRef = Schema.Struct({ repoId: Schema.String, label: Schema.String })
/** A positive issue or pull-request number beside its optional repo. */
const NumberedTarget = Schema.Struct({
  number: Schema.Number,
  repo: Schema.optional(Schema.String)
})

/**
 * The flows every session has.
 *
 * @category constructors
 */
export const baseFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "connect",
    summary: "Connect work to Smithers",
    input: NoPayload,
    handler: () => actions.showConnectors()
  }),
  flow({
    name: "world",
    summary: `See what Smithers understands (${WORLD_DISPLAY_NAME})`,
    input: NoPayload,
    handler: () => actions.showWorld()
  }),
  flow({
    /*
     * The color theme, the axis orthogonal to light/dark (dark-mode below):
     * `/theme <key>` wears a palette, bare `/theme` answers with the list and
     * where the human already is. User-only browser chrome, like every other
     * look-and-feel control.
     */
    name: "theme",
    summary: "Set the color theme",
    userOnly: true,
    args: PALETTES.join(" | "),
    input: Schema.Struct({ palette: Schema.String }),
    handler: ({ palette }) => actions.setPalette(palette)
  }),
  flow({
    /*
     * C-1 (wave 13): the composer's surfaces-menu trigger is a flow like every
     * other affordance — the button dispatches /surfaces, and /surfaces typed
     * opens the same menu.
     */
    name: "surfaces",
    summary: "Open the surfaces menu",
    userOnly: true,
    input: NoPayload,
    handler: () => actions.toggleSurfacesMenu()
  }),
  flow({
    /*
     * The light/dark toggle, canonical under its own name since /theme became
     * the palette flow. Listed, because it is the one control the corner
     * button dispatches.
     */
    name: "dark-mode",
    summary: "Toggle light and dark mode",
    userOnly: true,
    input: NoPayload,
    handler: () => actions.toggleTheme()
  }),
  flow({
    name: "chat",
    summary: "Back to the conversation",
    input: NoPayload,
    handler: () => actions.showChat()
  }),
  flow({
    name: "retry",
    summary: "Retry the last turn",
    input: NoPayload,
    handler: () => actions.retryLastTurn()
  }),
  flow({
    name: "chat.stop",
    summary: "Stop the current response",
    userOnly: true,
    input: NoPayload,
    handler: () => actions.stop()
  }),
  flow({
    name: "stop",
    summary: "Stop the current response",
    aliasOf: "chat.stop",
    hidden: true,
    userOnly: true,
    input: NoPayload,
    handler: () => actions.stop()
  }),
  flow({
    name: "send",
    summary: "Submit the composer",
    userOnly: true,
    args: "<text>",
    input: Schema.Struct({ text: Schema.String }),
    handler: ({ text }) => {
      actions.send(text)
    }
  }),
  flow({
    /*
     * Wave 10 onboarding — the repo chooser, one flow three ways: the card's
     * confirm, /repos.watch, and the agent call ("watch my flows repo too"
     * resolves here). An optional repo pre-selects it. Re-running reopens the
     * chooser pre-filled with the current selection.
     */
    name: "repos.watch",
    summary: "Choose which repositories Smithers watches",
    args: "[repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.openRepoChooser(repo)
  }),
  flow({
    name: "repos.watch.toggle",
    summary: "Toggle a repository in the chooser",
    hidden: true,
    userOnly: true,
    args: "<fullName>",
    input: Schema.Struct({ fullName: Schema.String }),
    handler: ({ fullName }) => actions.toggleWatchedRepo(fullName)
  }),
  flow({
    name: "repos.watch.all",
    summary: "Select every repository in the chooser",
    hidden: true,
    userOnly: true,
    input: NoPayload,
    handler: () => actions.selectAllWatchedRepos()
  }),
  flow({
    name: "repos.watch.none",
    summary: "Select no repositories in the chooser",
    hidden: true,
    userOnly: true,
    input: NoPayload,
    handler: () => actions.selectNoWatchedRepos()
  }),
  flow({
    name: "repos.watch.confirm",
    summary: "Confirm the watched-repositories selection",
    hidden: true,
    userOnly: true,
    input: NoPayload,
    handler: () => actions.confirmWatchedRepos()
  }),
  flow({
    /*
     * /clear (§2h): sweep the outgoing transcript for what belongs in world,
     * keep it, THEN clear — a failed sweep clears nothing.
     */
    name: "clear",
    summary: "Clear the chat, keeping anything worth remembering",
    userOnly: true,
    input: NoPayload,
    handler: () => actions.clearConversation()
  }),
  flow({
    /* The browser tool + surface (§2d/§2d′): read a page; embed its card. */
    name: "browser",
    summary: "Open a web page as a card Smithers can read",
    args: "<url>",
    capabilities: ["session:net-read"],
    input: Schema.Struct({ url: Schema.String }),
    handler: ({ url }) => actions.openBrowser(url)
  }),
  flow({
    /*
     * Wave 11 — "make me a workflow". The agent invokes this with the user's
     * description; the run renders as an embedded run card tracked live from
     * the relay event stream (THE EMBED LAW).
     *
     * Wave 12 §2: a trailing `owner/repo` names the target. Without one and
     * with more than one watched repo, the chooser-among-watched asks — the
     * target is a genuine user choice, not a guess.
     */
    name: "flow.create",
    summary: "Create a Smithers workflow from a description",
    args: "<description> [owner/repo]",
    requires: ["signed-in", "repos-selected"],
    capabilities: ["outbound:launch"],
    input: Schema.Struct({
      description: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ description }) => actions.createWorkflow(description)
  }),
  flow({
    /*
     * The answer to the which-repo question — one act, from the card.
     *
     * `userOnly` is load-bearing, not decoration. §2 exists because the target
     * is a GENUINE user choice and nothing may be provisioned on a guess; a
     * model that can execute this by name answers the human's question for
     * them and provisions on ITS guess. Hidden keeps it out of the catalog;
     * user-only keeps it un-executable even by a model that guesses the name.
     */
    name: "flow.repo.choose",
    summary: "Choose which watched repository a workflow belongs to",
    hidden: true,
    userOnly: true,
    args: "<owner/repo>",
    input: Schema.Struct({ repo: Schema.String }),
    handler: ({ repo }) => actions.chooseWorkflowRepo(repo)
  }),
  flow({
    /*
     * Wave 12 §3 — the acts a run that has gone quiet offers. Both are the
     * human's decision about their own watch, bound to the card's buttons:
     * hidden from the slash menu and the catalog, and user-only so the model
     * cannot stop (or restart) a watch on the human's behalf.
     */
    name: "flow.run.stop",
    summary: "Stop watching a run",
    hidden: true,
    userOnly: true,
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.stopWatchingRun(cardId)
  }),
  flow({
    name: "flow.run.retry",
    summary: "Check a run again",
    hidden: true,
    userOnly: true,
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.retryRunWatch(cardId)
  }),
  flow({
    name: "flow.list",
    summary: "List the workflows on your workspace",
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.listWorkspaceWorkflows()
  }),
  flow({
    name: "flow.run",
    summary: "Run a workflow on your workspace",
    args: "<name> [owner/repo]",
    requires: ["signed-in", "repos-selected"],
    capabilities: ["outbound:launch"],
    input: Schema.Struct({
      name: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ name, repo }) => actions.runWorkflow(name, repo)
  }),
  flow({
    /* Maximize is the user's explicit act alone (THE EMBED LAW). */
    name: "card.maximize",
    summary: "Maximize a card",
    hidden: true,
    userOnly: true,
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.maximizeCard(cardId)
  }),
  flow({
    name: "card.minimize",
    summary: "Minimize the maximized card",
    hidden: true,
    userOnly: true,
    input: NoPayload,
    handler: () => actions.minimizeCard()
  }),
  flow({
    name: "copy-message",
    summary: "Copy a message to the clipboard",
    hidden: true,
    userOnly: true,
    args: "<text>",
    input: Schema.Struct({ text: Schema.String }),
    /*
     * A.26: `void navigator.clipboard.writeText(...)` let the browser's
     * NotAllowedError escape as an unhandled rejection — the only trace was
     * a POST to /api/client-errors, and the human who pressed Copy was told
     * nothing at all. The refusal is awaited and answered.
     */
    handler: async ({ text }) => {
      const clipboard = navigator.clipboard
      if (clipboard === undefined) {
        return "This browser won't give Smithers the clipboard — select the text and copy it yourself."
      }
      try {
        await clipboard.writeText(text)
      } catch (cause) {
        return cause instanceof Error && cause.name === "NotAllowedError"
          ? "The browser refused the clipboard — it only allows a copy while the page has focus."
          : "The copy didn't go through — select the text and copy it yourself."
      }
    }
  }),
  flow({
    name: "approval.approve",
    summary: "Approve a pending approval card",
    hidden: true,
    args: "<cardId>",
    capabilities: ["approve:self"],
    input: CardTarget,
    handler: ({ cardId }) => {
      actions.decideApproval(cardId, "approved")
    }
  }),
  flow({
    name: "approval.deny",
    summary: "Deny a pending approval card",
    hidden: true,
    args: "<cardId>",
    capabilities: ["approve:self"],
    input: CardTarget,
    handler: ({ cardId }) => {
      actions.decideApproval(cardId, "denied")
    }
  }),
  flow({
    name: "connector.add",
    summary: "Connect a local repository",
    hidden: true,
    args: "<read|read-write>",
    input: Schema.Struct({ access: Schema.Literals(["read", "read-write"]) }),
    handler: async ({ access }) => {
      await actions.connectLocalRepository(access as RepositoryAccess)
    }
  }),
  flow({
    name: "connector.downgrade",
    summary: "Make a connector read-only",
    hidden: true,
    args: "<connectorId>",
    input: Schema.Struct({ connectorId: Schema.String }),
    handler: ({ connectorId }) => {
      actions.makeConnectorReadOnly(connectorId)
    }
  }),
  flow({
    name: "connector.remove",
    summary: "Disconnect a repository",
    hidden: true,
    args: "<connectorId>",
    input: Schema.Struct({ connectorId: Schema.String }),
    handler: ({ connectorId }) => {
      actions.removeConnector(connectorId)
    }
  }),
  flow({
    name: "world.new-note",
    summary: "Create a world note",
    hidden: true,
    input: NoPayload,
    handler: () => actions.createWorldDocument()
  }),
  flow({
    name: "world.select",
    summary: "Open a world note",
    hidden: true,
    args: "<documentId>",
    input: Schema.Struct({ documentId: Schema.String }),
    handler: ({ documentId }) => actions.selectWorldDocument(documentId)
  }),
  flow({
    name: "world.delete",
    summary: "Delete a world note",
    hidden: true,
    args: "<documentId>",
    input: Schema.Struct({ documentId: Schema.String }),
    handler: ({ documentId }) => actions.removeWorldDocument(documentId)
  }),
  flow({
    /*
     * §10.6 / §28.4: deleting a note asks first, and the answer is an act of
     * its own — the same shape `admin.grant` uses. The agent may ASK (it can
     * offer to tidy a note) and may never answer for the human.
     */
    name: "world.delete.confirm",
    summary: "Delete the note Smithers asked about",
    hidden: true,
    userOnly: true,
    input: NoPayload,
    handler: () => actions.confirmWorldDelete()
  }),
  flow({
    name: "world.delete.cancel",
    summary: "Keep the note Smithers asked about",
    hidden: true,
    userOnly: true,
    input: NoPayload,
    handler: () => actions.cancelWorldDelete()
  }),
  flow({
    name: "auth.sign-in",
    summary: "Sign in with GitHub",
    userOnly: true,
    input: NoPayload,
    handler: () => actions.signIn()
  }),
  flow({
    /*
     * The agent's door to login: it cannot run auth.sign-in (user-only —
     * navigation is the human's act), but it CAN render the step. The
     * message's action IS the sign-in button, one click away.
     */
    name: "auth.prompt",
    summary: "Offer the GitHub sign-in step in the chat",
    input: NoPayload,
    handler: () => actions.promptSignIn()
  }),
  flow({
    /* Signing out needs a session: offering it signed out is the clearest
		   case of a listing that names a step the user cannot take (§1.2). */
    name: "auth.sign-out",
    summary: "Sign out of Smithers",
    userOnly: true,
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.signOut()
  }),
  flow({
    name: "auth.request-access",
    summary: "Request access to Smithers",
    userOnly: true,
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.requestAccess()
  }),
  flow({
    name: "toast.dismiss",
    summary: "Dismiss a toast notification",
    hidden: true,
    userOnly: true,
    args: "<toastId>",
    input: Schema.Struct({ toastId: Schema.String }),
    handler: ({ toastId }) => {
      actions.dismissToast(toastId)
    }
  }),
  flow({
    name: "billing.balance",
    summary: "Show your balance",
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.showBalance()
  }),
  /*
   * The multi-parity domain flows (MULTI-ACTIONS-GAP.md): issues, PRs
   * (landings — a land QUEUES, it never "merges"), billing checkout, BYOK keys,
   * notifications, the agent environment, and repo import. Repo-scoped flows
   * take an optional `repo` target; absent one, a single watched repository is
   * the target and several are an honest choice (RepoContext.ts). They require
   * signed-in only — an explicit owner/repo must not defer into the
   * watched-repos chooser.
   */
  flow({
    name: "repos.import",
    summary: "Import a GitHub repository into Smithers Cloud",
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.importRepository(repo)
  }),
  flow({
    name: "issues.list",
    summary: "List a repository's issues",
    args: "[open|closed|all] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      filter: Schema.Literals(["open", "closed", "all"]),
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ filter, repo }) => actions.listIssues(filter, repo)
  }),
  flow({
    name: "issues.view",
    summary: "Open an issue with its comments",
    args: "<number> [owner/repo]",
    requires: ["signed-in"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.viewIssue(number, repo)
  }),
  flow({
    name: "issues.create",
    summary: "Create an issue",
    args: "<title> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ title: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ title, repo }) => actions.createIssue(title, repo)
  }),
  flow({
    name: "issues.close",
    summary: "Close an issue",
    args: "<number> [owner/repo]",
    requires: ["signed-in"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.setIssueState(number, "closed", repo)
  }),
  flow({
    name: "issues.reopen",
    summary: "Reopen a closed issue",
    args: "<number> [owner/repo]",
    requires: ["signed-in"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.setIssueState(number, "open", repo)
  }),
  flow({
    name: "issues.comment",
    summary: "Comment on an issue",
    args: "<number> <text> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      number: Schema.Number,
      text: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ number, text, repo }) => actions.commentOnIssue(number, text, repo)
  }),
  flow({
    name: "prs.list",
    summary: "List a repository's pull requests",
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.listLandings(repo)
  }),
  flow({
    name: "prs.view",
    summary: "Open a pull request with reviews and checks",
    args: "<number> [owner/repo]",
    requires: ["signed-in"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.viewLanding(number, repo)
  }),
  flow({
    name: "prs.create",
    summary: "Open a pull request",
    args: "<title> [from:<bookmark>] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      title: Schema.String,
      from: Schema.optional(Schema.String),
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ title, from, repo }) => actions.createLanding(title, repo, from)
  }),
  flow({
    /*
     * Landing is the human's consequential act (it queues a merge): user-only,
     * like flow.repo.choose — the model can show the PR card, never queue the
     * land itself.
     */
    name: "prs.land",
    summary: "Land a pull request (queues the merge)",
    userOnly: true,
    args: "<number> [owner/repo]",
    requires: ["signed-in"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.landLanding(number, repo)
  }),
  flow({
    name: "prs.review",
    summary: "Review a pull request",
    args: "<number> approve|request-changes|comment [text] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      number: Schema.Number,
      verdict: Schema.Literals(["approve", "request_changes", "comment"]),
      text: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ number, verdict, text, repo }) => actions.reviewLanding(number, verdict, text, repo)
  }),
  flow({
    name: "keys.list",
    summary: "List your provider API keys (masked)",
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.listKeys()
  }),
  flow({
    /* Removing a credential is the human's destructive act: user-only. */
    name: "keys.remove",
    summary: "Remove a provider API key",
    userOnly: true,
    args: "<provider>",
    requires: ["signed-in"],
    input: Schema.Struct({ provider: Schema.String }),
    handler: ({ provider }) => actions.removeKey(provider)
  }),
  flow({
    name: "notifications.list",
    summary: "Show your notifications",
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.listNotifications()
  }),
  flow({
    name: "notifications.read",
    summary: "Mark every notification read",
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.markNotificationsRead()
  }),
  flow({
    name: "env.view",
    summary: "Show a repository's agent environment",
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.viewEnvironment(repo)
  }),
  flow({
    name: "env.set",
    summary: "Set an agent-environment variable",
    args: "<NAME=value> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ assignment: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ assignment, repo }) => actions.setEnvironmentVar(assignment, repo)
  }),
  flow({
    name: "branches.list",
    summary: "List a repository's branches (bookmarks)",
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.listBookmarks(repo)
  }),
  flow({
    /*
     * Files flows parse the PATH as the first token, always — a lone `src/x`
     * is a path, never a repo (deterministic beats clever); name the repo as a
     * second token to cross repositories.
     */
    name: "files.list",
    summary: "List a repository directory",
    args: "[path] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ path: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ path, repo }) => actions.listFiles(path, repo)
  }),
  flow({
    name: "files.read",
    summary: "Read a file from a repository",
    args: "<path> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ path: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ path, repo }) => actions.readFile(path, repo)
  }),
  flow({
    name: "repos.app",
    summary: "Check the Smithers GitHub App on a repository",
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.checkGitHubApp(repo)
  }),
  flow({
    /* The one-keystroke recovery: reload the window (dev loop, stuck states). */
    name: "reload",
    summary: "Reload the app",
    userOnly: true,
    input: NoPayload,
    handler: () => actions.reloadApp()
  }),
  flow({
    /*
     * The full catalog as a chat message: the slash menu caps at 8 for calm,
     * so THIS is where "show me everything" lives — for the user typed, and
     * for the agent answering "what can you do".
     */
    name: "flows",
    summary: "List everything Smithers can do",
    input: NoPayload,
    handler: () => actions.showCommandCatalog()
  }),
  /*
   * The local-app tabs (docs/LOCAL-APP.md "Tabs"): the strip, the `+` menu,
   * a maximized card's "Open in tab", and Cmd+T / Cmd+W / Cmd+1..9 all
   * invoke these. Every one is browser mechanics the human clicks, so none
   * is disclosed to the model; hidden, because the strip is the affordance.
   */
  flow({
    name: "tab.terminal",
    summary: "Open a terminal tab",
    hidden: true,
    userOnly: true,
    input: NoPayload,
    handler: () => actions.openTerminalTab()
  }),
  flow({
    name: "tab.harness",
    summary: "Open a harness tab",
    hidden: true,
    userOnly: true,
    args: "<harnessId>",
    input: Schema.Struct({ harnessId: Schema.String }),
    handler: ({ harnessId }) => actions.openHarnessTab(harnessId)
  }),
  flow({
    name: "tab.card",
    summary: "Open a card in a tab",
    hidden: true,
    userOnly: true,
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.openCardTab(cardId)
  }),
  flow({
    name: "tab.select",
    summary: "Select a tab",
    hidden: true,
    userOnly: true,
    args: "<tabId | 1-9>",
    input: Schema.Struct({ tab: Schema.String }),
    handler: ({ tab }) => actions.selectTab(tab)
  }),
  flow({
    name: "tab.close",
    summary: "Close a tab",
    hidden: true,
    userOnly: true,
    args: "[tabId]",
    input: Schema.Struct({ tabId: Schema.optional(Schema.String) }),
    handler: ({ tabId }) => actions.closeTab(tabId)
  }),
  flow({
    name: "tab.close.confirm",
    summary: "Close the tab and stop its process",
    hidden: true,
    userOnly: true,
    input: NoPayload,
    handler: () => actions.confirmTabClose()
  }),
  flow({
    name: "tab.close.cancel",
    summary: "Keep the tab open",
    hidden: true,
    userOnly: true,
    input: NoPayload,
    handler: () => actions.cancelTabClose()
  }),
  flow({
    name: "tab.menu",
    summary: "Open the new tab menu",
    hidden: true,
    userOnly: true,
    input: NoPayload,
    handler: () => actions.toggleTabMenu()
  }),
  flow({
    /* The chrome's "Open repository": the native folder dialog, or a typed path. */
    name: "repo.open",
    summary: "Open a local repository",
    hidden: true,
    userOnly: true,
    input: NoPayload,
    handler: () => actions.openLocalRepo()
  }),
  /*
   * The html card's bridge (docs/LOCAL-APP.md "Auto-load flow"): a panel's
   * `run` message runs one target as a streamed target-run card; `open`
   * points at the target's row in the targets card. Both are the human's
   * click inside the frame, so neither is disclosed to the model.
   */
  flow({
    name: "target.run",
    summary: "Run a Smithers target",
    hidden: true,
    userOnly: true,
    args: "<repoId> <label>",
    input: TargetRef,
    handler: ({ repoId, label }) => actions.runTarget(repoId, label)
  }),
  flow({
    name: "target.open",
    summary: "Show a Smithers target in its targets card",
    hidden: true,
    userOnly: true,
    args: "<repoId> <label>",
    input: TargetRef,
    handler: ({ repoId, label }) => actions.openTarget(repoId, label)
  }),
  /*
   * The target-graph cards (docs/LOCAL-APP.md "Cards: target graph"): "show
   * graph" / "graph //src:lint" opens the typed DAG (focused when a label is
   * named), "timeline"/"history" the run views (a history row replays into
   * both the timeline and the graph overlay), "affected" the diff set, "show
   * ci" the generated matrix. The repo id may go unnamed when exactly one
   * repository is open — the controller resolves it.
   */
  flow({
    name: "target.graph",
    summary: "Show the target graph",
    args: "[repoId] [label]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String), label: Schema.optional(Schema.String) }),
    handler: ({ repoId, label }) => actions.showGraph(repoId, label)
  }),
  flow({
    /* The graph drawer's focus: pin one label, or clear the focus when none is named. */
    name: "target.graph.focus",
    summary: "Focus the target graph on one label, or clear the focus details",
    hidden: true,
    userOnly: true,
    args: "<repoId> [label]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String), label: Schema.optional(Schema.String) }),
    handler: ({ repoId, label }) => actions.focusGraphNode(repoId, label)
  }),
  flow({
    name: "target.timeline",
    summary: "Show one target run's timeline",
    args: "[repoId] <runId>",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String), runId: Schema.optional(Schema.String) }),
    handler: ({ repoId, runId }) => actions.showRunTimeline(repoId, runId)
  }),
  flow({
    name: "target.history",
    summary: "Show the repository's target run history",
    args: "[repoId]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String) }),
    handler: ({ repoId }) => actions.showRunHistory(repoId)
  }),
  flow({
    name: "target.runs.select",
    summary: "Replay a recorded run into the timeline and the graph",
    hidden: true,
    args: "[repoId] <runId>",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String), runId: Schema.String }),
    handler: ({ repoId, runId }) => actions.selectRunReplay(repoId, runId)
  }),
  flow({
    /* The replay scrubber: the slider's own act (time travel), user-triggered only. */
    name: "target.run.scrub",
    summary: "Replay a recorded run up to a cursor",
    hidden: true,
    userOnly: true,
    args: "<runId> <cursor>",
    input: Schema.Struct({ runId: Schema.String, cursor: Schema.Number }),
    handler: ({ runId, cursor }) => actions.scrubRunReplay(runId, cursor)
  }),
  flow({
    name: "target.affected",
    summary: "Show what the working-tree diff affects",
    args: "[repoId]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String) }),
    handler: ({ repoId }) => actions.showAffected(repoId)
  }),
  flow({
    name: "target.ci",
    summary: "Show the CI matrix the target graph implies",
    args: "[repoId]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String) }),
    handler: ({ repoId }) => actions.showCiMatrix(repoId)
  }),
  flow({
    /* The graph drawer's "open" affordance for a declaration site. */
    name: "target.source.open",
    summary: "Open a target's declaration source",
    hidden: true,
    userOnly: true,
    args: "<repoId> <file[:line]>",
    input: Schema.Struct({ repoId: Schema.String, file: Schema.String }),
    handler: ({ repoId, file }) => {
      const split = /^(.*):(\d+)$/.exec(file)
      return split === null
        ? actions.openTargetSource(repoId, file)
        : actions.openTargetSource(repoId, split[1] ?? file, Number(split[2]))
    }
  })
]

/*
 * The admin plugin (Launch Checklist §E — non-enumerable): these flows REGISTER
 * ONLY when the validated session carries admin:true. For every other session
 * they are absent from the registry — not hidden, not disabled — so the
 * enumeration surface (slash menu, agent catalog) of a non-admin session
 * contains no trace of them, and a direct /name invocation resolves exactly
 * like any typo.
 */
export const adminFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * §17.4: no top-up or checkout flow is exposed to an MVP account. Every
     * alpha account IS an MVP account, so these two register in the admin
     * plugin only — absent from the registry for everyone else, not hidden,
     * so the slash menu never advertises "opens Stripe checkout" to a user
     * who has no checkout. Payment is the human's act alone: user-only, like
     * sign-in.
     */
    name: "billing.upgrade",
    summary: "Upgrade your plan (opens Stripe checkout)",
    userOnly: true,
    args: "[plan]",
    requires: ["signed-in"],
    input: Schema.Struct({ plan: Schema.optional(Schema.String) }),
    handler: ({ plan }) => actions.startCheckout(plan)
  }),
  flow({
    name: "billing.portal",
    summary: "Manage billing (opens the Stripe portal)",
    userOnly: true,
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.openBillingPortal()
  }),
  flow({
    /*
     * The bare reset is admin-only dev tooling (§2): no sweep, nothing kept.
     * Users get /clear instead.
     */
    name: "reset",
    summary: "Start a fresh conversation (dev tooling — nothing is kept)",
    userOnly: true,
    input: NoPayload,
    handler: () => actions.reset()
  }),
  flow({
    /* The admin dev-tools panel (§2b/§2d): the machinery, visible. */
    name: "admin.devtools",
    summary: "Toggle the dev-tools panel",
    userOnly: true,
    input: NoPayload,
    handler: () => actions.toggleDevtools()
  }),
  flow({
    /*
     * DESIGN.md §14: report what drives a turn. A read, not a switch — there
     * is one backend, and an argument asking for another is answered rather
     * than ignored. user-only: the agent must never reason about its engine.
     */
    name: "debug.backend",
    summary: "Report the agent backend",
    userOnly: true,
    input: Schema.Struct({ backend: Schema.String }),
    handler: ({ backend }) => actions.describeAgentBackend(backend)
  }),
  flow({
    /* The debug reads — one typed surface the panel AND the agent share. */
    name: "debug.snapshot",
    summary: "Read the app state snapshot",
    input: NoPayload,
    handler: () => actions.debugSnapshot()
  }),
  flow({
    name: "debug.events",
    summary: "Read the transition journal tail",
    input: NoPayload,
    handler: () => actions.debugEvents()
  }),
  flow({
    /* Debug mode's chain x-ray (§14): the journal fold, as data. */
    name: "debug.chain",
    summary: "Read the chain journal x-ray",
    input: NoPayload,
    handler: () => actions.debugChain()
  }),
  flow({
    /* Debug mode's wire tap (§14): the controller's fetch ring. */
    name: "debug.net",
    summary: "Read the network tap",
    input: NoPayload,
    handler: () => actions.debugNet()
  }),
  flow({
    /* The session tier's revocation (§14): drop every chain grant. */
    name: "debug.grants.reset",
    summary: "Revoke the chain's session grants",
    userOnly: true,
    input: NoPayload,
    handler: () => actions.resetGrants()
  }),
  flow({
    name: "debug.seams",
    summary: "Probe seam and upstream health",
    input: NoPayload,
    handler: () => actions.debugSeams()
  }),
  flow({
    name: "admin.allowlist.add",
    summary: "Add a GitHub login to the allowlist",
    args: "<login>",
    input: Schema.Struct({ login: Schema.String }),
    handler: ({ login }) => actions.adminAllowlist("add", login)
  }),
  flow({
    name: "admin.allowlist.remove",
    summary: "Remove a GitHub login from the allowlist",
    args: "<login>",
    input: Schema.Struct({ login: Schema.String }),
    handler: ({ login }) => actions.adminAllowlist("remove", login)
  }),
  flow({
    name: "admin.grant",
    summary: "Grant balance to a login (asks for confirmation first)",
    args: "<amountUsd> <login>",
    input: Schema.Struct({ amountUsd: Schema.Number, login: Schema.String }),
    handler: ({ amountUsd, login }) => actions.adminGrant(amountUsd, login)
  }),
  flow({
    name: "admin.grant.confirm",
    summary: "Confirm a pending balance grant",
    hidden: true,
    args: "<cardId>",
    capabilities: ["approve:self"],
    userOnly: true,
    input: CardTarget,
    handler: ({ cardId }) => actions.adminGrantConfirm(cardId)
  }),
  flow({
    name: "admin.grant.cancel",
    summary: "Cancel a pending balance grant",
    hidden: true,
    args: "<cardId>",
    userOnly: true,
    input: CardTarget,
    handler: ({ cardId }) => actions.adminGrantCancel(cardId)
  }),
  flow({
    name: "admin.requests",
    summary: "Show the request-access queue",
    input: NoPayload,
    handler: () => actions.adminRequests()
  }),
  flow({
    name: "admin.queue.approve",
    summary: "Approve a request-access queue entry",
    hidden: true,
    args: "<login>",
    capabilities: ["approve:self"],
    userOnly: true,
    input: Schema.Struct({ login: Schema.String }),
    handler: ({ login }) => actions.adminQueueApprove(login)
  }),
  flow({
    name: "admin.health",
    summary: "What failed overnight? Service health, charges, queue depth",
    input: NoPayload,
    handler: () => actions.adminHealth()
  })
]
