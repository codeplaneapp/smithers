import { AGENT_RUNTIME_CONTEXT_VERSION } from "smithers-shared/AgentContext"
import type { AgentRuntimeContext } from "smithers-shared/AgentContext"
import type { AgentChatMessage, AgentTurnFrame } from "smithers-shared/NativeAgent"
import { agentVisibleCatalog } from "../../flows/agentTools"
import type { CommandOutcome } from "../../flows/Commands"
import { parseSubmit } from "../../flows/registry"
import { boundTurnRequest } from "../AgentTurnPolicy"
import { CardPatchSchema, CardSchema } from "../AppState"
import type { Card } from "../AppState"
import type { ImpossibleAskClass } from "../Instructions"
import { smithersInstructions } from "../Instructions"
import {
  impossibleAskOf,
  renderedAskTurnText,
  renderedRunTurnText,
  RUN_LAUNCH_COMMANDS,
  runLaunchCommandOf,
  toolResultLaunchedRun
} from "../RunClaims"
import { worldContextDocuments } from "../WorldContext"
import type { ActiveTurn, ControllerContext, PendingToolCall } from "./context"

/**
 * The client-side tool-loop leg cap, mirroring the chat worker's
 * CHAT_MAX_TOOL_LEGS default (8): over it the turn ends honestly instead of
 * looping forever on a model that keeps calling tools.
 */
const MAX_TOOL_LEGS = 8
/**
 * The chain's own doors (DESIGN.md §14): calls that ARE the surface — the
 * author seat and the transcript doors — rather than acts on the app, so
 * they never render an act row of their own.
 */
const CHAIN_SURFACE_CALLS = new Set(["author", "say", "card.show", "card.update"])

export interface TurnControllerDependencies {
  readonly settleTurnBilling: () => void
  readonly surfaceCommandFailure: (name: string, outcome: CommandOutcome) => void
  readonly forwardApprovalDecision: (
    card: Extract<Card, { kind: "approval" }>,
    decision: "approved" | "denied"
  ) => Promise<void>
}

export interface TurnController {
  readonly subscribeToAgent: () => void
  readonly send: (text: string) => void
  readonly reset: () => void
  readonly stop: () => void
  readonly decideApproval: (id: string, decision: "approved" | "denied") => void
  readonly retryLastTurn: () => void
}

export const createTurnController = (
  ctx: ControllerContext,
  dependencies: TurnControllerDependencies
): TurnController => {
  const { store, repositories, agent } = ctx
  const { settleTurnBilling, surfaceCommandFailure, forwardApprovalDecision } = dependencies

  const handleCardFrame = (frame: Extract<AgentTurnFrame, { type: "card" | "card.update" }>): void => {
    if (frame.type === "card") {
      store.dispatch({ type: "card.upsert", actor: "smithers", card: frame.card })
      return
    }
    const patch = CardPatchSchema.safeParse(frame.patch)
    const existing = store.collections.cards.get(frame.id)
    if (!patch.success || existing === undefined) {
      console.warn("Smithers dropped a card.update frame for an unknown or invalid card", frame.id)
      return
    }
    const merged = CardSchema.safeParse({ ...existing, ...patch.data, id: existing.id })
    if (!merged.success) {
      console.warn("Smithers dropped a card.update frame that fails schema", merged.error)
      return
    }
    store.dispatch({ type: "card.updated", actor: "smithers", id: frame.id, patch: patch.data })
  }

  /** The transcript as the chat contract reads it: no tool-act lines, no empty bubbles. */
  const contextMessages = (): ReadonlyArray<AgentChatMessage> =>
    store
      .agentContextSnapshot()
      .messages.filter((message) => message.act === undefined && message.text.trim() !== "")
      .map((message) => ({
        role: message.role === "user" ? ("user" as const) : ("assistant" as const),
        content: message.text
      }))
  ctx.contextMessages = contextMessages

  /*
   * The hidden runtime context, freshly derived from live collections on EVERY
   * turn leg (never cached): the server boundary renders it into the upstream
   * instructions, so the model truthfully knows it runs inside the Smithers
   * product. It is never dispatched, so it never enters the persisted visible
   * transcript; it carries no secrets (only state the client already holds).
   */
  const agentRuntimeContext = (): AgentRuntimeContext => {
    const snapshot = store.agentContextSnapshot()
    const current = store.session()
    const identity = store.collections.identitySessions.get("identity")
    const watched = store.collections.watchedRepos.get("watched")
    const billingAccount = store.collections.billingAccounts.get("billing")
    const selected = current.selectedWorldDocumentId === null
      ? undefined
      : store.collections.worldDocuments.get(current.selectedWorldDocumentId)
    return {
      version: AGENT_RUNTIME_CONTEXT_VERSION,
      product: "smithers",
      capturedAt: snapshot.capturedAt,
      revision: snapshot.revision,
      surface: current.surface,
      theme: current.theme,
      selectedWorldDocument: selected?.path ?? null,
      connectors: snapshot.connectors.map((connector) => ({
        kind: connector.kind,
        name: connector.name,
        status: connector.status,
        access: connector.access,
        root: connector.root,
        branch: connector.branch
      })),
      /*
       * Sign-in IS the GitHub connector (§2a′): connection truth derives
       * from the validated session + the watched-repos selection, never
       * from the legacy local-connector store.
       */
      github: {
        connected: identity?.state === "signed-in",
        login: identity?.state === "signed-in" ? identity.login : null,
        watchedRepos: identity?.state !== "signed-in"
          ? null
          : watched === undefined || watched.selected === null
          ? "unselected"
          : watched.selected.length,
        /*
         * §22.7: a COUNT left the model declining to answer "what repos do
         * you watch?" while the names were served plainly by the seam it
         * was already reading.
         */
        ...(identity?.state === "signed-in" && watched?.selected != null
          ? { watchedRepoNames: [...watched.selected] }
          : {})
      },
      /*
       * §22.7: the client holds the balance; the model did not, so asked
       * for it, it answered "$0.00" one line above a card its own tool call
       * had just rendered reading "$519 left".
       */
      billing: billingAccount === undefined
        ? null
        : {
          state: billingAccount.state,
          totalUsd: billingAccount.totalUsd,
          lifetimeChargedUsd: billingAccount.lifetimeChargedUsd,
          chargeCount: billingAccount.chargeCount
        },
      /*
       * §10.8: metadata alone made the World decorative — a note holding a
       * fact recorded nowhere else was invisible to the model, which said
       * it could not retrieve it. The notes' own words ride the turn under
       * a budget, open note first.
       */
      worldState: {
        documentCount: snapshot.worldState.documents.length,
        documents: worldContextDocuments(
          snapshot.worldState.documents,
          current.selectedWorldDocumentId
        )
      },
      capabilities: [
        "Hold a streaming conversation in this chat and read its visible transcript.",
        "Run app commands through the \"commands\" tool — the same code path as the UI buttons and slash commands.",
        "Render structured cards (plans, approvals, statuses, recommendations) in the transcript.",
        "Create, list, and run Smithers workflows on the user's watched repositories (flow.create, flow.list, flow.run) — runs report live as embedded cards in this chat.",
        ...(repositories.available
          ? ["Connect a local repository the user picks in the native picker."]
          : [])
      ],
      limitations: [
        "Cannot see or control the host environment beyond what this context block states.",
        "Workflow runs execute on the user's workspace gateway; any outbound act a run wants (pushes, PRs) pauses for the human's explicit approval — never promise one landed without it.",
        repositories.available
          ? "Can only touch repositories the user explicitly connected, listed above."
          : "This pure-web client cannot connect local repositories (the native app can); none are connected unless listed above."
      ]
    }
  }

  /*
   * Wave 13 §F: the system prompt's capability section is GENERATED per turn
   * from the live command catalog and connector state — the one source of
   * truth — so the model's offers are bounded by what actually exists, and a
   * workflow is never presented as laundering an effect the catalog lacks.
   */
  const turnInstructions = (): string => {
    const identity = store.collections.identitySessions.get("identity")
    const watched = store.collections.watchedRepos.get("watched")
    const signedIn = identity?.state === "signed-in"
    return smithersInstructions(agentVisibleCatalog(ctx.commands.callable()), {
      github: {
        connected: signedIn,
        login: signedIn ? identity.login : null,
        watchedRepos: !signedIn
          ? null
          : watched === undefined || watched.selected === null
          ? "unselected"
          : watched.selected.length
      },
      localRepositories: [...store.collections.connectors.values()].map((connector) => connector.name),
      localRepositoriesAvailable: repositories.available
    })
  }

  const launchLeg = (
    turnId: string,
    messages: ReadonlyArray<AgentChatMessage>,
    /*
     * §4.13: the trailing messages a bound must not cut — the user's own
     * prompt, and the function_call/function_call_output pair of every tool
     * leg, which mean nothing split apart.
     */
    keepTail = 1
  ): void => {
    /*
     * §4.13: the client re-sent the whole transcript every turn, so a long
     * conversation crossed the boundary's body limit and then stayed dead —
     * every later turn failed the same way, and /clear could not recover it
     * because /clear runs a model turn of its own into the same wall.
     */
    const { request } = boundTurnRequest(
      {
        runId: turnId,
        messages,
        instructions: turnInstructions(),
        tools: ctx.commands.toolSpecs(),
        context: agentRuntimeContext()
      },
      keepTail
    )
    void agent
      .startTurn(request)
      .then((result) => {
        if (result.status !== "error" || ctx.activeTurn?.id !== turnId) return
        const turn = ctx.activeTurn
        ctx.activeTurn = undefined
        // §1: a leg that never started still ends a turn that launched a
        // run, and a claim streamed before the launch is already on screen.
        settleRunClaims(turn)
        store.dispatch({
          type: "message.response.failed",
          actor: "system",
          turnId,
          message: result.message
        })
        settleTurnBilling()
      })
      .catch(() => {
        if (ctx.activeTurn?.id !== turnId) return
        const turn = ctx.activeTurn
        ctx.activeTurn = undefined
        settleRunClaims(turn)
        store.dispatch({
          type: "message.response.failed",
          actor: "system",
          turnId,
          message: "The native Smithers Cloud connection stopped responding."
        })
        settleTurnBilling()
      })
  }

  /*
   * The visible one-line record of a tool act (§2b transcript hygiene): at
   * most a compact Smithers-side line, actor smithers — the raw arguments or
   * result payload (the commands list's JSON, the browser read's text) NEVER
   * enters the conversation. The full-fidelity record lives in the toolCalls
   * collection for the admin dev-tools panel.
   */
  const toolActLine = (call: PendingToolCall, result: string): string => {
    let inner = call.name
    let action: string | undefined
    let args: string | undefined
    try {
      const parsed: unknown = JSON.parse(call.args)
      if (typeof parsed === "object" && parsed !== null) {
        // The model may spell the name "/browser" (the catalog's own
        // dialect, normalized at the agent boundary too) — stripped here
        // so the label renders /browser, never //browser.
        if ("name" in parsed && typeof parsed.name === "string") inner = parsed.name.replace(/^\/+/, "")
        if ("action" in parsed && typeof parsed.action === "string") action = parsed.action
        if ("args" in parsed && typeof parsed.args === "string") args = parsed.args
      }
    } catch {
      // The raw tool name is the honest label when the arguments don't parse.
    }
    if (call.name === "commands" && action === "list") return "Smithers checked what it can do here"
    if (
      call.name === "commands" && inner === "browser" && !result.startsWith("failed:") && !result.startsWith("unknown-")
    ) {
      let host = args ?? ""
      try {
        host = new URL(args ?? "").host
      } catch {
        // Keep the raw args as the host label.
      }
      return `Smithers read ${host}`
    }
    /*
     * Wave 12 §1: the act line for a launch is deterministic too — it names
     * the run the client actually started, from the machine acknowledgment,
     * never from the model's wording.
     */
    const launched = runLaunchCommandOf(call.name, call.args)
    if (launched !== undefined && toolResultLaunchedRun(result)) {
      const workflow = /\bworkflow=(\S+)/.exec(result)?.[1] ?? inner
      const repo = /\brepo=(\S+)/.exec(result)?.[1]
      return `Smithers started a ${workflow} run${repo === undefined ? "" : ` on ${repo}`}`
    }
    const label = call.name === "commands" ? `/${inner}` : call.name
    if (result.startsWith("executed /") || (!result.startsWith("failed:") && !result.startsWith("unknown-"))) {
      return `Smithers ran ${label}`
    }
    // The honest failure, one line, payload-free: an error string that
    // still looks like raw JSON never reaches the transcript.
    const clean = result.trim().startsWith("{") || result.trim().startsWith("[") ? "that didn't work" : result
    return `Smithers tried ${label} — ${clean.replace(/\s+/g, " ").slice(0, 160)}`
  }

  /*
   * One tool-loop leg: execute the model's call through the registry (the
   * same path as buttons and slash, actor smithers), render the act line,
   * then POST the continuation turn with the tool-role result appended.
   */
  const continueToolLeg = async (turn: ActiveTurn): Promise<void> => {
    const call = turn.pendingCall
    if (call === undefined) return
    turn.pendingCall = undefined
    turn.toolLegs += 1
    // executeForAgent runs as actor smithers (withAgentActor) — the same
    // dispatch path as buttons and slash, with the agent attribution.
    const result = await ctx.commands.executeForAgent({ name: call.name, arguments: call.args })
    if (ctx.activeTurn?.id !== turn.id) return
    /*
     * Wave 12 §1: a real launch arms the deterministic claim surface for the
     * rest of this turn. A refusal or a chooser route launched nothing, so
     * there is no run for the model to misdescribe and its prose stands.
     */
    const launched = runLaunchCommandOf(call.name, call.args)
    if (launched !== undefined && toolResultLaunchedRun(result)) turn.runLaunch = launched
    store.dispatch({
      type: "toolcall.recorded",
      actor: "smithers",
      turnId: turn.id,
      name: call.name,
      arguments: call.args,
      result
    })
    store.dispatch({
      type: "message.tool.executed",
      actor: "smithers",
      turnId: turn.id,
      text: toolActLine(call, result)
    })
    turn.toolItems.push(
      { type: "function_call", call_id: call.callId, name: call.name, arguments: call.args },
      { type: "function_call_output", call_id: call.callId, output: result }
    )
    launchLeg(turn.id, [...contextMessages(), ...turn.toolItems], turn.toolItems.length + 1)
  }

  /*
   * Wave 12 §1 — the claim surface settles deterministically.
   *
   * A turn that launched a run renders the model's whole answer only when it
   * claims nothing about run state; otherwise the client's own line stands in
   * its place. The check reads the WHOLE answer (anything streamed before the
   * tool call plus everything withheld after it) because a preamble and a
   * continuation land in one bubble — half-suppressing a claim still ships it.
   */
  const settleRunClaims = (turn: ActiveTurn): void => {
    const command = turn.runLaunch
    const askClass = turn.askClass
    if (command === undefined && askClass === undefined) return
    const buffered = turn.claimBuffer
    turn.claimBuffer = ""
    turn.runLaunch = undefined
    turn.askClass = undefined
    const streamed = store.collections.messages.get(`message-${turn.id}-smithers`)?.text ?? ""
    const whole = `${streamed}${buffered}`
    if (whole.trim() === "") {
      /*
       * Nothing renderable was withheld, so nothing is substituted — but the
       * turn must still settle. `message.response.completed` no-ops when no
       * answer message exists, and the session's phase would have stayed
       * `responding` forever with the composer refusing every submit: held-
       * back whitespace bricked the chat. Report it as what it was, through
       * the empty-response path that already exists for exactly this.
       */
      turn.receivedText = false
      return
    }
    /*
     * Wave 13c: an ask-classed turn that launched nothing still answers
     * honestly — the class's deterministic line when the model offered the
     * impossible act, its own words otherwise (an unoffered answer flushes
     * verbatim through the same substitution that would have replaced it).
     */
    const text = command !== undefined
      ? renderedRunTurnText(command, whole)
      : renderedAskTurnText(askClass as ImpossibleAskClass, whole)
    store.dispatch({
      type: "message.claim.substituted",
      actor: "system",
      turnId: turn.id,
      text
    })
  }

  const subscribeToAgent = (): void => {
    const unsubscribe = agent.subscribe((frame: AgentTurnFrame) => {
      if (frame.runId !== ctx.activeTurn?.id) return
      if (frame.type === "card" || frame.type === "card.update") {
        handleCardFrame(frame)
        return
      }
      if (frame.type === "tool_call") {
        // The model asked for a command; the done frame right after it ends
        // this leg, and the continuation is driven from there.
        ctx.activeTurn.pendingCall = { callId: frame.call_id, name: frame.name, args: frame.arguments }
        return
      }
      if (frame.type === "delta") {
        if (frame.text === "") return
        if (frame.kind === "text") {
          ctx.activeTurn.receivedText = true
          /*
           * Wave 12 §1: after a run launch the model's words are held until
           * the turn settles, so a claim is never rendered even for the beat
           * it would take to stream. Reasoning is unaffected — it is not the
           * answer, and the substitution replaces the answer.
           * Wave 13c: the same hold applies when the user's ask named an
           * impossible class — the offer is reviewed before it renders.
           */
          if (ctx.activeTurn.runLaunch !== undefined || ctx.activeTurn.askClass !== undefined) {
            ctx.activeTurn.claimBuffer += frame.text
            return
          }
        }
        store.dispatch({
          type: "message.response.delta",
          actor: "smithers",
          turnId: frame.runId,
          channel: frame.kind,
          delta: frame.text
        })
        return
      }
      /*
       * Chain frames (DESIGN.md §14). A settled command call renders the same
       * one-line act row the tool loop rendered — the harness's own doors
       * (author, say, cards, sys/*) are not user-facing acts. A gate
       * rejection is visible, payload-free, and in-character (§9: no
       * flow/run jargon) — never an error bubble, because the next link
       * corrects it. The remaining chain frames (link.*, steering.drained,
       * park, call.started) are journal evidence: debug mode renders them;
       * the transcript does not.
       */
      if (frame.type === "link.authored") {
        // A chain turn that ends without prose is still a worked turn: the
        // authored link is the proof, so the empty-response failure branch
        // below never applies to a chain turn.
        ctx.activeTurn.receivedText = true
        return
      }
      if (frame.type === "call.settled") {
        // Wave 12 parity: a settled launch call arms the deterministic claim
        // surface exactly as the tool loop did, so the model's prose about
        // the run substitutes at settle instead of rendering as a claim.
        if (RUN_LAUNCH_COMMANDS.includes(frame.name)) {
          ctx.activeTurn.runLaunch = frame.name
        }
        if (!CHAIN_SURFACE_CALLS.has(frame.name) && !frame.name.startsWith("sys/")) {
          store.dispatch({
            type: "message.tool.executed",
            actor: "smithers",
            turnId: frame.runId,
            text: `Smithers ran /${frame.name}`
          })
        }
        return
      }
      if (frame.type === "park") {
        // Approval parks explain themselves through the approval card; every
        // other park states the pause honestly instead of settling silently.
        if (frame.code !== "approval") {
          store.dispatch({
            type: "message.appended",
            actor: "system",
            text: frame.code === "quota"
              ? "Smithers paused — this turn ran out of budget."
              : "Smithers paused — it is waiting on something outside this chat."
          })
        }
        return
      }
      if (frame.type === "gate.rejected") {
        store.dispatch({
          type: "message.tool.executed",
          actor: "smithers",
          turnId: frame.runId,
          text: "Smithers adjusted its approach"
        })
        return
      }
      if (frame.type === "steering.drained") {
        store.dispatch({
          type: "message.tool.executed",
          actor: "smithers",
          turnId: frame.runId,
          text: "Smithers picked up your note"
        })
        return
      }
      if (frame.type !== "done") return
      const turn = ctx.activeTurn
      // A kill outranks a pending tool call: the terminal frame the Worker
      // injects for a server-side kill can land between the model's
      // `tool_call` frame and the upstream's own `done`. Continuing there
      // would run the tool and re-POST a continuation leg — the killed turn
      // would quietly carry on, which is exactly what B-3 forbids.
      if (
        frame.error === undefined &&
        frame.reason !== "cancelled" &&
        turn.pendingCall !== undefined
      ) {
        if (turn.toolLegs >= MAX_TOOL_LEGS) {
          ctx.activeTurn = undefined
          settleRunClaims(turn)
          store.dispatch({
            type: "message.response.failed",
            actor: "system",
            turnId: turn.id,
            message: `I hit the tool-call limit for this turn (${MAX_TOOL_LEGS}) — stopping here instead of looping.`
          })
          settleTurnBilling()
          return
        }
        void continueToolLeg(turn)
        return
      }
      ctx.activeTurn = undefined
      settleRunClaims(turn)
      if (frame.error !== undefined) {
        store.dispatch({
          type: "message.response.failed",
          actor: "system",
          turnId: turn.id,
          message: frame.error
        })
      } else if (frame.reason === "cancelled") {
        // A server-side kill ended the stream with the honest terminal frame —
        // render it interrupted (partial text kept), never a silent stop.
        store.dispatch({
          type: "message.response.cancelled",
          actor: "system",
          turnId: turn.id,
          detail: "That turn was stopped by the server."
        })
      } else if (frame.reason === "tool_limit") {
        // The server-side cap answered honestly; surface it the same way.
        store.dispatch({
          type: "message.response.failed",
          actor: "system",
          turnId: turn.id,
          message: "Smithers Cloud stopped this turn at its tool-call limit."
        })
      } else if (!turn.receivedText) {
        store.dispatch({
          type: "message.response.failed",
          actor: "system",
          turnId: turn.id,
          message: "Smithers Cloud returned an empty response."
        })
      } else {
        store.dispatch({
          type: "message.response.completed",
          actor: "smithers",
          turnId: turn.id
        })
      }
      settleTurnBilling()
    })
    // The subscription is scoped to the controller: disposing the controller
    // unsubscribes instead of leaking the listener for the page lifetime.
    if (typeof unsubscribe === "function") ctx.onDispose(unsubscribe)
  }

  const send = (text: string): void => {
    const parsed = parseSubmit(text, ctx.commands.all())
    if (parsed.kind === "empty") return
    if (parsed.kind === "unknown-command") {
      /*
       * §23.5: a name the app does not have used to go to the model as
       * prose, and the model reached for whatever flow it COULD see — so
       * `/reset` on a non-admin session ran `retry`. The app answers for
       * its own registry.
       */
      store.dispatch({ type: "composer.changed", actor: "user", draft: "" })
      surfaceCommandFailure(parsed.name, {
        status: "failed",
        error: `There is no /${parsed.name} flow. Type / to see everything Smithers can do.`
      })
      return
    }
    if (parsed.kind === "command") {
      /*
       * A bare /name is a command invocation, never a prompt for the agent.
       * The outcome is surfaced exactly as the pointer path surfaces it:
       * a flow the human typed and that refused must SAY so — dropping the
       * outcome here is what made `/name <args>` silent while bare `/name`
       * (which the slash menu routes through the pointer path) was honest.
       */
      store.dispatch({ type: "composer.changed", actor: "user", draft: "" })
      void ctx.commands
        .run(parsed.name, parsed.args)
        .then((outcome) => surfaceCommandFailure(parsed.name, outcome))
      return
    }
    const prompt = parsed.text
    if (store.session().phase !== "idle") {
      /*
       * Mid-turn input steers a steerable turn (DESIGN.md §14): the words
       * render as the user's own bubble now, and the running chain drains
       * them at its next link boundary. A backend without steering (the
       * proxy) keeps today's behavior — the input is not eaten, it stays
       * in the composer.
       */
      const turn = ctx.activeTurn
      if (turn !== undefined && agent.steer !== undefined) {
        // Wave 13c holds apply to steered asks too: an impossible ask
        // admitted mid-turn arms the same review the opening prompt gets.
        const steeredAsk = impossibleAskOf(prompt)
        if (steeredAsk !== undefined && turn.askClass === undefined) {
          turn.askClass = steeredAsk
        }
        void agent
          .steer(turn.id, prompt)
          .then((admitted) => {
            if (admitted) {
              store.dispatch({ type: "message.steered", actor: "user", turnId: turn.id, text: prompt })
            }
          })
          .catch(() => {
            // The draft remains untouched, so a rejected steer is retryable.
          })
      }
      return
    }
    /*
     * No auth gate: the local app chats anonymously through the local
     * origin (LOCAL-APP.md). Sign-in stays a command, never a precondition.
     */
    const turnId = crypto.randomUUID()
    ctx.activeTurn = {
      id: turnId,
      receivedText: false,
      toolLegs: 0,
      toolItems: [],
      pendingCall: undefined,
      runLaunch: undefined,
      // Wave 13c: the ASK arms the hold, detected from the user's words
      // before the model speaks — ordinary conversation arms nothing.
      askClass: impossibleAskOf(prompt),
      claimBuffer: ""
    }
    store.dispatch({ type: "message.submitted", actor: ctx.commandActor, turnId, text: prompt })
    launchLeg(turnId, contextMessages())
  }

  const reset = (): void => {
    if (ctx.activeTurn !== undefined) void agent.cancelTurn(ctx.activeTurn.id)
    ctx.activeTurn = undefined
    ctx.stopWorkflowPumps()
    store.dispatch({ type: "conversation.reset", actor: "user" })
  }

  const stop = (): void => {
    if (ctx.activeTurn === undefined) return
    const turn = ctx.activeTurn
    const turnId = turn.id
    void agent.cancelTurn(turnId)
    ctx.activeTurn = undefined
    /*
     * §1: stopping does not un-launch the run, so the claim surface still
     * belongs to the client. Anything the model streamed before the tool call
     * is already rendered — settling here replaces it with the deterministic
     * line instead of leaving a half-turn's claim standing.
     */
    settleRunClaims(turn)
    store.dispatch({
      type: "message.response.cancelled",
      actor: "user",
      turnId,
      detail: "Stopped the current response."
    })
  }

  const decideApproval = (id: string, decision: "approved" | "denied"): void => {
    const card = store.collections.cards.get(id)
    if (card === undefined || card.kind !== "approval" || card.status === "acted") return
    if (card.payload.pending === true) return
    /*
     * A chain approval park (DESIGN.md §14): the decision resolves against
     * the runtime's pending ask, the card freezes, and the SAME lineage
     * resumes — approved converges under the grant, denied surfaces as an
     * observation the model routes around. Both decisions resume.
     */
    if (card.payload.chain === true && card.payload.runId !== undefined) {
      const lineage = card.payload.runId
      if (agent.resolveApproval === undefined) {
        store.dispatch({
          type: "card.approval.decision.failed",
          actor: "system",
          id,
          message: "This backend cannot resolve approvals."
        })
        return
      }
      /*
       * A turn-lineage decision needs the turn seat free before anything
       * is consumed: resolving first would burn the one-shot record and
       * freeze the card while resumeChainTurn no-ops, stranding the park.
       */
      if (
        card.payload.background !== true &&
        (store.session().phase !== "idle" || ctx.activeTurn !== undefined)
      ) {
        store.dispatch({
          type: "card.approval.decision.failed",
          actor: "system",
          id,
          message: "Finish or stop the current turn first, then decide this approval."
        })
        return
      }
      // The persisted card reconstructs the ask after a reload.
      const ask = card.payload.flow === undefined
        ? undefined
        : { name: card.payload.flow, claim: card.payload.capability }
      store.dispatch({ type: "card.approval.decision.pending", actor: "user", id })
      void agent.resolveApproval(lineage, decision, ask).then((resolved) => {
        if (!resolved) {
          store.dispatch({
            type: "card.approval.decision.failed",
            actor: "system",
            id,
            message: "That approval is no longer pending."
          })
          return
        }
        store.dispatch({
          type: "card.approval.decided",
          actor: "user",
          id,
          decision,
          decidedAt: Date.now()
        })
        // A background lineage resumed inside the runtime; only a turn
        // lineage re-enters the turn lifecycle here.
        if (card.payload.background !== true) resumeChainTurn(lineage)
      }).catch(() => {
        store.dispatch({
          type: "card.approval.decision.failed",
          actor: "system",
          id,
          message: "The decision could not reach the chain. Nothing was recorded — try again."
        })
      })
      return
    }
    const { runId, nodeId, iteration } = card.payload
    if (runId === undefined || nodeId === undefined || iteration === undefined) {
      // A card without a run identity has no backend to decide against —
      // say so honestly instead of fake-freezing it.
      store.dispatch({
        type: "card.approval.decision.failed",
        actor: "system",
        id,
        message: "This approval is not linked to a run, so there is nothing to send the decision to."
      })
      return
    }
    store.dispatch({ type: "card.approval.decision.pending", actor: "user", id })
    void forwardApprovalDecision(card, decision)
  }

  /*
   * Resume a parked chain lineage (DESIGN.md §14): same turn id, fresh
   * startTurn — the chain replays its settled prefix and re-asks the seam
   * under the recorded decision. The turn re-enters the ordinary frame
   * lifecycle, so rendering and settlement need no special path.
   */
  const resumeChainTurn = (lineage: string): void => {
    if (store.session().phase !== "idle" || ctx.activeTurn !== undefined) return
    ctx.activeTurn = {
      id: lineage,
      receivedText: true,
      toolLegs: 0,
      toolItems: [],
      pendingCall: undefined,
      runLaunch: undefined,
      askClass: undefined,
      claimBuffer: ""
    }
    store.dispatch({ type: "chain.turn.resumed", actor: "system", turnId: lineage })
    void agent
      .startTurn({ runId: lineage, messages: contextMessages(), instructions: "" })
      .then((result) => {
        if (result.status === "error") {
          const turn = ctx.activeTurn
          ctx.activeTurn = undefined
          store.dispatch({
            type: "message.response.failed",
            actor: "system",
            turnId: turn?.id ?? lineage,
            message: result.message
          })
        }
      })
      .catch(() => {
        if (ctx.activeTurn?.id !== lineage) return
        ctx.activeTurn = undefined
        store.dispatch({
          type: "message.response.failed",
          actor: "system",
          turnId: lineage,
          message: "The chain could not resume. Try the approval again."
        })
      })
  }

  /*
   * /retry re-RUNS the last turn — it does not re-SEND the prompt.
   *
   * `send` appends a user message, so retrying through it grew the transcript
   * a duplicate user/assistant pair per attempt and made every retry ship a
   * longer history than the one before it. The turn keeps its id: the answer
   * it produced is dropped and the same leg launches again over the context
   * that produced it.
   */
  const retryLastTurn = (): void => {
    if (store.session().phase !== "idle" || ctx.activeTurn !== undefined) return
    const last = [...store.collections.messages.values()]
      .filter((message) => message.role === "user")
      .sort((left, right) => right.ordinal - left.ordinal)[0]
    const turnId = last?.id.match(/^message-(.+)-user$/)?.[1]
    if (turnId === undefined) return
    store.dispatch({ type: "message.retried", actor: "user", turnId })
    if (store.session().phase !== "responding") return
    ctx.activeTurn = {
      id: turnId,
      receivedText: false,
      toolLegs: 0,
      toolItems: [],
      pendingCall: undefined,
      runLaunch: undefined,
      askClass: impossibleAskOf(last?.text ?? ""),
      claimBuffer: ""
    }
    launchLeg(turnId, contextMessages())
  }

  return { subscribeToAgent, send, reset, stop, decideApproval, retryLastTurn }
}
