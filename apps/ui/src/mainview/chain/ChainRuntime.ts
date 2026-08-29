import { Catalog, Chain, Journal, Prompt, QuickJsRunner, Steering, SubChains } from "@smthrs/chain"
import type { Author, Event, Outcome, ScriptRunner } from "@smthrs/chain"
import { Effect, Fiber, Layer, Ref } from "effect"
import { CardPatchSchema, CardSchema } from "smithers-shared/Cards"
import type { AgentChatMessage, AgentTurnFrame, FetchLike, StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import type { CommandRegistry } from "../flows/Commands"
import type { NativeAgent } from "../native/NativeBridge"
import type { AppStore } from "../state/AppStore"
import { makeCollectionJournal } from "./CollectionJournal"
import { commandEntries, disclosedEntries } from "./FlowCatalog"
import { createChainPolicy } from "./Policy"
import { layerAuthor } from "./StreamModel"
import { worldviewEntries } from "./Worldview"

/*
 * The Agent Chain behind the NativeAgent seam (DESIGN.md §14). One turn is
 * one lineage: startTurn trampolines Chain.run over the chainEvents journal,
 * the journal tee folds every appended event into chain frames, and the
 * surface entries (say, card.show, card.update) are the model's doors to the
 * transcript — the same frame path the proxy backend uses, so the controller
 * and renderers do not know which backend produced a frame. The controller's
 * per-turn instructions/tools are ignored here: the prefix is
 * Prompt.assemble over the disclosed catalog, and context is the request's
 * transcript rendered compactly — authored context assembly grows from that
 * floor as the worldview entries land.
 */

type Emit = (frame: AgentTurnFrame) => void

export interface ChainRuntimeOptions {
  readonly store: AppStore
  readonly commands: CommandRegistry
  readonly baseUrl?: string
  readonly fetchImpl?: FetchLike
  readonly modelId?: string
  readonly maxLinks?: number
  readonly maxCallsPerLink?: number
  /** Additional host catalog entries beyond the command projection and doors. */
  readonly entries?: ReadonlyArray<Catalog.Entry>
  /** Test seams: replace the author seat and the sealed runner. */
  readonly authorLayer?: Layer.Layer<Author.Author>
  readonly runnerLayer?: Layer.Layer<ScriptRunner.ScriptRunner, unknown>
}

const CONTEXT_MESSAGE_LIMIT = 30

const contextLines = (messages: ReadonlyArray<AgentChatMessage>): ReadonlyArray<string> =>
  messages
    .filter(
      (message): message is { readonly role: "user" | "assistant"; readonly content: string } =>
        "role" in message && typeof message.content === "string" && message.content !== ""
    )
    .slice(-CONTEXT_MESSAGE_LIMIT)
    .map((message) => `${message.role === "user" ? "user" : "smithers"}: ${message.content}`)

const goalOf = (messages: ReadonlyArray<AgentChatMessage>): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && "role" in message && message.role === "user" && message.content !== "") {
      return message.content
    }
  }
  return "Continue."
}

/** The model's doors to the transcript, bound to this turn's frame stream. */
const surfaceEntries = (emit: Emit, runId: string): ReadonlyArray<Catalog.Entry> => [
  {
    name: "say",
    description: "Show the user a chat message (markdown). Payload: { text: string }",
    handler: (payload) => {
      const text = typeof payload === "object" && payload !== null && "text" in payload
        ? (payload as { readonly text?: unknown }).text
        : undefined
      if (typeof text !== "string" || text === "") {
        return Effect.fail(new Catalog.CallError({ name: "say", message: "payload.text must be a non-empty string" }))
      }
      return Effect.sync(() => {
        emit({ runId, type: "delta", kind: "text", text })
        return { shown: true }
      })
    }
  },
  {
    name: "card.show",
    description: "Embed a typed card in the transcript. Payload: { card: Card }",
    handler: (payload) => {
      const card = typeof payload === "object" && payload !== null && "card" in payload
        ? (payload as { readonly card?: unknown }).card
        : undefined
      const parsed = CardSchema.safeParse(card)
      if (!parsed.success) {
        return Effect.fail(
          new Catalog.CallError({
            name: "card.show",
            message: `payload.card is not a valid card: ${parsed.error.message}`
          })
        )
      }
      return Effect.sync(() => {
        emit({ runId, type: "card", card: parsed.data })
        return { shown: parsed.data.id }
      })
    }
  },
  {
    name: "card.update",
    description: "Patch an embedded card. Payload: { id: string, patch: CardPatch }",
    handler: (payload) => {
      const record = typeof payload === "object" && payload !== null
        ? (payload as { readonly id?: unknown; readonly patch?: unknown })
        : {}
      const patch = CardPatchSchema.safeParse(record.patch)
      if (typeof record.id !== "string" || record.id === "" || !patch.success) {
        return Effect.fail(
          new Catalog.CallError({ name: "card.update", message: "payload must be { id: string, patch: CardPatch }" })
        )
      }
      return Effect.sync(() => {
        emit({ runId, type: "card.update", id: record.id as string, patch: patch.data })
        return { updated: record.id }
      })
    }
  }
]

/** Folds one appended journal event into the wire frames live rendering needs. */
const framesOf = (event: Event.Event, runId: string): ReadonlyArray<AgentTurnFrame> => {
  // Sub-chain events stay journal-only for now: the wire's link numbering is
  // the root chain's, and child rendering is the sub-chains PR's concern.
  if (event.chain !== undefined) return []
  switch (event._tag) {
    case "ChainStarted":
      return []
    case "LinkAuthored":
      return [
        { runId, type: "link.authored", link: event.link, scriptDigest: event.script.digest, script: event.script.text }
      ]
    case "CallSettled":
      return [
        { runId, type: "call.settled", link: event.link, ordinal: event.key.ordinal, name: event.name, verdict: "run" }
      ]
    case "GateRejected":
      return [
        {
          runId,
          type: "gate.rejected",
          link: event.link,
          kind: event.observation.kind,
          message: event.observation.message
        }
      ]
    case "SteeringDrained":
      return [{ runId, type: "steering.drained", link: event.link, count: event.messages.length }]
    case "LinkEnded": {
      const outcome = event.outcome._tag === "Done" ? "done" : event.outcome._tag === "To" ? "to" : "park"
      const ended: AgentTurnFrame = { runId, type: "link.ended", link: event.link, outcome }
      return event.outcome._tag === "Park"
        ? [ended, { runId, type: "park", code: event.outcome.reason.code }]
        : [ended]
    }
  }
}

const teeJournal = (
  inner: Journal.Service,
  emit: Emit,
  runId: string,
  onAppended?: (event: Event.Event) => void
): Journal.Service =>
  Journal.make({
    read: inner.read,
    append: (event, expectedPosition) =>
      inner.append(event, expectedPosition).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            for (const frame of framesOf(event, runId)) emit(frame)
            onAppended?.(event)
          })
        )
      )
  })

export const createChainRuntime = (options: ChainRuntimeOptions): NativeAgent => {
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const running = new Map<string, Fiber.Fiber<Outcome.Terminal, unknown>>()
  const steerable = new Map<string, Steering.Service>()
  const cancelled = new Set<string>()
  /* Session-scoped: grants and one-shot denials survive across turns, not reloads. */
  const policy = createChainPolicy()
  /*
   * The background monitor (DESIGN.md §14): a spawned lineage's terminal is
   * delivered wherever the concierge will actually see it — steered into a
   * live turn, or queued for the next turn's context — and always rendered
   * as an honest system message. Goals are kept so an approval-parked
   * background lineage can resume through the same runner.
   */
  const backgroundGoals = new Map<string, { readonly goal: string; readonly context: ReadonlyArray<string> }>()
  const pendingNotes: Array<string> = []

  const emit: Emit = (frame) => {
    for (const listener of listeners) listener(frame)
  }

  const authorLayerOf = () =>
    options.authorLayer ??
      layerAuthor({ baseUrl: options.baseUrl, fetchImpl: options.fetchImpl, modelId: options.modelId })
  /*
   * Model-authored JavaScript runs on the browser main thread. Keep both
   * axes bounded at this production call site: a non-terminating script must
   * be interrupted, and an allocating script must not exhaust the page.
   */
  const runnerLayerOf = () =>
    options.runnerLayer ?? QuickJsRunner.layer({ steps: 100_000, memoryBytes: 16 * 1024 * 1024 })

  const worldview = worldviewEntries(options.store)

  const subPrefix = (): string =>
    Prompt.assemble({
      role: "sub",
      entries: [
        ...Catalog.system,
        ...disclosedEntries(options.commands),
        ...worldview,
        ...(options.entries ?? [])
      ]
    })

  /*
   * Background notes bypass the frame path on purpose: the controller drops
   * frames whose runId is not the active turn, and a background lineage
   * never is. The note renders as a system message now, steers a live turn
   * if one runs, and otherwise waits in pendingNotes for the next turn's
   * harness-built context.
   */
  const deliverNote = (note: string): void => {
    options.store.dispatch({ type: "message.appended", actor: "system", text: note })
    const live = [...steerable.values()][0]
    if (live !== undefined) {
      void Effect.runPromise(live.admit(note) as Effect.Effect<void, never, never>)
    } else {
      pendingNotes.push(note)
    }
  }

  const compactResult = (value: unknown): string => {
    try {
      const rendered = JSON.stringify(value)
      return rendered === undefined ? "" : rendered.length > 200 ? `${rendered.slice(0, 200)}…` : rendered
    } catch {
      return ""
    }
  }

  const runBackground = (lineage: string): void => {
    const spec = backgroundGoals.get(lineage)
    if (spec === undefined) return
    const journalLayer = Layer.succeed(Journal.Journal)(
      makeCollectionJournal({ store: options.store, lineageId: lineage })
    )
    const base = Layer.mergeAll(journalLayer, policy.layerFor(lineage), authorLayerOf(), runnerLayerOf())
    // No surfaces and no background entry: a background tree cannot speak
    // into a turn it does not own, and does not fork further backgrounds.
    const catalog = SubChains.layer({
      entries: [...commandEntries(options.commands), ...worldview, ...(options.entries ?? [])],
      prefix: subPrefix(),
      maxLinks: options.maxLinks,
      maxCallsPerLink: options.maxCallsPerLink
    }).pipe(Layer.provide(base))
    const program = Chain.run({
      goal: spec.goal,
      context: spec.context,
      prefix: subPrefix(),
      maxLinks: options.maxLinks,
      maxCallsPerLink: options.maxCallsPerLink
    }).pipe(Effect.provide(Layer.mergeAll(base, catalog))) as Effect.Effect<Outcome.Terminal, unknown, never>
    void Effect.runPromise(
      Effect.exit(program) as Effect.Effect<
        { readonly _tag: string; readonly value?: Outcome.Terminal; readonly cause?: unknown },
        never,
        never
      >
    ).then((exit) => {
      if (exit._tag !== "Success") {
        deliverNote(`A background task failed: ${spec.goal}`)
        backgroundGoals.delete(lineage)
        return
      }
      const outcome = exit.value as Outcome.Terminal
      if (outcome._tag === "Done") {
        const detail = compactResult(outcome.value)
        deliverNote(
          `A background task finished: ${spec.goal}${detail === "" ? "" : ` — ${detail}`}`
        )
        backgroundGoals.delete(lineage)
        return
      }
      if (outcome._tag === "Park" && outcome.reason.code === "approval") {
        const ask = policy.pendingAsk(lineage)
        options.store.dispatch({
          type: "card.upsert",
          actor: "smithers",
          card: {
            id: `chain-approval-${lineage}`,
            kind: "approval",
            title: "Approval needed",
            status: "active",
            createdAt: Date.now(),
            ordinal: 0,
            payload: {
              capability: ask?.claim ?? "approval",
              detail: ask === undefined ? outcome.reason.message : `A background task wants to run /${ask.name}`,
              runId: lineage,
              chain: true,
              background: true,
              ...(ask === undefined ? {} : { command: ask.name })
            }
          }
        })
        deliverNote(`A background task is waiting on your approval: ${spec.goal}`)
        return
      }
      /*
       * A non-approval park has no wake-up: only approval parks resume
       * (resolveApproval re-runs the lineage). Keeping the entry would
       * park one of the MAX_BACKGROUNDS slots on a task that can never
       * move again, so the dormant lineage leaves the registry here.
       */
      backgroundGoals.delete(lineage)
      deliverNote(`A background task paused (${outcome.reason.code}): ${spec.goal}`)
    })
  }

  /*
   * The spawn tier is deliberately free: SubChains bounds depth (4) and the
   * per-chain budgets bound each lineage, so the remaining unbounded axis is
   * concurrent background count — capped here.
   */
  const MAX_BACKGROUNDS = 3

  /** The concierge's door to unattended work: spawn now, hear back later. */
  const backgroundEntry: Catalog.Entry = {
    name: "background",
    description:
      "Start a background sub-agent that works while you answer. Payload: { goal: string, context?: string[] }. Returns { lineage } immediately; its result arrives later as a note.",
    capabilities: [SubChains.agentCapability],
    handler: (payload) => {
      const record = typeof payload === "object" && payload !== null
        ? (payload as { readonly goal?: unknown; readonly context?: unknown })
        : {}
      if (typeof record.goal !== "string" || record.goal === "") {
        return Effect.fail(
          new Catalog.CallError({ name: "background", message: `"background" takes { goal, context? }` })
        )
      }
      if (backgroundGoals.size >= MAX_BACKGROUNDS) {
        return Effect.fail(
          new Catalog.CallError({
            name: "background",
            message: `${MAX_BACKGROUNDS} background tasks are already running — wait for one to finish`
          })
        )
      }
      const context = Array.isArray(record.context) ? record.context.map((line) => String(line)) : []
      return Effect.sync(() => {
        // Nondeterminism is fine here: the settled result journals the
        // lineage id, so replay returns it without spawning again.
        const lineage = `bg-${crypto.randomUUID()}`
        backgroundGoals.set(lineage, { goal: record.goal as string, context })
        /*
         * The child may start only after the parent's CallSettled append is
         * durable. A crash before that append therefore leaves no child
         * history, while boot reconciliation below can launch a committed
         * intent that crashed before this continuation ran.
         */
        return { lineage }
      })
    }
  }

  /*
   * Boot reconciliation: a reload must not orphan background work. The
   * journal is the record — any bg lineage without a root Done terminal
   * re-registers; ones waiting on a persisted approval card wait for the
   * decision, the rest resume from their settled prefix.
   */
  const resumeBackgrounds = (): void => {
    const byLineage = new Map<string, { goal: string; done: boolean }>()
    for (const record of options.store.collections.chainEvents.values()) {
      const event = record.event as {
        readonly _tag: string
        readonly chain?: string
        readonly goal?: string
        readonly name?: string
        readonly payload?: { readonly goal?: unknown }
        readonly result?: { readonly lineage?: unknown }
        readonly outcome?: { readonly _tag?: string }
      }
      if (
        event._tag === "CallSettled" &&
        event.name === "background" &&
        typeof event.result?.lineage === "string" &&
        event.result.lineage.startsWith("bg-")
      ) {
        const goal = typeof event.payload?.goal === "string" ? event.payload.goal : ""
        byLineage.set(event.result.lineage, { goal, done: false })
      }
      if (!record.lineageId.startsWith("bg-")) continue
      const entry = byLineage.get(record.lineageId) ?? { goal: "", done: false }
      if (event._tag === "ChainStarted" && event.chain === undefined) {
        entry.goal = event.goal ?? ""
      }
      if (event._tag === "LinkEnded" && event.chain === undefined && event.outcome?._tag === "Done") {
        entry.done = true
      }
      byLineage.set(record.lineageId, entry)
    }
    for (const [lineage, entry] of byLineage) {
      if (entry.done || backgroundGoals.has(lineage)) continue
      backgroundGoals.set(lineage, { goal: entry.goal, context: [] })
      const card = options.store.collections.cards.get(`chain-approval-${lineage}`)
      const awaitingDecision = card?.kind === "approval" && card.status !== "acted"
      if (!awaitingDecision) queueMicrotask(() => runBackground(lineage))
    }
  }
  resumeBackgrounds()

  const startTurn = async (request: StartAgentTurnRequest) => {
    if (running.has(request.runId)) {
      return { status: "error", message: "That Smithers turn is already running." } as const
    }
    cancelled.delete(request.runId)

    const commandCatalog = commandEntries(options.commands)
    const surfaces = surfaceEntries(emit, request.runId)
    const host = options.entries ?? []
    const treeEntries = [...commandCatalog, ...surfaces, ...worldview, ...host, backgroundEntry]
    const agentDisclosure: Catalog.Entry = {
      name: SubChains.agentName,
      description: SubChains.agentDescription,
      handler: () => Effect.succeed(undefined)
    }
    const prefix = Prompt.assemble({
      role: "concierge",
      entries: [
        ...Catalog.system,
        ...disclosedEntries(options.commands),
        ...surfaces,
        ...worldview,
        ...host,
        backgroundEntry,
        agentDisclosure
      ]
    })

    const journalLayer = Layer.succeed(Journal.Journal)(
      teeJournal(
        makeCollectionJournal({ store: options.store, lineageId: request.runId }),
        emit,
        request.runId,
        (event) => {
          if (
            event._tag === "CallSettled" &&
            event.name === "background" &&
            typeof (event.result as { readonly lineage?: unknown }).lineage === "string"
          ) {
            runBackground((event.result as { readonly lineage: string }).lineage)
          }
        }
      )
    )
    /*
     * The turn's steering queue lives OUTSIDE the layer stack so steer()
     * can admit while the chain runs; the chain drains it at live author
     * boundaries and journals the drain (SteeringDrained → the frame).
     * In-memory stand-in, same loss window as the chain's own layerMemory.
     */
    const queue = Effect.runSync(Ref.make<ReadonlyArray<string>>([]))
    const steering = Steering.make({
      admit: (message) => Ref.update(queue, (pending) => [...pending, message]),
      drain: () => Ref.getAndSet(queue, [])
    })
    steerable.set(request.runId, steering)
    const base = Layer.mergeAll(
      journalLayer,
      Layer.succeed(Steering.Steering)(steering),
      policy.layerFor(request.runId),
      authorLayerOf(),
      runnerLayerOf()
    )
    /*
     * SubChains owns the tree's catalog: the given entries plus the
     * recursive agent entry and the system entries, with reserved names
     * enforced at construction. Inline children share this catalog — a
     * child may say into the turn it runs under; backgrounds do not.
     */
    const layers = Layer.mergeAll(
      base,
      SubChains.layer({
        entries: treeEntries,
        prefix: subPrefix(),
        maxLinks: options.maxLinks,
        maxCallsPerLink: options.maxCallsPerLink
      }).pipe(Layer.provide(base))
    )

    const program = Chain.run({
      goal: goalOf(request.messages),
      prefix,
      context: [
        ...contextLines(request.messages),
        ...pendingNotes.splice(0).map((note) => `[background] ${note}`)
      ],
      maxLinks: options.maxLinks,
      maxCallsPerLink: options.maxCallsPerLink
    }).pipe(Effect.provide(layers)) as Effect.Effect<Outcome.Terminal, unknown, never>

    const fiber = Effect.runFork(program)
    running.set(request.runId, fiber)
    void Effect.runPromise(Fiber.await(fiber) as Effect.Effect<unknown, never, never>).then((exit) => {
      running.delete(request.runId)
      steerable.delete(request.runId)
      const settled = exit as { readonly _tag: string; readonly value?: unknown; readonly cause?: unknown }
      if (cancelled.delete(request.runId)) {
        emit({ runId: request.runId, type: "done", reason: "cancelled" })
        return
      }
      if (settled._tag === "Success") {
        const outcome = settled.value as Outcome.Terminal
        if (outcome._tag === "Park" && outcome.reason.code === "approval") {
          /*
           * An approval park ends the turn awaiting the human: the card
           * rides the ordinary card frame path, the park frame names the
           * suspension, and resolveApproval + a fresh startTurn on the
           * same lineage resumes from the settled prefix and re-asks.
           */
          const ask = policy.pendingAsk(request.runId)
          emit({
            runId: request.runId,
            type: "card",
            card: {
              id: `chain-approval-${request.runId}`,
              kind: "approval",
              title: "Approval needed",
              status: "active",
              createdAt: Date.now(),
              ordinal: 0,
              payload: {
                capability: ask?.claim ?? "approval",
                detail: ask === undefined
                  ? outcome.reason.message
                  : `Smithers wants to run /${ask.name}`,
                runId: request.runId,
                chain: true,
                ...(ask === undefined ? {} : { command: ask.name })
              }
            }
          })
          emit({ runId: request.runId, type: "park", code: "approval" })
        }
        emit({ runId: request.runId, type: "done", reason: "stop" })
        return
      }
      emit({
        runId: request.runId,
        type: "done",
        error: `The chain failed: ${String(settled.cause ?? "unknown cause")}`
      })
    })
    return { status: "started" } as const
  }

  return {
    available: true,
    startTurn,
    cancelTurn: async (runId) => {
      const fiber = running.get(runId)
      if (fiber === undefined) return
      cancelled.add(runId)
      await Effect.runPromise(Fiber.interrupt(fiber) as Effect.Effect<unknown, never, never>)
    },
    steer: async (runId, text) => {
      const steering = steerable.get(runId)
      if (steering === undefined) return false
      await Effect.runPromise(steering.admit(text) as Effect.Effect<void, never, never>)
      return true
    },
    resolveApproval: async (runId, decision, ask) => {
      const resolved = policy.resolve(runId, decision, ask)
      // A background lineage resumes through its own runner — no turn
      // lifecycle to re-enter; the controller only freezes the card.
      if (resolved && backgroundGoals.has(runId)) {
        queueMicrotask(() => runBackground(runId))
      }
      return resolved
    },
    revokeGrants: async () => policy.revoke(),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

/*
 * The agent seat: one NativeAgent the controller holds, delegating every turn
 * to the browser chain.
 *
 * The indirection is a binding order, not a choice of backend — the chain's
 * catalog IS the controller's command registry, so the chain cannot be built
 * until the controller exists, and the controller needs an agent to be built
 * at all. The native shell's own agent stays the fallback: it is a different
 * HOST for the same loop, not a second backend. On the web there is no
 * fallback, and a turn before the chain binds says so rather than pretending.
 */
export const createAgentSeat = (
  native?: NativeAgent
): NativeAgent & { readonly bindChain: (chain: NativeAgent) => void } => {
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const startedBy = new Map<string, NativeAgent>()
  let chain: NativeAgent | undefined

  const forward = (frame: AgentTurnFrame): void => {
    if (frame.type === "done") startedBy.delete(frame.runId)
    for (const listener of listeners) listener(frame)
  }
  if (native !== undefined) native.subscribe(forward)

  const unbound: NativeAgent = {
    available: false,
    startTurn: async () => ({ status: "error", message: "Smithers is still starting up." }) as const,
    cancelTurn: async () => {},
    subscribe: () => () => {}
  }

  const current = (): NativeAgent => chain ?? native ?? unbound

  return {
    available: true,
    startTurn: async (request) => {
      // A resume reuses its lineage's runId: route it to the agent that
      // started the run.
      const backend = startedBy.get(request.runId) ?? current()
      startedBy.set(request.runId, backend)
      return backend.startTurn(request)
    },
    cancelTurn: async (runId) => {
      await (startedBy.get(runId) ?? current()).cancelTurn(runId)
      startedBy.delete(runId)
    },
    steer: async (runId, text) => {
      const backend = startedBy.get(runId) ?? current()
      return backend.steer === undefined ? false : backend.steer(runId, text)
    },
    resolveApproval: async (runId, decision, ask) => {
      // Background lineages never pass through startTurn, so the chain is
      // preferred over whatever last started a run.
      const backend = startedBy.get(runId) ?? chain ?? current()
      return backend.resolveApproval === undefined
        ? false
        : backend.resolveApproval(runId, decision, ask)
    },
    revokeGrants: async () => {
      if (chain?.revokeGrants !== undefined) await chain.revokeGrants()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    bindChain: (bound) => {
      chain = bound
      bound.subscribe(forward)
    }
  }
}
