/*
 * The registry runtime: one dispatch path for every trigger.
 *
 * Every interactive affordance in the app is a registered flow, and every
 * trigger — button, pill, slash menu, agent call — resolves to the SAME
 * `FlowBinding` and invokes it the same way. Launch law: a button with no flow
 * behind it is a launch blocker (parity.test.ts gates this).
 *
 * The catalog disclosed to the agent is not a second projection of this
 * registry; it is this registry narrowed to model-invocable entries, and the
 * same bindings answer the calls. That is why `CommandCatalog.ts` no longer
 * exists: a parallel projection is exactly the drift the one-door law forbids.
 */
import * as Cell from "@smthrs/harness/Cell"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import { Effect } from "effect"
import type { AgentToolCall, AgentToolSpec } from "./agentTools"
import { agentToolSpecs, executeAgentToolCall, userOnlyError } from "./agentTools"
import type { CommandActions } from "./Flows"
import { adminFlows, baseFlows } from "./Flows"
import type { CatalogItem, CommandState, FlowEntry, SlashItem } from "./registry"
import {
  canonical,
  flowRequirements,
  itemOf,
  modelInvocable,
  nameOf,
  recommendedNames,
  slashItems,
  unmetRequirements,
  visible
} from "./registry"
import { payloadFor } from "./SlashPayload"

export type { CommandActions, CommandResult } from "./Flows"

export type CommandOutcome =
  | { readonly status: "executed"; readonly value?: string }
  | { readonly status: "unknown-command" }
  | { readonly status: "failed"; readonly error: string }

export interface CommandRegistry {
  /** Every registered flow as UI-catalog records, admin entries included only for admin sessions. */
  readonly all: () => ReadonlyArray<CatalogItem>
  /** The same flows as executable entries. */
  readonly entries: () => ReadonlyArray<FlowEntry>
  readonly find: (name: string) => FlowEntry | undefined
  readonly state: () => CommandState
  readonly slashItems: (needle: string) => Array<SlashItem<CatalogItem>>
  readonly recommended: () => CatalogItem
  readonly run: (name: string, args?: string) => Promise<CommandOutcome>
  /**
   * `run` at the agent boundary (requirement axis): an unmet requirement is an
   * honest failure carrying the reason — never a deferral, because a model must
   * not enqueue work that fires after its turn ends.
   */
  readonly runAsAgent: (name: string, args?: string) => Promise<CommandOutcome>
  /**
   * The agent's entry point: one call through the identical run path buttons
   * and slash use. The result is an honest string that round-trips to the model.
   */
  readonly executeForAgent: (call: AgentToolCall) => Promise<string>
  /**
   * One flow as the agent actor, answered as a TYPED outcome. The string
   * channel executeForAgent returns cannot distinguish a failure from a success
   * value that happens to start with a failure prefix; this path never sniffs
   * strings.
   */
  readonly runForAgent: (name: string, args?: string) => Promise<CommandOutcome>
  /** The flows the agent may call: the registry narrowed to model-invocable entries. */
  readonly callable: () => ReadonlyArray<FlowEntry>
  /** What the prompt's catalog block teaches: callable flows that are not hidden. */
  readonly disclosed: () => ReadonlyArray<Descriptor.FlowDescriptor>
  readonly toolSpecs: () => ReadonlyArray<AgentToolSpec>
}

/**
 * The synthetic call identity the app's own dispatch uses.
 *
 * A cell frame numbers its calls so replay reaches the same boundary; the app's
 * buttons and slash menu have no frame to replay, so they present a stable
 * non-durable identity instead. The binding needs the identity only to name a
 * durable boundary a handler opens, and none of these handlers open one.
 */
const callFor = (entry: FlowEntry, payload: Record<string, unknown>): Cell.Call =>
  new Cell.Call({
    flowName: nameOf(entry),
    input: payload as Cell.Call["input"],
    capabilities: entry.binding.descriptor.capabilities,
    effects: entry.binding.descriptor.effects,
    placement: entry.binding.descriptor.placement,
    identity: new Cell.CallIdentity({
      session: "app",
      frame: 0,
      cell: "app",
      ordinal: 0,
      declaration: Cell.declarationDigest(entry.binding.descriptor),
      layers: []
    })
  })

/*
 * FlowBinding frames a handler refusal for the cell that will read it next
 * ("Flow x failed: …"). The app surfaces the same refusal to a human, where the
 * frame is noise, so the deterministic prefix comes back off. See
 * LIBRARY-CHANGE-REQUESTS.md — the honest fix is for CallResult to carry the
 * raw message beside the framed one.
 */
const unframe = (name: string, message: string | undefined): string => {
  if (message === undefined) return `/${name} failed`
  const failed = `Flow ${name} failed: `
  if (message.startsWith(failed)) return message.slice(failed.length)
  return message
}

/** The one string an app flow's success may carry back to the model. */
const valueOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const carried = (value as { readonly value?: unknown }).value
  return typeof carried === "string" ? carried : undefined
}

export const createCommandRegistry = (actions: CommandActions): CommandRegistry => {
  const base = baseFlows(actions)
  const admin = adminFlows(actions)

  const entries = (): ReadonlyArray<FlowEntry> => actions.snapshot().admin ? [...base, ...admin] : base

  const items = (): ReadonlyArray<CatalogItem> => entries().map(itemOf)

  const find = (name: string): FlowEntry | undefined => entries().find((entry) => nameOf(entry) === name)

  /** Invokes one flow through its binding — the single door every trigger shares. */
  const invoke = async (
    entry: FlowEntry,
    payload: Record<string, unknown>
  ): Promise<CommandOutcome> => {
    const name = nameOf(entry)
    const settled = await Effect.runPromise(
      Effect.result(entry.binding.run(callFor(entry, payload)))
    )
    if (settled._tag === "Failure") {
      // A permission park or an assembly failure is not the human's business
      // to catch; surfaced honestly, it is still a failed invocation.
      return { status: "failed", error: unframe(name, settled.failure.message) }
    }
    const result = settled.success
    if (result.outcome === "failure") {
      return { status: "failed", error: unframe(name, result.message) }
    }
    const value = valueOf(result.value)
    return value === undefined ? { status: "executed" } : { status: "executed", value }
  }

  /**
   * The one execution path every trigger (button, pill, slash, agent) shares.
   * The requirement axis resolves FIRST: a user-invoked flow with an unmet
   * requirement parks durably (actions.deferCommand) and the requirement's
   * fulfilling flow runs in its place — the controller resumes the parked flow
   * when the requirement's predicate flips true. Requirements resolve one at a
   * time against live state, so a flow needing sign-in AND a repo selection
   * steps through both. `seen` guards a misconfigured requirement table (a
   * fulfill cycle) with an honest failure instead of recursion.
   */
  const runAs = async (
    invoker: "user" | "agent",
    name: string,
    args?: string,
    seen: ReadonlySet<string> = new Set()
  ): Promise<CommandOutcome> => {
    const entry = find(name)
    if (entry === undefined) return { status: "unknown-command" }
    const targetName = canonical(name, items())
    const target = find(targetName) ?? entry
    const unmet = unmetRequirements(target.metadata, actions.snapshot(), flowRequirements)[0]
    if (unmet !== undefined) {
      if (invoker === "agent") {
        /*
         * The machinery renders the missing sign-in step ITSELF — a model told
         * about auth.prompt sometimes writes the name as prose instead of
         * invoking it, and prose is not a button.
         */
        if (unmet.id === "signed-in") {
          actions.promptSignIn()
          return {
            status: "failed",
            error: `${unmet.reason} — the sign-in step is already rendered in the chat; point the user at it`
          }
        }
        return { status: "failed", error: `${unmet.reason} — /${nameOf(target)} waits on that` }
      }
      if (seen.has(unmet.fulfill)) {
        return {
          status: "failed",
          error: `${unmet.reason} — and /${unmet.fulfill} could not fulfill it`
        }
      }
      actions.deferCommand(nameOf(target), args ?? null, unmet.id)
      return runAs("user", unmet.fulfill, undefined, new Set([...seen, unmet.fulfill]))
    }
    /*
     * The composer boundary: argument text becomes the flow's typed payload
     * exactly once, here, and a text that cannot be parsed is refused before
     * the binding runs.
     */
    const parsed = payloadFor(nameOf(target), args)
    if ("error" in parsed) return { status: "failed", error: parsed.error }
    const outcome = await invoke(target, parsed.payload)
    // A successful, user-invoked, LISTED flow feeds the slash menu's recency
    // ranking; hidden id-scoped acts never rank.
    if (outcome.status === "executed" && invoker === "user" && target.metadata.hidden !== true) {
      actions.noteCommandRun(nameOf(target))
    }
    return outcome
  }

  const run = (name: string, args?: string): Promise<CommandOutcome> => runAs("user", name, args)

  const callable = (): ReadonlyArray<FlowEntry> => entries().filter(modelInvocable)

  const registry: CommandRegistry = {
    all: items,
    entries,
    find,
    state: actions.snapshot,
    slashItems: (needle) => slashItems(actions.snapshot(), needle, items()),
    recommended: () => {
      const name = recommendedNames(actions.snapshot())[0]
      const command = name === undefined ? undefined : items().find((item) => item.name === name)
      if (command === undefined) throw new Error("The recommended flow is not registered")
      return command
    },
    run,
    runAsAgent: (name, args) => runAs("agent", name, args),
    executeForAgent: (call) => actions.withAgentActor(() => executeAgentToolCall(registry, call)),
    runForAgent: (name, args) =>
      actions.withAgentActor(async () => {
        const clean = name.trim().replace(/^\/+/, "")
        const target = find(clean)
        if (target !== undefined && !modelInvocable(target)) {
          return { status: "failed", error: userOnlyError(clean) }
        }
        return runAs("agent", clean, args)
      }),
    callable,
    /*
     * Callable vs disclosed mirrors the tool contract exactly: the agent may
     * EXECUTE every model-invocable flow (hidden id-scoped actions like
     * world.new-note included — hidden means unlisted to the human, not barred
     * to the agent), while the DISCLOSED set the prompt's catalog block
     * teaches is the unhidden subset.
     */
    disclosed: () =>
      callable()
        .filter((entry) => entry.metadata.hidden !== true)
        .map((entry) => entry.binding.descriptor),
    toolSpecs: () => agentToolSpecs
  }
  return registry
}

/** Re-exported so surfaces can name the catalog record without reaching for registry.ts. */
export type { CatalogItem } from "./registry"

/** The visible catalog, for the "/flows" answer and the slash menu. */
export const visibleItems = (registry: CommandRegistry): Array<CatalogItem> => visible(registry.all())
