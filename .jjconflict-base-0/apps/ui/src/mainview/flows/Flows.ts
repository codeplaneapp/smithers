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
import type { RepositoryAccess } from "@smthrs/rpc/NativeRepository"
import type { RuntimeCapability } from "@smthrs/rpc/AppBootstrap"
import { isAgentRoleId } from "@smthrs/rpc/AgentRoles"
import type { AppController } from "../state/AppController"
import { PALETTES, WORLD_DISPLAY_NAME } from "../state/AppState"
import type { CommandState, FlowEntry, FlowMetadata } from "./registry"
import { flag, line, text } from "./FlowForms"

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
    | "slashTree"
    | "runCommand"
    | "runCommandArgs"
    | "commands"
    | "tappedFetch"
    // Feature flags and the download URL are the composition root's configuration, never an action.
    | "features"
    | "downloadUrl"
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
  /**
   * The human's alone: never disclosed to, or callable by, the model. An
   * enumerated exception under the three-door law (AGENTS.md) for a gesture
   * that is physically the human's or an answer only they may give — never
   * for an act that is merely consequential (that is `confirm`). Every
   * `userOnly` flow states its `userOnlyReason`; flows/agent-parity.test.ts
   * enumerates them.
   */
  readonly userOnly?: boolean
  /** Bootstrap capabilities required for this flow to exist in the registry. */
  readonly runtime?: ReadonlyArray<RuntimeCapability>
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
    metadata,
    input
  }
}

/** The payload of a flow that takes nothing. */
const NoPayload = Schema.Struct({})
/** An optional trailing `owner/repo` target. */
const RepoTarget = Schema.Struct({ repo: Schema.optional(Schema.String) })
/** A card id, the handle every id-scoped card act takes. */
const CardTarget = Schema.Struct({ cardId: Schema.String })
/** A Smithers target: the repository it belongs to, its detected workspace, and its label. */
const TargetRef = Schema.Struct({ repoId: Schema.String, label: Schema.String, workspace: Schema.optional(Schema.String) })
/** A positive issue or pull-request number beside its optional repo. */
const NumberedTarget = Schema.Struct({
  number: Schema.Number,
  repo: Schema.optional(Schema.String)
})
/** A 1-based position in a repository file (`<path>:<line>:<col> [owner/repo]`, docs/code-intel/PLAN.md §4). */
const CodePosition = Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  repo: Schema.optional(Schema.String)
})

/**
 * The flows every session has.
 *
 * @category constructors
 */
/**
 * The ONLY flows that may be listed in the slash menu and still refuse the
 * model ("every workflow in the / menu is available as a tool call" — Will).
 * Each entry is here for a structural reason, not taste; adding to this list
 * is a conscious act pinned by flows/invocable.test.ts.
 */
export const USER_ONLY_VISIBLE: ReadonlyArray<{ readonly name: string; readonly why: string }> = [
  { name: "chat.send", why: "turn mechanics: the model is already the turn; sending would nest one" },
  { name: "chat.stop", why: "turn mechanics: stopping the model's own turn from inside it" },
  { name: "admin.reset", why: "destroys the whole store with no undo; the confirm dialog is the only door" },
  { name: "billing.upgrade", why: "external checkout with real money; the human clicks" },
  { name: "billing.portal", why: "external billing portal; the human clicks" },
  { name: "admin.devtools", why: "admin panel presentation toggle" },
  { name: "debug.backend", why: "admin diagnostics presentation" },
  { name: "debug.grants.reset", why: "admin-only grant wipe" },
  { name: "cloud.sign-in", why: "external browser OAuth on the human's account; the human clicks" },
  { name: "cloud.sign-out", why: "drops the human's cloud credential; the human clicks" },
  { name: "auth.sign-in", why: "the GitHub OAuth redirect yanks the page; the human clicks (auth.prompt is the agent's door)" },
  { name: "auth.sign-out", why: "drops the human's session; the human clicks" },
  { name: "flows", why: "surface switch: the model lists flows with flow.list, which answers as an embedded card" }
]

export const baseFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  /*
   * Shared declarations used by the registry and UI controls.
   */
  const THEME = {
    name: "appearance.theme",
    summary: "Set the color theme",
    args: PALETTES.join(" | "),
    input: Schema.Struct({ palette: Schema.String }),
    handler: ({ palette }: { readonly palette: string }) => actions.setPalette(palette)
  }
  const DARK_MODE = {
    name: "appearance.dark-mode",
    summary: "Toggle light and dark mode",
    input: NoPayload,
    handler: () => actions.toggleTheme()
  }
  const SURFACES = {
    name: "chat.surfaces",
    summary: "Open the surfaces menu",
    input: NoPayload,
    handler: () => actions.toggleSurfacesMenu()
  }
  /*
   * The maintainer's switch: every flow invocation (hidden, aliased,
   * agent-driven, deferred) and every background or system transition
   * renders as a trace line, and the transition logger writes to the
   * console. Registered for every session rather than the admin plugin:
   * the local host has no identity seam, so an admin gate would make the
   * switch unreachable exactly where the maintainer runs the app.
   */
  const VERBOSE = {
    name: "debug.verbose",
    summary: "Show everything Smithers is doing",
    input: NoPayload,
    handler: () => actions.toggleVerbose()
  }
  const RETRY = {
    name: "chat.retry",
    summary: "Retry the last turn",
    input: NoPayload,
    handler: () => actions.retryLastTurn()
  }
  const SEND = {
    name: "chat.send",
    summary: "Submit the composer",
    userOnly: true,
    userOnlyReason: "the composer is the human's; the model is already the turn, and sending would nest one",
    args: "<text>",
    input: Schema.Struct({ text: Schema.String }),
    handler: ({ text }: { readonly text: string }) => {
      actions.send(text)
    }
  }
  /*
   * /chat.clear (§2h): sweep the outgoing transcript for what belongs in
   * world, keep it, THEN clear — a failed sweep clears nothing.
   */
  const CLEAR = {
    name: "chat.clear",
    summary: "Clear the chat, keeping anything worth remembering",
    input: NoPayload,
    handler: () => actions.clearConversation()
  }
  /* The browser tool + surface (§2d/§2d′): read a page; embed its card. */
  const BROWSER = {
    name: "browser.open",
    summary: "Open a web page as a card Smithers can read",
    runtime: ["agent"] as const,
    args: "<url>",
    capabilities: ["session:net-read"],
    input: Schema.Struct({ url: Schema.String }),
    handler: ({ url }: { readonly url: string }) => actions.openBrowser(url)
  }
  /*
   * The explainer inside the app (AgentRoles.ts): one side turn on the
   * explainer role, answered as an embedded card. Callable by the model and
   * by a human through `/agent.explain`.
   */
  const EXPLAIN = {
    name: "agent.explain",
    summary: "Ask the Explainer to explain something",
    runtime: ["agent"] as const,
    args: "<what>",
    input: Schema.Struct({ what: Schema.String }),
    handler: ({ what }: { readonly what: string }) => actions.explain(what)
  }
  const COPY_MESSAGE = {
    name: "chat.copy-message",
    summary: "Copy a message to the clipboard",
    hidden: true,
    userOnly: true,
    userOnlyReason: "the clipboard write is the human's browser gesture",
    args: "<text>",
    input: Schema.Struct({ text: Schema.String }),
    /*
     * A.26: `void navigator.clipboard.writeText(...)` let the browser's
     * NotAllowedError escape as an unhandled rejection — the only trace was
     * a POST to /api/client-errors, and the human who pressed Copy was told
     * nothing at all. The refusal is awaited and answered.
     */
    handler: async ({ text }: { readonly text: string }) => {
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
  }
  /* The one-keystroke recovery: reload the window (dev loop, stuck states). */
  const RELOAD = {
    name: "chat.reload",
    summary: "Reload the app",
    input: NoPayload,
    handler: () => actions.reloadApp()
  }
  /*
   * The full catalog as a chat message: the slash menu caps at 8 for calm,
   * so THIS is where "show me everything" lives — for the user typed, and
   * for the agent answering "what can you do".
   */
  const COMMANDS = {
    name: "chat.commands",
    summary: "List everything Smithers can do",
    input: NoPayload,
    handler: () => actions.showCommandCatalog()
  }
  return [
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
     * Ask 5 (will, 2026-09-02): the fourth surface — the workspace's flows,
     * beside chat, connect and world. User-only: the model lists flows with
     * flow.list, whose answer is an embedded card (THE EMBED LAW), so opening
     * a pane stays the human's own act.
     */
    name: "flows",
    summary: "See the flows on your workspace",
    userOnly: true,
    userOnlyReason: "a surface switch; the model lists flows with flow.list, which answers as an embedded card",
    input: NoPayload,
    handler: () => actions.showFlows()
  }),
  /*
   * `appearance.*` — look and feel. The color theme is the axis orthogonal to
   * light/dark: `/appearance.theme <key>` wears a palette, bare answers with
   * the list and where the human already is. User-only browser chrome.
   */
  flow(THEME),
  flow(DARK_MODE),
  /*
   * `chat.*` — the conversation's own controls. C-1 (wave 13): the composer's
   * surfaces-menu trigger is a flow like every other affordance — the button
   * dispatches /chat.surfaces, and the name typed opens the same menu.
   */
  flow(SURFACES),
  flow(VERBOSE),
  flow({
    /*
     * The next-step recommender (state/Recommend.ts): system-invoked after
     * every material transition, never listed, never the model's to call —
     * a model must not steer what the human is offered next.
     */
    name: "system.recommend",
    summary: "Refresh the next-step suggestions",
    hidden: true,
    userOnly: true,
    userOnlyReason: "the system's own refresh; a model must not steer what the human is offered next",
    input: NoPayload,
    handler: () => actions.recommend()
  }),
  flow({
    /*
     * The three surface switches (chat, world, connect) are the app's own top
     * level, so they alone stay bare: `/chat` under any prefix reads wrong.
     */
    name: "chat",
    summary: "Back to the conversation",
    input: NoPayload,
    handler: () => actions.showChat()
  }),
  flow(RETRY),
  flow({
    name: "chat.stop",
    summary: "Stop the current response",
    userOnly: true,
    userOnlyReason: "stopping the model's own turn is the human's Escape key",
    input: NoPayload,
    handler: () => actions.stop()
  }),
  flow(SEND),
  flow(CLEAR),
  flow(BROWSER),
  flow({
    /*
     * Wave 11 — "make me a workflow". The agent invokes this with the user's
     * description; the run renders as an embedded run card tracked live from
     * the relay event stream (THE EMBED LAW).
     *
     * Wave 12 §2: a trailing `owner/repo` names the target. Without one and
     * with more than one loaded repository, the chooser-among-loaded asks —
     * the target is a genuine user choice, not a guess.
     */
    name: "flow.create",
    summary: "Create a Smithers workflow from a description",
    runtime: ["jjhub"],
    args: "<description> [owner/repo]",
    requires: ["signed-in"],
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
    summary: "Choose which loaded repository a workflow belongs to",
    runtime: ["jjhub"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "the answer to the which-repository card is the human's choice; a model must not provision on its guess",
    args: "<owner/repo>",
    input: Schema.Struct({ repo: Schema.String }),
    handler: ({ repo }) => actions.chooseWorkflowRepo(repo)
  }),
  flow({
    /*
     * Wave 12 §3 — the acts a run that has gone quiet offers, bound to the
     * card's buttons. Hidden from the slash menu and the catalog. Stopping a
     * run is consequential (the cancel is durable), so the model may ASK but
     * never perform it: `confirm` turns an agent invocation into a
     * confirmation message whose button runs the stop as the user.
     */
    name: "flow.run.stop",
    summary: "Stop a run",
    runtime: ["jjhub"],
    hidden: true,
    confirm: "stop the run",
    args: "<cardId> [reason]",
    input: Schema.Struct({
      cardId: Schema.String,
      reason: Schema.optional(Schema.String)
    }),
    handler: ({ cardId, reason }) => actions.stopWatchingRun(cardId, reason)
  }),
  flow({
    /* A retry spends (agent-parity.md): the model may ask, the human confirms. */
    name: "flow.run.retry",
    summary: "Check a run again",
    runtime: ["jjhub"],
    hidden: true,
    confirm: "check the run again",
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.retryRunWatch(cardId)
  }),
  flow({
    name: "flow.list",
    summary: "List the workflows on your workspace",
    runtime: ["jjhub"],
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.listWorkspaceWorkflows()
  }),
  flow({
    name: "flow.run",
    form: { fields: { name: { label: "Workflow" }, repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "Run a workflow on your workspace",
    runtime: ["jjhub"],
    args: "<name> [owner/repo]",
    requires: ["signed-in"],
    capabilities: ["outbound:launch"],
    input: Schema.Struct({
      name: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ name, repo }) => actions.runWorkflow(name, repo)
  }),
  /*
   * Lane runs — the run lifecycle beyond launch.
   *
   * The inbox (runs.list) answers from the workspace-runs projection; every
   * act is a control procedure over the gateway seam. What the wire does not
   * carry, the flow refuses in words: `by=` names a launcher the run summary
   * does not record, so it is a refusal, never a silently dropped filter.
   */
  flow({
    name: "runs.list",
    form: {
      fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) =>
        line(
          text(payload, "status"),
          text(payload, "flow"),
          text(payload, "by") === undefined ? undefined : `by=${text(payload, "by")}`,
          text(payload, "lineage") === undefined ? undefined : `lineage=${text(payload, "lineage")}`,
          text(payload, "repo")
        )
    },
    summary: "List the runs on your workspace",
    runtime: ["jjhub"],
    args: "[status] [flow] [by=principal] [lineage=id] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      status: Schema.optional(Schema.String),
      flow: Schema.optional(Schema.String),
      lineage: Schema.optional(Schema.String),
      by: Schema.optional(Schema.String),
      repo: Schema.optional(Schema.String)
    }),
    handler: (payload) => actions.listRuns(payload)
  }),
  flow({
    name: "runs.open",
    summary: "Open a run as a card that tracks it",
    runtime: ["jjhub"],
    args: "<runId> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      runId: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ runId, repo }) => actions.openRun(runId, repo)
  }),
  flow({
    name: "runs.resume",
    confirm: "resume the run",
    summary: "Resume a parked run",
    runtime: ["jjhub"],
    args: "<runId>",
    requires: ["signed-in"],
    input: Schema.Struct({ runId: Schema.String }),
    handler: ({ runId }) => actions.resumeRun(runId)
  }),
  flow({
    /* A relaunch is real work on the user's workspace: the launch capability. */
    name: "runs.rerun",
    summary: "Run a run's flow again with the same input",
    runtime: ["jjhub"],
    args: "<runId>",
    requires: ["signed-in"],
    capabilities: ["outbound:launch"],
    input: Schema.Struct({ runId: Schema.String }),
    handler: ({ runId }) => actions.rerunRun(runId)
  }),
  flow({
    name: "runs.signal",
    confirm: "release the run's wait with a signal",
    summary: "Deliver a named signal to a waiting run",
    runtime: ["jjhub"],
    args: "<runId> <name> [json]",
    requires: ["signed-in"],
    input: Schema.Struct({
      runId: Schema.String,
      name: Schema.String,
      payload: Schema.optional(Schema.String)
    }),
    handler: ({ runId, name, payload }) => actions.signalRun(runId, name, payload)
  }),
  flow({
    name: "runs.steer",
    confirm: "steer the running agent",
    summary: "Send an operator message into a running run",
    runtime: ["jjhub"],
    args: "<runId> <message>",
    requires: ["signed-in"],
    input: Schema.Struct({ runId: Schema.String, body: Schema.String }),
    handler: ({ runId, body }) => actions.steerRun(runId, body)
  }),
  flow({
    name: "runs.seat",
    confirm: "change the run's seat",
    summary: "Move a run to a different model seat",
    runtime: ["jjhub"],
    args: "<runId> <seat>",
    requires: ["signed-in"],
    input: Schema.Struct({ runId: Schema.String, seat: Schema.String }),
    handler: ({ runId, seat }) => actions.steerRunSeat(runId, seat)
  }),
  flow({
    name: "runs.thinking",
    confirm: "change the run's thinking level",
    summary: "Change a run's thinking level",
    runtime: ["jjhub"],
    args: "<runId> <level>",
    requires: ["signed-in"],
    input: Schema.Struct({ runId: Schema.String, thinking: Schema.String }),
    handler: ({ runId, thinking }) => actions.steerRunThinking(runId, thinking)
  }),
  flow({
    name: "runs.tools",
    confirm: "change the run's tools",
    summary: "Add tools to a run's active set",
    runtime: ["jjhub"],
    args: "<runId> <names,comma-separated>",
    requires: ["signed-in"],
    input: Schema.Struct({ runId: Schema.String, toolNames: Schema.String }),
    handler: ({ runId, toolNames }) => actions.steerRunTools(runId, toolNames)
  }),
  flow({
    name: "runs.logs",
    summary: "Show a run's transcript on its card (--follow keeps it live)",
    runtime: ["jjhub"],
    args: "<runId> [--follow]",
    requires: ["signed-in"],
    input: Schema.Struct({
      runId: Schema.String,
      follow: Schema.optional(Schema.Boolean)
    }),
    handler: ({ runId, follow }) => actions.showRunLogs(runId, follow)
  }),
  flow({
    /* The run card's Steps tab: the card's own presentation act, so it stays hidden. */
    name: "runs.steps",
    summary: "Show a run's steps on its card",
    runtime: ["jjhub"],
    hidden: true,
    args: "<runId>",
    input: Schema.Struct({ runId: Schema.String }),
    handler: ({ runId }) => actions.showRunSteps(runId)
  }),
  flow({
    /* The raw journal is a debug surface; the controller gates it on verbose. */
    name: "runs.events",
    summary: "Show a run's raw events on its card (verbose)",
    runtime: ["jjhub"],
    args: "<runId>",
    requires: ["signed-in"],
    input: Schema.Struct({ runId: Schema.String }),
    handler: ({ runId }) => actions.showRunEvents(runId)
  }),
  flow({
    /* Stopping every run is consequential: agent invocations confirm first. */
    name: "flow.run.stop-all",
    summary: "Stop every live run on your workspace",
    runtime: ["jjhub"],
    hidden: true,
    confirm: "stop every run",
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ repo: Schema.optional(Schema.String) }),
    handler: ({ repo }) => actions.stopAllRuns(repo)
  }),
  flow({
    name: "approvals.list",
    summary: "List the workspace's pending approvals",
    runtime: ["jjhub"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ repo: Schema.optional(Schema.String) }),
    handler: ({ repo }) => actions.listApprovals(repo)
  }),
  flow({
    name: "approvals.open",
    summary: "Open a run's pending approvals as cards",
    runtime: ["jjhub"],
    args: "<runId>",
    requires: ["signed-in"],
    input: Schema.Struct({ runId: Schema.String }),
    handler: ({ runId }) => actions.openApproval(runId)
  }),
  flow({
    /* Maximize is the user's explicit act alone (THE EMBED LAW). */
    name: "card.maximize",
    summary: "Maximize a card",
    hidden: true,
    userOnly: true,
    userOnlyReason: "maximizing a card is the human's explicit act (THE EMBED LAW)",
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.maximizeCard(cardId)
  }),
  flow({
    name: "card.minimize",
    summary: "Minimize the maximized card",
    hidden: true,
    userOnly: true,
    userOnlyReason: "minimizing a card is the human's explicit act",
    input: NoPayload,
    handler: () => actions.minimizeCard()
  }),
  flow({
    /* THE FORM LAW: a form card's Cancel. Only form cards dismiss; the handler refuses the rest by kind. */
    name: "card.dismiss",
    summary: "Dismiss a form card",
    hidden: true,
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.dismissCard(cardId)
  }),
  flow({
    name: "frame.back",
    summary: "Go to the previous frame",
    hidden: true,
    userOnly: true,
    userOnlyReason: "frame navigation is the human's browser gesture",
    input: NoPayload,
    handler: () => actions.frameBack()
  }),
  flow({
    name: "frame.forward",
    summary: "Go to the next frame",
    hidden: true,
    userOnly: true,
    userOnlyReason: "frame navigation is the human's browser gesture",
    input: NoPayload,
    handler: () => actions.frameForward()
  }),
  flow({
    name: "frame.fork",
    summary: "Fork the current frame",
    hidden: true,
    userOnly: true,
    userOnlyReason: "forking a frame is the human's browser gesture",
    input: NoPayload,
    handler: () => actions.forkFrame()
  }),
  flow(COPY_MESSAGE),
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
    runtime: ["local.repositories"],
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
    runtime: ["local.repositories"],
    hidden: true,
    args: "<connectorId>",
    input: Schema.Struct({ connectorId: Schema.String }),
    handler: ({ connectorId }) => {
      actions.makeConnectorReadOnly(connectorId)
    }
  }),
  flow({
    name: "connector.remove.ask",
    summary: "Ask before disconnecting a repository",
    runtime: ["local.repositories"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "opens the human's confirm dialog; the act itself is connector.remove",
    args: "<connectorId>",
    input: Schema.Struct({ connectorId: Schema.String }),
    handler: ({ connectorId }) => actions.askConnectorRemoval(connectorId)
  }),
  flow({
    name: "connector.remove",
    summary: "Disconnect a repository",
    runtime: ["local.repositories"],
    hidden: true,
    args: "<connectorId>",
    input: Schema.Struct({ connectorId: Schema.String }),
    handler: ({ connectorId }) => {
      actions.removeConnector(connectorId)
    }
  }),
  flow({
    name: "connector.remove.cancel",
    summary: "Keep a connected repository",
    runtime: ["local.repositories"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.cancelConnectorRemoval()
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
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.confirmWorldDelete()
  }),
  flow({
    name: "world.delete.cancel",
    summary: "Keep the note Smithers asked about",
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.cancelWorldDelete()
  }),
  flow({
    /*
     * The OAuth redirect leaves the page (or, natively, opens the system
     * browser): the human's gesture, so user-only — auth.prompt below is the
     * agent's door, rendering this button in the chat.
     */
    name: "auth.sign-in",
    summary: "Sign in with GitHub",
    runtime: ["identity"],
    userOnly: true,
    userOnlyReason: "the GitHub OAuth redirect is the human's browser gesture; the agent renders the step with auth.prompt",
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
    runtime: ["identity"],
    input: NoPayload,
    handler: () => actions.promptSignIn()
  }),
  flow({
    /* Signing out needs a session: offering it signed out is the clearest
		   case of a listing that names a step the user cannot take (§1.2). */
    name: "auth.sign-out",
    summary: "Sign out of Smithers",
    runtime: ["identity"],
    userOnly: true,
    userOnlyReason: "dropping the human's session is theirs alone",
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.signOut()
  }),
  flow({
    name: "auth.request-access",
    summary: "Request access to Smithers",
    runtime: ["identity"],
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.requestAccess()
  }),
  /*
   * The web app's one door to the native app (docs/web-mode/PLAN.md §3). The
   * split mirrors auth.sign-in / auth.prompt: `window.open` outside a user
   * gesture is popup-blocked, so the model renders the card and the click is
   * the human's. Both exist only on the cloud host — native chrome gains
   * nothing, and the native model is never told to offer a download.
   */
  flow({
    name: "app.download",
    summary: "Download the native Smithers app",
    hosts: ["cloud"],
    /* The chrome button and the refusal card's action; the prompt flow is the listed door. */
    hidden: true,
    userOnly: true,
    userOnlyReason: "a browser handoff the human clicks; the agent renders the step with app.download.prompt",
    input: NoPayload,
    handler: () => actions.openDownload()
  }),
  flow({
    name: "app.download.prompt",
    summary: "Offer the native app download in the chat",
    hosts: ["cloud"],
    args: "[flow]",
    input: Schema.Struct({ flow: Schema.optional(Schema.String) }),
    handler: ({ flow }) => actions.promptDownload(flow)
  }),
  /*
   * Lane piper (ADR 0001): the jjhub Cloud login is the CLI's browser flow —
   * Bun listens for the callback and holds the token (the keychain at rest);
   * the renderer only opens the URL through the native door. Browser
   * mechanics the human clicks, so user-only, like auth.sign-in.
   */
  flow({
    name: "cloud.sign-in",
    summary: "Sign in to Smithers Cloud",
    runtime: ["jjhub", "cloud.pat"],
    userOnly: true,
    userOnlyReason:
      "the Smithers Cloud browser login is the human's gesture on their account; the agent renders the step with cloud.prompt",
    input: NoPayload,
    handler: () => actions.signInCloud()
  }),
  flow({
    /*
     * The agent's door to the Cloud session, mirroring auth.prompt: it cannot
     * run cloud.sign-in, but it CAN render the step — the message's action IS
     * the sign-in button. Registered wherever jjhub is: on the web the GitHub
     * sign-in is the Cloud sign-in, and the controller offers that step.
     */
    name: "cloud.prompt",
    summary: "Offer the Smithers Cloud sign-in step in the chat",
    runtime: ["jjhub"],
    input: NoPayload,
    handler: () => actions.promptCloudSignIn()
  }),
  flow({
    name: "cloud.sign-out",
    summary: "Sign out of Smithers Cloud",
    runtime: ["jjhub", "cloud.pat"],
    userOnly: true,
    userOnlyReason: "dropping the human's Smithers Cloud credential is theirs alone",
    input: NoPayload,
    handler: () => actions.signOutCloud()
  }),
  flow({
    name: "toast.dismiss",
    summary: "Dismiss a toast notification",
    hidden: true,
    userOnly: true,
    userOnlyReason: "dismissing a toast is the human's gesture",
    args: "<toastId>",
    input: Schema.Struct({ toastId: Schema.String }),
    handler: ({ toastId }) => {
      actions.dismissToast(toastId)
    }
  }),
  flow({
    name: "billing.balance",
    summary: "Show your balance",
    runtime: ["identity"],
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
    runtime: ["jjhub"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.importRepository(repo)
  }),
  flow({
    name: "issues.list",
    summary: "List a repository's issues",
    runtime: ["jjhub"],
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
    runtime: ["jjhub"],
    args: "<number> [owner/repo]",
    requires: ["signed-in"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.viewIssue(number, repo)
  }),
  flow({
    name: "issues.create",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "Create an issue",
    runtime: ["jjhub"],
    args: "<title> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ title: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ title, repo }) => actions.createIssue(title, repo)
  }),
  flow({
    name: "issues.close",
    summary: "Close an issue",
    runtime: ["jjhub"],
    args: "<number> [owner/repo]",
    requires: ["signed-in"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.setIssueState(number, "closed", repo)
  }),
  flow({
    name: "issues.reopen",
    summary: "Reopen a closed issue",
    runtime: ["jjhub"],
    args: "<number> [owner/repo]",
    requires: ["signed-in"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.setIssueState(number, "open", repo)
  }),
  flow({
    name: "issues.comment",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "Comment on an issue",
    runtime: ["jjhub"],
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
    runtime: ["jjhub"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.listLandings(repo)
  }),
  flow({
    name: "prs.view",
    summary: "Open a pull request with reviews and checks",
    runtime: ["jjhub"],
    args: "<number> [owner/repo]",
    requires: ["signed-in"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.viewLanding(number, repo)
  }),
  flow({
    name: "prs.create",
    form: {
      fields: { from: { optionsFrom: "bookmarks", kind: "text", label: "From bookmark" }, repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) => line(text(payload, "title"), text(payload, "from") === undefined ? undefined : `from:${text(payload, "from")}`, text(payload, "repo"))
    },
    summary: "Open a pull request",
    runtime: ["jjhub"],
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
     * Landing is consequential (it queues a merge), so the model may ASK for
     * it but never perform it: `confirm` turns an agent invocation into a
     * confirmation message whose button runs the land as the user.
     */
    name: "prs.land",
    summary: "Land a pull request (queues the merge)",
    runtime: ["jjhub"],
    confirm: "land the pull request",
    args: "<number> [owner/repo]",
    requires: ["signed-in"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.landLanding(number, repo)
  }),
  flow({
    name: "prs.review",
    form: {
      fields: { text: { required: false }, repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) =>
        line(text(payload, "number"), text(payload, "verdict") === "request_changes" ? "request-changes" : text(payload, "verdict"), text(payload, "text"), text(payload, "repo"))
    },
    summary: "Review a pull request",
    runtime: ["jjhub"],
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
    runtime: ["keys.byok"],
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.listKeys()
  }),
  flow({
    /* Removing a credential is destructive: agent invocations confirm first. */
    name: "keys.remove",
    summary: "Remove a provider API key",
    runtime: ["keys.byok"],
    confirm: "remove the provider API key",
    args: "<provider>",
    requires: ["signed-in"],
    input: Schema.Struct({ provider: Schema.String }),
    handler: ({ provider }) => actions.removeKey(provider)
  }),
  flow({
    name: "notifications.list",
    summary: "Show your notifications",
    runtime: ["jjhub"],
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.listNotifications()
  }),
  flow({
    name: "notifications.read",
    summary: "Mark every notification read",
    runtime: ["jjhub"],
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.markNotificationsRead()
  }),
  flow({
    name: "env.view",
    summary: "Show a repository's agent environment",
    runtime: ["jjhub"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.viewEnvironment(repo)
  }),
  flow({
    name: "env.set",
    summary: "Set an agent-environment variable",
    runtime: ["jjhub"],
    args: "<NAME=value> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ assignment: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ assignment, repo }) => actions.setEnvironmentVar(assignment, repo)
  }),
  flow({
    name: "branches.list",
    summary: "List a repository's branches (bookmarks)",
    runtime: ["jjhub"],
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
    runtimeAny: ["jjhub", "local.repositories"],
    args: "[path] [owner/repo]",
    requires: ["repo-source"],
    input: Schema.Struct({ path: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ path, repo }) => actions.listFiles(path, repo)
  }),
  flow({
    name: "files.read",
    form: {
      fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) => line([text(payload, "path"), text(payload, "line"), text(payload, "column")].filter((part) => part !== undefined).join(":"), text(payload, "repo"))
    },
    summary: "Read a file from a repository",
    runtimeAny: ["jjhub", "local.repositories"],
    /* `:line[:col]` (docs/code-intel/PLAN.md §1): the card scrolls to and marks the line; the parser strips it off the path token. */
    args: "<path>[:<line>[:<col>]] [owner/repo]",
    requires: ["repo-source"],
    input: Schema.Struct({
      path: Schema.String,
      repo: Schema.optional(Schema.String),
      line: Schema.optional(Schema.Number),
      column: Schema.optional(Schema.Number)
    }),
    handler: ({ path, repo, line, column }) =>
      actions.readFile(path, repo, line === undefined ? undefined : { line, ...(column === undefined ? {} : { column }) })
  }),
  /*
   * Code intelligence (docs/code-intel/PLAN.md §4): three reads against the
   * local app's language server, one act each with the three doors, none
   * confirming. Each answers `{ value }` to the model and patches the human's
   * FILE card (hover, diagnostics, what the card knows about the server); the
   * definition opens its target through files.read's line anchor. The door is
   * the native host's `local.lsp`, so the web catalog never lists them.
   */
  flow({
    name: "code.hover",
    form: {
      fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) => line(`${text(payload, "path") ?? ""}:${text(payload, "line") ?? ""}:${text(payload, "column") ?? ""}`, text(payload, "repo"))
    },
    summary: "The type and docs of the symbol at a position",
    runtime: ["local.lsp"],
    args: "<path>:<line>:<col> [owner/repo]",
    input: CodePosition,
    handler: ({ path, line, column, repo }) => actions.codeHover(path, line, column, repo)
  }),
  flow({
    name: "code.definition",
    form: {
      fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) => line(`${text(payload, "path") ?? ""}:${text(payload, "line") ?? ""}:${text(payload, "column") ?? ""}`, text(payload, "repo"))
    },
    summary: "Where the symbol at a position is defined; opens that file at the line",
    runtime: ["local.lsp"],
    args: "<path>:<line>:<col> [owner/repo]",
    input: CodePosition,
    handler: ({ path, line, column, repo }) => actions.codeDefinition(path, line, column, repo)
  }),
  flow({
    name: "code.diagnostics",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "The language server's errors and warnings for a file",
    runtime: ["local.lsp"],
    args: "<path> [owner/repo]",
    input: Schema.Struct({ path: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ path, repo }) => actions.codeDiagnostics(path, repo)
  }),
  /*
   * Lane sync (ADR 0005): Linear and GitHub sync as actions. The reads
   * render the connector-setup and sync-ops cards; the writes ride the same
   * seams. Every route these acts call exists on plue's own router; a server
   * that has not deployed one answers, and the seam surfaces that answer.
   */
  flow({
    name: "github.app",
    summary: "Check the Smithers GitHub App on a repository",
    runtime: ["jjhub"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.githubApp(repo)
  }),
  flow({
    /* The card's Install button — browser mechanics the human clicks. */
    name: "github.app.open",
    summary: "Open the GitHub App's install page",
    hidden: true,
    runtime: ["jjhub"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.githubOpenInstall(repo)
  }),
  flow({
    name: "github.reconcile",
    summary: "Re-derive the GitHub App's wiring, then re-read the status",
    runtime: ["jjhub"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.githubReconcile(repo)
  }),
  flow({
    name: "github.mirror-sync",
    summary: "Pull GitHub into the repository's mirror",
    runtime: ["jjhub"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.githubMirrorSync(repo)
  }),
  flow({
    /*
     * plue#491: one failed ref, pushed again. The ref name carries slashes
     * and rides as one escaped path segment; the answer is a new mirror run,
     * which the same card then tracks.
     */
    name: "github.mirror.retry-ref",
    summary: "Retry one failed mirror ref",
    runtime: ["jjhub"],
    args: "<ref> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ ref: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ ref, repo }) => actions.retryMirrorRef(ref, repo)
  }),
  flow({
    name: "repos.import.retry",
    summary: "Retry a failed GitHub import job",
    runtime: ["jjhub"],
    args: "<jobId>",
    requires: ["signed-in"],
    input: Schema.Struct({ jobId: Schema.String }),
    handler: ({ jobId }) => actions.retryImport(jobId)
  }),
  flow({
    name: "linear.connect",
    summary: "Connect a repository to a Linear team",
    /* The wizard's Linear OAuth lands on the host's `/api/linear-auth/*` loopback, a PAT-session door. */
    runtime: ["jjhub", "cloud.pat"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.linearConnect(repo)
  }),
  flow({
    /* The wizard card's step buttons — browser mechanics the human clicks. */
    name: "linear.connect.open",
    summary: "Open Linear to authorize the connection",
    hidden: true,
    runtime: ["jjhub", "cloud.pat"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.linearConnectOpen(repo)
  }),
  flow({
    name: "linear.connect.team",
    summary: "Pick the Linear team for the connection",
    hidden: true,
    runtime: ["jjhub", "cloud.pat"],
    args: "<teamId> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ teamId: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ teamId, repo }) => actions.linearConnectTeam(teamId, repo)
  }),
  flow({
    name: "linear.connect.repo",
    summary: "Pick the repository for the connection",
    hidden: true,
    runtime: ["jjhub", "cloud.pat"],
    args: "<cardRepo> <owner/repo>",
    requires: ["signed-in"],
    input: Schema.Struct({ cardRepo: Schema.String, repo: Schema.String }),
    handler: ({ cardRepo, repo }) => actions.linearConnectRepo(cardRepo, repo)
  }),
  flow({
    name: "linear.connect.confirm",
    summary: "Create the Linear integration the wizard gathered",
    runtime: ["jjhub", "cloud.pat"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.linearConnectConfirm(repo)
  }),
  flow({
    name: "linear.sync",
    summary: "Sync a Linear integration now",
    runtime: ["jjhub"],
    args: "[integration]",
    requires: ["signed-in"],
    input: Schema.Struct({ integration: Schema.optional(Schema.String) }),
    handler: ({ integration }) => actions.linearSync(integration)
  }),
  flow({
    name: "linear.activity",
    summary: "Show a Linear integration's last 24 hours",
    runtime: ["jjhub"],
    args: "[integration]",
    requires: ["signed-in"],
    input: Schema.Struct({ integration: Schema.optional(Schema.String) }),
    handler: ({ integration }) => actions.linearActivity(integration)
  }),
  flow({
    /* Disconnecting drops every issue's Linear link: agent invocations confirm first. */
    name: "linear.disconnect",
    form: { fields: { confirmKey: { label: "Team key, typed back" } } },
    summary: "Disconnect a Linear integration",
    runtime: ["jjhub"],
    confirm: "disconnect the Linear integration",
    /* The team key typed back is the flow's own input: the seam disconnects only when it matches, whoever invoked. */
    args: "<integration> <teamKey>",
    requires: ["signed-in"],
    input: Schema.Struct({ integration: Schema.String, confirmKey: Schema.optional(Schema.String) }),
    handler: ({ integration, confirmKey }) => actions.linearDisconnect(integration, confirmKey)
  }),
  flow({
    name: "sync.retry",
    summary: "Retry one failed sync op",
    runtime: ["jjhub"],
    args: "<opId>",
    requires: ["signed-in"],
    input: Schema.Struct({ opId: Schema.String }),
    handler: ({ opId }) => actions.retrySyncOp(opId)
  }),
  flow({
    /* The sync-ops card's Show more — browser mechanics the human clicks. */
    name: "sync.ops.show-more",
    summary: "Widen a sync card's ops window",
    hidden: true,
    runtime: ["jjhub"],
    args: "<cardId>",
    requires: ["signed-in"],
    input: Schema.Struct({ cardId: Schema.String }),
    handler: ({ cardId }) => actions.showMoreSyncOps(cardId)
  }),
  flow({
    /* The sync-ops card's Load older — pages the feed past the 24-hour window. */
    name: "sync.ops.load-older",
    summary: "Load a sync card's older ops",
    hidden: true,
    runtime: ["jjhub"],
    args: "<cardId>",
    requires: ["signed-in"],
    input: Schema.Struct({ cardId: Schema.String }),
    handler: ({ cardId }) => actions.loadOlderSyncOps(cardId)
  }),
  flow({
    name: "issues.link-linear",
    form: { fields: { number: { label: "Issue number" }, identifier: { label: "Linear identifier" }, repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "Link an issue to a Linear identifier",
    runtime: ["jjhub"],
    args: "<number> <identifier> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      number: Schema.Number,
      identifier: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ number, identifier, repo }) => actions.linkIssueLinear(number, identifier, repo)
  }),
  flow({
    name: "issues.unlink-linear",
    summary: "Remove an issue's Linear link",
    runtime: ["jjhub"],
    confirm: "remove the issue's Linear link",
    /* The identifier typed back is the flow's own input: the seam unlinks only when it matches, whoever invoked. */
    args: "<number> <identifier> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      number: Schema.Number,
      identifier: Schema.optional(Schema.String),
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ number, identifier, repo }) => actions.unlinkIssueLinear(number, identifier, repo)
  }),
  /*
   * Lane citc (ADR 0002): the persistent cloud computers. `workspace.open`
   * creates-or-reuses one on a bookmark and renders its card (the transcript
   * is the review surface); the acts ride the one seam; a bare act resolves
   * the active workspace copy, else the single loaded one. Destructive acts
   * are id-scoped and hidden — the card's buttons invoke them.
   */
  flow({
    name: "workspace.list",
    summary: "List your cloud workspaces",
    runtime: ["jjhub"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.listWorkspaces(repo)
  }),
  flow({
    /* Launching a cloud computer is an outbound act: the capability always asks. */
    name: "workspace.open",
    form: {
      fields: { bookmark: { optionsFrom: "bookmarks", kind: "text" }, repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) => line(text(payload, "bookmark"), text(payload, "repo"), flag(payload, "kind"))
    },
    summary: "Open (create or reuse) a Linux workspace in Smithers Cloud on a bookmark: a real machine with a terminal, files, and services the user can use",
    runtime: ["jjhub"],
    capabilities: ["outbound:launch"],
    /* ADR 0002: three sandbox kinds share one option surface, and the kind is the choice. */
    args: "[bookmark] [owner/repo] [--kind container|vm|desktop]",
    requires: ["signed-in"],
    input: Schema.Struct({
      bookmark: Schema.optional(Schema.String),
      repo: Schema.optional(Schema.String),
      kind: Schema.optional(Schema.Literals(["container", "vm", "desktop"]))
    }),
    handler: ({ bookmark, repo, kind }) => actions.openWorkspace(bookmark, repo, kind)
  }),
  flow({
    name: "workspace.view",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } } },
    summary: "Open one cloud workspace's card",
    runtime: ["jjhub"],
    args: "<workspaceId>",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.String }),
    handler: ({ workspaceId }) => actions.viewWorkspace(workspaceId)
  }),
  flow({
    name: "workspace.terminal",
    summary: "Open a terminal on a cloud workspace",
    /* The terminal rides this origin's `/api/cloud-ws/` tunnel: an origin without one registers no terminal. */
    runtime: ["jjhub", "cloud.terminal"],
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.openWorkspaceTerminal(workspaceId)
  }),
  flow({
    name: "workspace.suspend",
    summary: "Suspend a cloud workspace",
    runtime: ["jjhub"],
    confirm: "suspend the workspace",
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.suspendWorkspace(workspaceId)
  }),
  flow({
    name: "workspace.resume",
    summary: "Resume a cloud workspace",
    runtime: ["jjhub"],
    confirm: "resume the workspace",
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.resumeWorkspace(workspaceId)
  }),
  flow({
    name: "workspace.fork",
    summary: "Fork a cloud workspace",
    runtime: ["jjhub"],
    confirm: "fork the workspace",
    args: "[workspaceId] [name]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String), name: Schema.optional(Schema.String) }),
    handler: ({ workspaceId, name }) => actions.forkWorkspace(workspaceId, name)
  }),
  flow({
    name: "workspace.snapshot",
    summary: "Snapshot a cloud workspace",
    runtime: ["jjhub"],
    confirm: "snapshot the workspace",
    args: "[workspaceId] [name]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String), name: Schema.optional(Schema.String) }),
    handler: ({ workspaceId, name }) => actions.snapshotWorkspace(workspaceId, name)
  }),
  flow({
    name: "workspace.snapshot.delete",
    summary: "Delete a workspace snapshot",
    runtime: ["jjhub"],
    hidden: true,
    confirm: "delete the snapshot",
    args: "<snapshotId> [workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ snapshotId: Schema.String, workspaceId: Schema.optional(Schema.String) }),
    handler: ({ snapshotId, workspaceId }) => actions.deleteWorkspaceSnapshot(snapshotId, workspaceId)
  }),
  flow({
    /* The snapshot row's "Fork from": a new workspace whose image is the snapshot. */
    name: "workspace.snapshot.fork",
    summary: "Create a workspace from a snapshot",
    runtime: ["jjhub"],
    hidden: true,
    capabilities: ["outbound:launch"],
    confirm: "create a workspace from the snapshot",
    args: "<snapshotId> [workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ snapshotId: Schema.String, workspaceId: Schema.optional(Schema.String) }),
    handler: ({ snapshotId, workspaceId }) => actions.forkWorkspaceFromSnapshot(snapshotId, workspaceId)
  }),
  flow({
    name: "workspace.template",
    form: {
      fields: { workspaceId: { optionsFrom: "workspaces" } },
      args: (payload) => line(text(payload, "snapshotId"), text(payload, "workspaceId"), flag(payload, "name"))
    },
    summary: "Create a workspace template from a snapshot",
    runtime: ["jjhub"],
    args: "<snapshotId> <name> [workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({
      snapshotId: Schema.String,
      name: Schema.String,
      workspaceId: Schema.optional(Schema.String)
    }),
    handler: ({ snapshotId, name, workspaceId }) => actions.templateWorkspaceSnapshot(snapshotId, name, workspaceId)
  }),
  flow({
    name: "workspace.sessions",
    summary: "List a cloud workspace's sessions",
    runtime: ["jjhub"],
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.listWorkspaceSessions(workspaceId)
  }),
  flow({
    name: "workspace.session.destroy",
    summary: "Destroy a workspace session",
    runtime: ["jjhub"],
    hidden: true,
    confirm: "destroy the session",
    args: "<sessionId> [workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ sessionId: Schema.String, workspaceId: Schema.optional(Schema.String) }),
    handler: ({ sessionId, workspaceId }) => actions.destroyWorkspaceSession(sessionId, workspaceId)
  }),
  flow({
    name: "workspace.delete",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" }, confirmName: { label: "Name, typed back" } } },
    summary: "Delete a cloud workspace",
    runtime: ["jjhub"],
    hidden: true,
    confirm: "delete the workspace",
    /* The workspace's name typed back is the flow's own input: the seam deletes only when it matches, whoever invoked. */
    args: "<workspaceId> <name>",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.String, confirmName: Schema.String }),
    handler: ({ workspaceId, confirmName }) => actions.deleteWorkspace(workspaceId, confirmName)
  }),
  flow({
    /* The card's body tab: showing a facet is how the agent answers "show me the files" too (agent-parity.md). */
    name: "workspace.facet",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } } },
    summary: "Switch a workspace card's facet",
    runtime: ["jjhub"],
    args: "<workspaceId> <facet>",
    requires: ["signed-in"],
    input: Schema.Struct({
      workspaceId: Schema.String,
      facet: Schema.Literals(["terminal", "files", "services", "snapshots", "egress", "desktop"])
    }),
    handler: ({ workspaceId, facet }) => actions.setWorkspaceFacet(workspaceId, facet)
  }),
  /*
   * Lane L3: the facets plue#449 and the egress audit answer. Files and the
   * file read are ordinary reads — the model asks about a computer's working
   * copy the same way a human clicks the facet. The egress audit is cursor
   * paginated: a bare call reads the newest page, a cursor reads the page
   * behind it and the card appends.
   */
  flow({
    name: "workspace.files",
    summary: "List a cloud workspace's files under a directory",
    runtime: ["jjhub"],
    args: "[path] [workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ path: Schema.optional(Schema.String), workspaceId: Schema.optional(Schema.String) }),
    handler: ({ path, workspaceId }) => actions.listWorkspaceFiles(path, workspaceId)
  }),
  flow({
    name: "workspace.file",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } } },
    summary: "Read one file out of a cloud workspace",
    runtime: ["jjhub"],
    args: "<path> [workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ path: Schema.String, workspaceId: Schema.optional(Schema.String) }),
    handler: ({ path, workspaceId }) => actions.readWorkspaceFile(path, workspaceId)
  }),
  flow({
    name: "workspace.services",
    summary: "List a cloud workspace's services",
    runtime: ["jjhub"],
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.listWorkspaceServices(workspaceId)
  }),
  flow({
    name: "workspace.egress",
    summary: "List what a cloud workspace called out to, and which secret names were swapped in",
    runtime: ["jjhub"],
    args: "[workspaceId] [cursor]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String), cursor: Schema.optional(Schema.String) }),
    handler: ({ workspaceId, cursor }) => actions.listWorkspaceEgress(workspaceId, cursor)
  }),
  /*
   * Lane L3b: the desktop. `workspace.desktop` MINTS a session — an absolute,
   * already-credentialed stream URL carrying a live machine's VNC password —
   * so it carries `confirm`: the model may ask for it, the human performs it.
   * The credential never enters the store; the facet reads it out of module
   * memory (state/seams/DesktopStream.ts).
   */
  flow({
    name: "workspace.desktop",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } } },
    summary: "Open the desktop of a cloud workspace and stream it into the card",
    runtime: ["jjhub"],
    confirm: "open the workspace's desktop",
    args: "<workspaceId>",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.String }),
    handler: ({ workspaceId }) => actions.openWorkspaceDesktop(workspaceId)
  }),
  flow({
    /* Rotating changes the VNC password in the guest: the old iframe disconnects. */
    name: "workspace.desktop.rotate",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } } },
    summary: "Rotate a workspace desktop session",
    runtime: ["jjhub"],
    hidden: true,
    confirm: "rotate the desktop session",
    args: "<workspaceId>",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.String }),
    handler: ({ workspaceId }) => actions.rotateWorkspaceDesktop(workspaceId)
  }),
  flow({
    name: "workspace.images",
    summary: "List the environment images a repository has built for its workspaces",
    runtime: ["jjhub"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.listEnvironmentImages(repo)
  }),
  flow({
    /* The same audit for an agent session's sandbox; the app has no agent-session card to face it. */
    name: "egress.session",
    summary: "List what an agent session called out to, and which secret names were swapped in",
    runtime: ["jjhub"],
    args: "<sessionId> [owner/repo] [cursor]",
    requires: ["signed-in"],
    input: Schema.Struct({
      sessionId: Schema.String,
      repo: Schema.optional(Schema.String),
      cursor: Schema.optional(Schema.String)
    }),
    handler: ({ sessionId, repo, cursor }) => actions.listSessionEgress(sessionId, repo, cursor)
  }),
  /*
   * Lane change (ADR 0003): the change is the unit. `change.view` renders
   * the change card (one card per change, five facets); `change.diff`
   * renders the from → to pair; the acts ride the one seam. The acts that
   * have no route yet (resolve, revert, split-ready) refuse with the ADR's
   * wording rather than fake a backend. The repo resolves from the changes
   * collection, else the app's target repo — never a guess.
   */
  flow({
    name: "change.view",
    summary: "Open a change's card",
    runtime: ["jjhub"],
    args: "<changeId> [rev]",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, rev: Schema.optional(Schema.Number) }),
    handler: ({ changeId, rev }) => actions.viewChange(changeId, rev)
  }),
  flow({
    name: "change.diff",
    summary: "Open a change's diff at two pins",
    runtime: ["jjhub"],
    args: "<changeId> [from] [to] [path]",
    requires: ["signed-in"],
    input: Schema.Struct({
      changeId: Schema.String,
      from: Schema.optional(Schema.String),
      to: Schema.optional(Schema.String),
      path: Schema.optional(Schema.String)
    }),
    handler: ({ changeId, from, to, path }) => actions.diffChange(changeId, from, to, path)
  }),
  flow({
    name: "change.land",
    summary: "Land a change (its landing request, or its changeset atomically)",
    runtime: ["jjhub"],
    /* The scope is the whole unit: a landing request lands 1 → N (its stack, from its top change), a changeset every member; the card's button and the seam's line name N. */
    confirm: "land the change — the whole landing request 1 → N, or the whole changeset",
    args: "<changeId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String }),
    handler: ({ changeId }) => actions.landChange(changeId)
  }),
  flow({
    name: "change.split-ready",
    summary: "Split a changeset's ready members into a new change",
    runtime: ["jjhub"],
    confirm: "split the ready members into a new change",
    args: "<changeId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String }),
    handler: ({ changeId }) => actions.splitReadyChange(changeId)
  }),
  flow({
    /*
     * plue#489 moves the NAMED PATHS' diff into a new change and leaves the
     * original holding everything else, so the act is per path — plue refuses
     * an empty `paths` outright. The card offers it on the diff's file rows,
     * where the paths are, and only while the landing request's landable
     * prefix is shorter than its stack.
     */
    name: "change.split",
    summary: "Move a change's named paths into a new change",
    runtime: ["jjhub"],
    confirm: "move the named paths into a new change",
    args: "<changeId> <path> [path…]",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, paths: Schema.Array(Schema.String) }),
    handler: ({ changeId, paths }) => actions.splitChange(changeId, paths)
  }),
  flow({
    name: "change.resolve",
    summary: "Dispatch an agent to resolve a change's conflict",
    runtime: ["jjhub"],
    confirm: "dispatch an agent to resolve the conflict",
    args: "<changeId> <path>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, path: Schema.String }),
    handler: ({ changeId, path }) => actions.resolveChangeConflict(changeId, path)
  }),
  flow({
    name: "change.revert",
    summary: "Revert a landed change",
    runtime: ["jjhub"],
    confirm: "revert the landed change",
    args: "<changeId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String }),
    handler: ({ changeId }) => actions.revertChange(changeId)
  }),
  flow({
    /* The card's body tab: showing a facet is how the agent answers "show me the diff / the checks" (agent-parity.md). */
    name: "change.facet",
    summary: "Switch a change card's facet",
    runtime: ["jjhub"],
    args: "<changeId> <facet>",
    requires: ["signed-in"],
    input: Schema.Struct({
      changeId: Schema.String,
      facet: Schema.Literals(["walkthrough", "diff", "findings", "checks", "review", "history", "owners"])
    }),
    handler: ({ changeId, facet }) => actions.setChangeFacet(changeId, facet)
  }),
  /*
   * Lane L1 (ADR 0004, the live plue routes): the Diff facet's revision
   * pickers and the Checks facet's picker are the card's controls AND the
   * agent's answer to "show me the diff since rev 2" (agent-parity.md); the
   * thread transitions, the since-my-review pin, and the two finding acts are
   * flows with the same slash, agent, and button path; opening a computer
   * from a revision's snapshot is an outbound act.
   */
  flow({
    name: "change.pins",
    summary: "Pin a change card's diff between two revisions (parent|<rev> → <rev>|current)",
    runtime: ["jjhub"],
    args: "<changeId> <from> <to>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, from: Schema.String, to: Schema.String }),
    handler: ({ changeId, from, to }) => actions.setChangePins(changeId, from, to)
  }),
  flow({
    name: "change.checks",
    summary: "Read a change's checks at one revision",
    runtime: ["jjhub"],
    args: "<changeId> <seq>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, seq: Schema.Number }),
    handler: ({ changeId, seq }) => actions.checksOfChangeAt(changeId, seq)
  }),
  flow({
    /* Forking a revision's snapshot into a computer is an outbound act: the capability always asks. */
    name: "change.open-computer",
    summary: "Open the computer that produced a revision (fork its snapshot into a workspace)",
    runtime: ["jjhub"],
    hidden: true,
    capabilities: ["outbound:launch"],
    confirm: "open a computer from the revision's snapshot",
    args: "<changeId> <snapshotId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, snapshotId: Schema.String }),
    handler: ({ changeId, snapshotId }) => actions.openChangeComputer(changeId, snapshotId)
  }),
  flow({
    name: "review.since-mine",
    summary: "Open a change's diff since my last review",
    runtime: ["jjhub"],
    args: "<changeId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String }),
    handler: ({ changeId }) => actions.diffSinceMyReview(changeId)
  }),
  flow({
    name: "review.done",
    summary: "Mark a review thread done: the author addressed it at the current revision",
    runtime: ["jjhub"],
    args: "<changeId> <threadId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, threadId: Schema.Number }),
    handler: ({ changeId, threadId }) => actions.reviewThreadDone(changeId, threadId)
  }),
  flow({
    name: "review.ack",
    summary: "Acknowledge a done review thread: the reviewer accepts the author's work",
    runtime: ["jjhub"],
    args: "<changeId> <threadId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, threadId: Schema.Number }),
    handler: ({ changeId, threadId }) => actions.reviewThreadAck(changeId, threadId)
  }),
  flow({
    name: "review.reopen",
    summary: "Reopen a done or resolved review thread",
    runtime: ["jjhub"],
    args: "<changeId> <threadId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, threadId: Schema.Number }),
    handler: ({ changeId, threadId }) => actions.reviewThreadReopen(changeId, threadId)
  }),
  flow({
    /*
     * plue#488: a review request names EITHER a human login or an agent, so
     * `agent:<name>` is the one spelling that asks a named agent. Asking a
     * person to review is consequential — it notifies them and flips the
     * landing's turn — so the model may ask for it and only the human
     * performs it.
     */
    name: "review.request",
    form: { fields: { reviewer: { label: "Login or agent:name" } } },
    summary: "Ask someone to review a change",
    runtime: ["jjhub"],
    confirm: "request a review of the change",
    args: "<changeId> <login|agent:name>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, reviewer: Schema.String }),
    handler: ({ changeId, reviewer }) => actions.requestChangeReview(changeId, reviewer)
  }),
  flow({
    name: "review.unrequest",
    summary: "Dismiss a review request on a change",
    runtime: ["jjhub"],
    confirm: "dismiss the review request",
    args: "<changeId> <requestId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, requestId: Schema.Number }),
    handler: ({ changeId, requestId }) => actions.unrequestChangeReview(changeId, requestId)
  }),
  flow({
    name: "findings.please-fix",
    summary: "Dispatch the agent on one finding",
    runtime: ["jjhub"],
    confirm: "dispatch the agent on the finding",
    args: "<changeId> <findingId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, findingId: Schema.Number }),
    handler: ({ changeId, findingId }) => actions.fixFinding(changeId, findingId)
  }),
  flow({
    name: "findings.not-useful",
    summary: "Mark a finding not useful",
    runtime: ["jjhub"],
    args: "<changeId> <findingId>",
    requires: ["signed-in"],
    input: Schema.Struct({ changeId: Schema.String, findingId: Schema.Number }),
    handler: ({ changeId, findingId }) => actions.findingNotUseful(changeId, findingId)
  }),
  flow(RELOAD),
  flow(COMMANDS),
  /*
   * The local-app tabs (docs/LOCAL-APP.md "Tabs"): the strip, the `+` menu,
   * a maximized card's "Open in tab", and Cmd+T / Cmd+W / Cmd+1..9 all
   * invoke these — and so does the agent (the three-door law, AGENTS.md).
   * Opening a terminal or launching a harness is the product's main act,
   * not browser mechanics: the launches confirm (they spend and act on the
   * repository), the gestures (focus, the menu, a confirm answer) stay the
   * human's and say why.
   */
  flow({
    name: "tab.terminal",
    summary: "Open a terminal session (in an open working copy; the active one by default)",
    runtime: ["local.terminal"],
    args: "[cwd]",
    input: Schema.Struct({ cwd: Schema.optional(Schema.String) }),
    handler: ({ cwd }) => actions.openTerminalTab(cwd)
  }),
  flow({
    /*
     * Smithers is the first tab and reads every other one: the model (and a
     * human, via slash) gets a terminal or agent tab's recent output as text,
     * or a card tab's payload. The tab list itself rides every turn's runtime
     * context, so the model already knows the ids.
     */
    name: "tab.read",
    summary: "Read another session's recent output",
    args: "<tabId>",
    input: Schema.Struct({ tab: Schema.String }),
    handler: ({ tab }) => actions.readTab(tab)
  }),
  flow({
    /* Launching Claude Code / Codex / Gemini / OpenCode spends money and acts on the repo: the agent asks, the human confirms. */
    name: "tab.harness",
    form: { fields: { harnessId: { optionsFrom: "harnesses" } } },
    summary: "Open a harness session (Claude Code, Codex, Gemini, OpenCode)",
    runtime: ["local.harnesses"],
    confirm: "launch a harness as a session",
    args: "<harnessId>",
    input: Schema.Struct({ harnessId: Schema.String }),
    handler: ({ harnessId }) => actions.openHarnessTab(harnessId)
  }),
  flow({
    /*
     * A named role (AgentRoles.ts) from the `+` menus: the role's harness and
     * model launch in a tab, and the conversation gets the subagent card.
     * The same launch as tab.harness, so the same confirm.
     */
    name: "agent.role",
    form: { fields: { roleId: { optionsFrom: "agents" } } },
    summary: "Launch a named agent (built-in or custom) as a session",
    runtime: ["local.harnesses"],
    confirm: "launch an agent role as a session",
    args: "<roleId>",
    input: Schema.Struct({ roleId: Schema.String }),
    // A well-formed id resolves against the agents store in the controller; the store's list names the rest.
    handler: ({ roleId }) =>
      isAgentRoleId(roleId)
        ? actions.openHarnessTab("", { roleId })
        : `${roleId} is not an agent id (lowercase letters, digits and dashes). agent.list shows the agents.`
  }),
  flow({
    /*
     * The orchestrator's delegation: a role launches in its own tab with the
     * task as its first prompt, recorded as a subagent card here. The model
     * reads the result back with tab.read.
     */
    name: "agent.delegate",
    form: { fields: { roleId: { optionsFrom: "agents" } } },
    summary: "Delegate a task to an agent (built-in or custom; agent.list shows them)",
    runtime: ["local.harnesses"],
    args: "<role> <task>",
    input: Schema.Struct({ roleId: Schema.String, task: Schema.String }),
    handler: ({ roleId, task }) =>
      isAgentRoleId(roleId)
        ? actions.openHarnessTab("", { roleId, task })
        : `${roleId} is not an agent id (lowercase letters, digits and dashes). agent.list shows the agents.`
  }),
  flow(EXPLAIN),
  /*
   * Agents as data (docs/workbench-lanes/custom-agents.md): the agents are
   * rows the user manages from the chat. Listing and the form render cards;
   * creating, editing, and removing an agent define what may spend money on
   * the human's harnesses, so the agent asks and the human confirms. The
   * web host has no local harnesses: agent.list says so on its card, and
   * the rest are absent there (runtime).
   */
  flow({
    name: "agent.list",
    summary: "Show the agents: built-in and custom, with what each can launch here",
    input: NoPayload,
    handler: () => actions.listAgents()
  }),
  flow({
    name: "agent.new",
    summary: "Open the New agent form (an existing id opens it for editing)",
    runtime: ["local.harnesses"],
    args: "[id] [harness] [model] [purpose]",
    input: Schema.Struct({
      id: Schema.optional(Schema.String),
      harness: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      purpose: Schema.optional(Schema.String)
    }),
    handler: (prefill) => actions.newAgent(prefill)
  }),
  /*
   * THE FORM LAW (apps/ui/AGENTS.md): the generic form card's own acts. A
   * field commits through form.set (one payload update, never component
   * state); form.submit assembles the line and runs the form's flow as the
   * actor that asked for it, so a consequential flow the agent asked for
   * still confirms. Hidden like every id-scoped card act, callable by the
   * agent like every hidden act.
   */
  flow({
    name: "form.set",
    summary: "Set one field of a form card",
    hidden: true,
    args: "<cardId> <field> [value]",
    input: Schema.Struct({ cardId: Schema.String, field: Schema.String, value: Schema.String }),
    handler: ({ cardId, field, value }) => actions.setFormField(cardId, field, value)
  }),
  flow({
    name: "form.submit",
    summary: "Submit a form card: run its flow with the fields filled in",
    hidden: true,
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.submitForm(cardId)
  }),
  flow({
    name: "agent.create",
    form: { fields: { harness: { optionsFrom: "agent-harnesses" }, model: { optionsFrom: "harness-models", kind: "text" } } },
    summary: "Create an agent: an id, the harness that runs it, the model id that harness accepts, and its purpose",
    runtime: ["local.harnesses"],
    confirm: ({ id, harness, model }) => `create the agent ${String(id)} on ${String(harness)} with ${String(model)}`,
    args: "<id> <harness> <model> [purpose]",
    input: Schema.Struct({ id: Schema.String, harness: Schema.String, model: Schema.String, purpose: Schema.optional(Schema.String) }),
    handler: (input) => actions.createAgent(input)
  }),
  flow({
    name: "agent.edit",
    form: {
      fields: { id: { optionsFrom: "agents" }, model: { optionsFrom: "harness-models", kind: "text" } },
      args: (payload) => line(text(payload, "id"), flag(payload, "model"), flag(payload, "purpose"), flag(payload, "label"))
    },
    summary: "Change an agent's model, purpose, or name (a built-in keeps its harness)",
    runtime: ["local.harnesses"],
    confirm: ({ id }) => `edit the agent ${String(id)}`,
    args: "<id> [--model <id>] [--purpose <text>] [--label <name>]",
    input: Schema.Struct({
      id: Schema.String,
      model: Schema.optional(Schema.String),
      purpose: Schema.optional(Schema.String),
      label: Schema.optional(Schema.String)
    }),
    handler: ({ id, ...patch }) => actions.editAgent(id, patch)
  }),
  flow({
    name: "agent.remove",
    form: { fields: { id: { optionsFrom: "agents" } } },
    summary: "Remove a custom agent (a built-in cannot be removed)",
    runtime: ["local.harnesses"],
    confirm: ({ id }) => `remove the agent ${String(id)}`,
    args: "<id>",
    input: Schema.Struct({ id: Schema.String }),
    handler: ({ id }) => actions.removeAgent(id)
  }),
  flow({
    name: "agent.models",
    form: { fields: { harness: { optionsFrom: "agent-harnesses" } } },
    summary: "List the models a harness can run, as the harness reports them",
    runtime: ["local.harnesses"],
    args: "<harness>",
    input: Schema.Struct({ harness: Schema.String }),
    handler: ({ harness }) => actions.listHarnessModels(harness)
  }),
  flow({
    /* Pins a card the agent just rendered into the sidebar: an ordinary act. */
    name: "tab.card",
    summary: "Open a card in the sidebar",
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.openCardTab(cardId)
  }),
  flow({
    name: "tab.select",
    summary: "Select a session",
    hidden: true,
    userOnly: true,
    userOnlyReason: "focus is the human's",
    args: "<tabId | 1-9>",
    input: Schema.Struct({ tab: Schema.String }),
    handler: ({ tab }) => actions.selectTab(tab)
  }),
  flow({
    /* Closing stops a process: the agent asks, the human confirms (and a live process asks once more). */
    name: "tab.close",
    summary: "Close a session",
    confirm: "close the session",
    args: "[tabId]",
    input: Schema.Struct({ tabId: Schema.optional(Schema.String) }),
    handler: ({ tabId }) => actions.closeTab(tabId)
  }),
  flow({
    name: "tab.close.confirm",
    summary: "Close the session and stop its process",
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.confirmTabClose()
  }),
  flow({
    name: "tab.close.cancel",
    summary: "Keep the session open",
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.cancelTabClose()
  }),
  flow({
    name: "tab.menu",
    summary: "Open the new session menu",
    hidden: true,
    userOnly: true,
    userOnlyReason: "opening a menu is the human's gesture",
    args: "[repoKey]",
    input: Schema.Struct({ repo: Schema.optional(Schema.String) }),
    handler: ({ repo }) => actions.toggleTabMenu(repo)
  }),
  /* The sidebar's pinned repositories (docs/LOCAL-APP.md "Tabs"). */
  flow({
    name: "repo.select",
    summary: "Make a pinned repository the active one",
    runtime: ["local.repositories"],
    hidden: true,
    userOnly: true,
    userOnlyReason:
      "which pinned repository is active is the human's selection; an act names its working copy instead (tab.terminal [cwd])",
    args: "<repoKey>",
    input: Schema.Struct({ repo: Schema.String }),
    handler: ({ repo }) => actions.selectRepo(repo)
  }),
  flow({
    /* Forgets a repository: the agent asks, the human confirms. */
    name: "repo.unpin",
    summary: "Unpin a repository from the sidebar",
    runtime: ["local.repositories"],
    confirm: "unpin the repository",
    args: "<repoKey>",
    input: Schema.Struct({ repo: Schema.String }),
    handler: ({ repo }) => actions.unpinRepo(repo)
  }),
  /*
   * The sidebar's file tree (docs/workbench-lanes/sidebar-tree.md): a repo
   * row's caret expands the copy's root, a directory row its own path — the
   * row id grammar, `<copyId>#<path>`. Harmless, so every door has it; the
   * agent reads contents with files.list and files.read, the same route.
   */
  flow({
    name: "repo.tree",
    form: { args: (payload) => text(payload, "path") === undefined ? text(payload, "copy") ?? "" : `${text(payload, "copy")}#${text(payload, "path")}` },
    summary: "Expand or collapse a directory of a working copy in the sidebar",
    runtime: ["local.repositories"],
    args: "<copyId>[#path]",
    input: Schema.Struct({ copy: Schema.String, path: Schema.optional(Schema.String) }),
    handler: ({ copy, path }) => actions.toggleRepoTree(copy, path)
  }),
  /* The workspace heading: its name, and the pencil that edits it inline. */
  flow({
    name: "workspace.rename",
    summary: "Name this workspace",
    args: "<name>",
    input: Schema.Struct({ name: Schema.String }),
    handler: ({ name }) => actions.renameWorkspace(name)
  }),
  flow({
    name: "workspace.rename.edit",
    summary: "Edit the workspace name in the sidebar",
    hidden: true,
    userOnly: true,
    userOnlyReason: "opening the inline editor is the human's gesture; the agent names the workspace with workspace.rename",
    input: NoPayload,
    handler: () => actions.toggleWorkspaceRename()
  }),
  flow({
    /* The composer's `+`: add files, a connector, a flow, an agent. */
    name: "composer.add",
    summary: "Open the composer's add menu",
    hidden: true,
    userOnly: true,
    userOnlyReason: "opening the composer's menu is the human's gesture",
    input: NoPayload,
    handler: () => actions.toggleAddMenu()
  }),
  flow({
    name: "files.add",
    summary: "Add files to the conversation",
    input: NoPayload,
    handler: () => actions.addFiles()
  }),
  flow({
    /*
     * The chrome's "Open repository": the native folder dialog, or a typed
     * path. Granting the agent a directory is consequential, so a path it
     * names confirms; the dialog itself is the human's gesture, so without a
     * path the agent is told to name one (controller/tabs.ts openLocalRepo).
     */
    name: "repo.open",
    summary: "Open a local repository (a path, or the folder dialog)",
    runtime: ["local.repositories"],
    args: "[path]",
    confirm: ({ path }) => typeof path === "string" && path.trim() !== "" ? `open the local repository at ${path}` : undefined,
    input: Schema.Struct({ path: Schema.optional(Schema.String) }),
    handler: ({ path }) => actions.openLocalRepo(path)
  }),
  /* The target-card runs: builds and tests on the human's machine, so the agent asks and the human confirms. */
  flow({
    name: "target.run",
    form: {
      fields: { repoId: { optionsFrom: "open-repos" }, label: { label: "Target label" } },
      args: (payload) => line(text(payload, "repoId"), text(payload, "workspace"), text(payload, "label"))
    },
    summary: "Run a Smithers target",
    runtime: ["local.targets"],
    confirm: "run the Smithers target",
    args: "<repoId> [workspace] <label>",
    input: TargetRef,
    handler: ({ repoId, label, workspace }) => actions.runTarget(repoId, workspace ?? ".", label)
  }),
  flow({
    name: "target.run.pattern",
    form: {
      fields: { repoId: { optionsFrom: "open-repos" } },
      args: (payload) => line(text(payload, "repoId"), text(payload, "workspace"), text(payload, "verb"), text(payload, "pattern"))
    },
    summary: "Run a Smithers verb over a pattern (`ci //packages/...`)",
    runtime: ["local.targets"],
    confirm: "run the Smithers verb over the pattern",
    args: "<repoId> [workspace] <verb> <pattern>",
    input: Schema.Struct({
      repoId: Schema.String,
      verb: Schema.String,
      pattern: Schema.String,
      workspace: Schema.optional(Schema.String)
    }),
    handler: ({ repoId, workspace, verb, pattern }) => actions.runPattern(repoId, workspace ?? ".", verb, pattern)
  }),
  flow({
    /* Showing a target is how the agent answers "show me //src:lint" too. */
    name: "target.open",
    form: {
      fields: { repoId: { optionsFrom: "open-repos" }, label: { label: "Target label" } },
      args: (payload) => line(text(payload, "repoId"), text(payload, "workspace"), text(payload, "label"))
    },
    summary: "Show a Smithers target in its targets card",
    runtime: ["local.targets"],
    args: "<repoId> <label>",
    input: TargetRef,
    handler: ({ repoId, label }) => actions.openTarget(repoId, label)
  }),
  /*
   * The targets table (docs/LOCAL-APP.md "Cards"): its filter chips and text,
   * and the row whose drawer is open. Both are the card's own affordances;
   * the state they change lives in the card payload, never in a component.
   */
  flow({
    name: "target.filter",
    summary: "Filter the targets table",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "the targets table's filter is the human's control; the agent lists targets with target.list",
    args: "<repoId> [mode=<featured|all|recent>] [query=<text>] [kind=<kind>] [state=<never|passed|failed|running>] [workspace=<path>]",
    input: Schema.Struct({
      repoId: Schema.String,
      mode: Schema.optional(Schema.String),
      query: Schema.optional(Schema.String),
      kind: Schema.optional(Schema.String),
      state: Schema.optional(Schema.String),
      workspace: Schema.optional(Schema.String)
    }),
    handler: ({ repoId, mode, query, kind, state, workspace }) =>
      actions.filterTargets(repoId, {
        ...(mode === undefined ? {} : { mode }),
        ...(query === undefined ? {} : { query }),
        ...(kind === undefined ? {} : { kind }),
        ...(state === undefined ? {} : { state }),
        ...(workspace === undefined ? {} : { workspace })
      })
  }),
  flow({
    name: "target.select",
    summary: "Open a target's details in the targets table, or close them",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "the targets table's row drawer is the human's control; the agent shows a target with target.open",
    args: "<repoId> [label]",
    input: Schema.Struct({ repoId: Schema.String, label: Schema.optional(Schema.String) }),
    handler: ({ repoId, label }) => actions.selectTarget(repoId, label)
  }),
  /*
   * The user's stars: the Featured view leads with the manifest's featured
   * labels and these. Persisted by repository path (app-starred-targets), so
   * a star outlives the server's fresh repo id on a reopen.
   */
  flow({
    name: "target.star",
    summary: "Star a target so it leads the targets table's Featured view",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "starring is the human's own ranking of the table",
    args: "<repoId> <label>",
    input: Schema.Struct({ repoId: Schema.String, label: Schema.String }),
    handler: ({ repoId, label }) => actions.starTarget(repoId, label, true)
  }),
  flow({
    name: "target.unstar",
    summary: "Take a star back from a target",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "starring is the human's own ranking of the table",
    args: "<repoId> <label>",
    input: Schema.Struct({ repoId: Schema.String, label: Schema.String }),
    handler: ({ repoId, label }) => actions.starTarget(repoId, label, false)
  }),
  /*
   * Name groups (cards/TargetsTable.ts groupRows): targets sharing a name
   * across packages read as one `//...:name` row. The build CLI has no
   * `:name` wildcard, so "run the set" is one target.run per picked member.
   */
  flow({
    name: "target.expand",
    summary: "Expand or collapse a grouped row in the targets table",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "the targets table's grouped rows are the human's control",
    args: "<repoId> <//...:name>",
    input: Schema.Struct({ repoId: Schema.String, group: Schema.String }),
    handler: ({ repoId, group }) => actions.expandTargetGroup(repoId, group)
  }),
  flow({
    name: "target.pick",
    summary: "Pick which members of a grouped row run (a label toggles; all / none)",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "picking a grouped row's members is the human's control",
    args: "<repoId> <//...:name> <label|all|none>",
    input: Schema.Struct({ repoId: Schema.String, group: Schema.String, member: Schema.String }),
    handler: ({ repoId, group, member }) => actions.pickTargets(repoId, group, member)
  }),
  flow({
    name: "target.run.set",
    summary: "Run every picked member of a grouped row",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "runs the members the human picked in the table; the agent runs a target by label with target.run",
    args: "<repoId> <//...:name>",
    input: Schema.Struct({ repoId: Schema.String, group: Schema.String }),
    handler: ({ repoId, group }) => actions.runTargetSet(repoId, group)
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
    /*
     * The targets table on request: opening a repository renders nothing,
     * so the table is this explicit act (a bare call means the active repo).
     */
    name: "target.list",
    summary: "List the repository's Smithers targets",
    runtime: ["local.targets"],
    args: "[repoId]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String) }),
    handler: ({ repoId }) => actions.listTargets(repoId)
  }),
  flow({
    name: "target.graph",
    summary: "Show the target graph",
    runtime: ["local.targets"],
    args: "[repoId] [label]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String), label: Schema.optional(Schema.String) }),
    handler: ({ repoId, label }) => actions.showGraph(repoId, label)
  }),
  flow({
    /* The graph drawer's focus: pin one label, or clear the focus when none is named. */
    name: "target.graph.focus",
    summary: "Focus the target graph on one label, or clear the focus details",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "the graph drawer's own selection; the agent opens the graph focused with target.graph [label]",
    args: "<repoId> [label]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String), label: Schema.optional(Schema.String) }),
    handler: ({ repoId, label }) => actions.focusGraphNode(repoId, label)
  }),
  flow({
    name: "target.timeline",
    summary: "Show one target run's timeline",
    runtime: ["local.targets"],
    args: "[repoId] <runId>",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String), runId: Schema.optional(Schema.String) }),
    handler: ({ repoId, runId }) => actions.showRunTimeline(repoId, runId)
  }),
  flow({
    name: "target.history",
    summary: "Show the repository's target run history",
    runtime: ["local.targets"],
    args: "[repoId]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String) }),
    handler: ({ repoId }) => actions.showRunHistory(repoId)
  }),
  flow({
    name: "target.runs.select",
    form: { args: (payload) => line(text(payload, "repoId"), text(payload, "runId")) },
    summary: "Replay a recorded run into the timeline and the graph",
    runtime: ["local.targets"],
    hidden: true,
    args: "[repoId] <runId>",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String), runId: Schema.String }),
    handler: ({ repoId, runId }) => actions.selectRunReplay(repoId, runId)
  }),
  flow({
    /* The replay scrubber: the slider's own act (time travel), user-triggered only. */
    name: "target.run.scrub",
    summary: "Replay a recorded run up to a cursor",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "the replay slider is the human's gesture (time travel)",
    args: "<runId> <cursor>",
    input: Schema.Struct({ runId: Schema.String, cursor: Schema.Number }),
    handler: ({ runId, cursor }) => actions.scrubRunReplay(runId, cursor)
  }),
  flow({
    name: "target.affected",
    summary: "Show what the working-tree diff affects",
    runtime: ["local.targets"],
    args: "[repoId]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String) }),
    handler: ({ repoId }) => actions.showAffected(repoId)
  }),
  flow({
    name: "target.ci",
    summary: "Show the CI matrix the target graph implies",
    runtime: ["local.targets"],
    args: "[repoId]",
    input: Schema.Struct({ repoId: Schema.optional(Schema.String) }),
    handler: ({ repoId }) => actions.showCiMatrix(repoId)
  }),
  flow({
    /* The graph drawer's "open" affordance for a declaration site. */
    name: "target.source.open",
    summary: "Open a target's declaration source",
    runtime: ["local.targets"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "opens the declaration in the human's editor — a handoff off the app",
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
}

/*
 * The admin plugin (Launch Checklist §E — non-enumerable): these flows REGISTER
 * ONLY when the validated session carries admin:true. For every other session
 * they are absent from the registry — not hidden, not disabled — so the
 * enumeration surface (slash menu, agent catalog) of a non-admin session
 * contains no trace of them, and a direct /name invocation resolves exactly
 * like any typo.
 */
export const adminFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  const RESET = {
    name: "admin.reset",
    summary: "Start a fresh conversation (dev tooling — nothing is kept)",
    userOnly: true,
    userOnlyReason: "destroys the whole store with no undo; the confirm dialog is the only door",
    input: NoPayload,
    handler: () => actions.reset()
  }
  return [
  flow({
    name: "admin.reset.ask",
    summary: "Ask before discarding the conversation",
    hidden: true,
    userOnly: true,
    userOnlyReason: "opens the human's confirm dialog for the reset",
    input: NoPayload,
    handler: () => actions.askReset()
  }),
  flow({
    name: "admin.reset.cancel",
    summary: "Keep the current conversation",
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.cancelReset()
  }),
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
    runtime: ["billing.checkout"],
    userOnly: true,
    userOnlyReason: "external checkout with real money; the human clicks",
    args: "[plan]",
    requires: ["signed-in"],
    input: Schema.Struct({ plan: Schema.optional(Schema.String) }),
    handler: ({ plan }) => actions.startCheckout(plan)
  }),
  flow({
    name: "billing.portal",
    summary: "Manage billing (opens the Stripe portal)",
    runtime: ["billing.checkout"],
    userOnly: true,
    userOnlyReason: "the external billing portal; the human clicks",
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.openBillingPortal()
  }),
  /*
   * The bare reset is admin-only dev tooling (§2): no sweep, nothing kept.
   * Users get /chat.clear instead.
   */
  flow(RESET),
  flow({
    /* The admin dev-tools panel (§2b/§2d): the machinery, visible. */
    name: "admin.devtools",
    summary: "Toggle the dev-tools panel",
    userOnly: true,
    userOnlyReason: "the admin panel's presentation toggle",
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
    userOnlyReason: "admin diagnostics; the agent must never reason about its engine",
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
    userOnlyReason: "revokes the chain's own session grants; the operator's act",
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
    runtime: ["identity"],
    args: "<login>",
    input: Schema.Struct({ login: Schema.String }),
    handler: ({ login }) => actions.adminAllowlist("add", login)
  }),
  flow({
    name: "admin.allowlist.remove",
    summary: "Remove a GitHub login from the allowlist",
    runtime: ["identity"],
    args: "<login>",
    input: Schema.Struct({ login: Schema.String }),
    handler: ({ login }) => actions.adminAllowlist("remove", login)
  }),
  flow({
    name: "admin.grant",
    summary: "Grant balance to a login (asks for confirmation first)",
    runtime: ["identity"],
    args: "<amountUsd> <login>",
    input: Schema.Struct({ amountUsd: Schema.Number, login: Schema.String }),
    handler: ({ amountUsd, login }) => actions.adminGrant(amountUsd, login)
  }),
  flow({
    name: "admin.grant.confirm",
    summary: "Confirm a pending balance grant",
    runtime: ["identity"],
    hidden: true,
    args: "<cardId>",
    capabilities: ["approve:self"],
    userOnly: true,
    userOnlyReason: "a grant confirmation is the operator's own answer (approve:self)",
    input: CardTarget,
    handler: ({ cardId }) => actions.adminGrantConfirm(cardId)
  }),
  flow({
    name: "admin.grant.cancel",
    summary: "Cancel a pending balance grant",
    runtime: ["identity"],
    hidden: true,
    args: "<cardId>",
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: CardTarget,
    handler: ({ cardId }) => actions.adminGrantCancel(cardId)
  }),
  flow({
    name: "admin.requests",
    summary: "Show the request-access queue",
    runtime: ["identity"],
    input: NoPayload,
    handler: () => actions.adminRequests()
  }),
  flow({
    name: "admin.queue.approve",
    summary: "Approve a request-access queue entry",
    runtime: ["identity"],
    hidden: true,
    args: "<login>",
    capabilities: ["approve:self"],
    userOnly: true,
    userOnlyReason: "approving an access request is the operator's own decision (approve:self)",
    input: Schema.Struct({ login: Schema.String }),
    handler: ({ login }) => actions.adminQueueApprove(login)
  }),
  flow({
    name: "admin.health",
    summary: "What failed overnight? Service health, charges, queue depth",
    runtime: ["identity"],
    input: NoPayload,
    handler: () => actions.adminHealth()
  })
  ]
}
