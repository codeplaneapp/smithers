import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import type { CatalogItem, CommandState } from "../../flows/registry"
import type { RepoStep } from "../../Onboarding"
import { RECOMMEND_FLOW, isMaterialTransition, parseRecommendations, recommendationPrompt, ruleSuggestions } from "../Recommend"
import type { RecommendInput } from "../Recommend"
import type { ControllerContext } from "./context"

/*
 * The recommender's controller half (Recommend.ts has the pure half): a
 * store-driven regeneration of the next-step pills.
 *
 *  - Trigger: a material transition lands in the transitions collection; the
 *    regeneration is debounced by revision and runs through the registered
 *    `recommend` flow, so /verbose sees it like every other act.
 *  - Answer: the rule's pills are written at once for the new revision (the
 *    stale onboarding pill must leave the moment a repo opens), then a side
 *    turn on the cheap tier replaces them when it answers. One side turn in
 *    flight; a newer revision supersedes an older one, whose answer is dropped.
 *  - Fallback: no agent seam, a refused turn, a timeout, or an unparseable
 *    answer leaves the rule's pills standing (source "rule").
 */

export interface RecommenderConfig {
  /**
   * Opt-in per composition root (ControllerBoot turns it on; nothing else
   * does). Off, the rule alone writes the row and no side turn ever reaches
   * the agent seam — so a scripted or stub agent in a test harness is never
   * consumed by a background turn.
   */
  readonly enabled?: boolean
  /** The model tier the side turn asks for; `cheap` unless a deployment says otherwise. */
  readonly tier?: "cheap" | "default"
  /** How long a burst of material transitions coalesces before one regeneration. */
  readonly debounceMs?: number
  /** How long the side turn may take before the rule's answer is final. */
  readonly timeoutMs?: number
}

export interface RecommendController {
  /** The `recommend` flow's handler: regenerate for the current revision. */
  readonly recommend: () => Promise<void>
  /** Start watching the transitions collection; released on dispose. */
  readonly subscribe: () => void
}

export interface RecommendDependencies {
  readonly catalog: () => ReadonlyArray<CatalogItem>
  readonly state: () => CommandState
  readonly repoStep: () => RepoStep
  readonly config: RecommenderConfig
}

interface SideTurn {
  readonly runId: string
  readonly revision: number
  text: string
  settled: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  unsubscribe: () => void
}

export const createRecommendController = (ctx: ControllerContext, deps: RecommendDependencies): RecommendController => {
  const { store, agent } = ctx
  const enabled = deps.config.enabled ?? false
  const tier = deps.config.tier ?? "cheap"
  const debounceMs = deps.config.debounceMs ?? 150
  const timeoutMs = deps.config.timeoutMs ?? 20_000
  let inFlight: SideTurn | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const input = (): RecommendInput => ({
    state: deps.state(),
    catalog: deps.catalog(),
    repoStep: deps.repoStep(),
    repos: [...store.collections.repos.values()].map((repo) => repo.name),
    connectors: [...store.collections.connectors.values()].map((connector) => connector.name),
    tabs: [...store.collections.tabs.values()].sort((a, b) => a.ordinal - b.ordinal).map((tab) => tab.title),
    messages: [...store.collections.messages.values()].sort((a, b) => a.ordinal - b.ordinal).slice(-8),
    cards: [...store.collections.cards.values()].sort((a, b) => a.ordinal - b.ordinal).slice(-5)
  })

  const finish = (turn: SideTurn): void => {
    if (turn.settled) return
    turn.settled = true
    if (turn.timer !== undefined) clearTimeout(turn.timer)
    turn.unsubscribe()
    if (inFlight === turn) inFlight = undefined
  }

  const supersede = (turn: SideTurn): void => {
    finish(turn)
    void agent.cancelTurn(turn.runId).catch(() => {})
  }

  const recommend: RecommendController["recommend"] = async () => {
    if (disposed) return
    const revision = store.session().revision
    const snapshot = input()
    const rule = ruleSuggestions(snapshot)
    // The honest state now: the rule answers for this revision immediately.
    store.dispatch({ type: "recommendations.updated", actor: "system", suggestions: rule, source: "rule", revision })
    if (!enabled || !agent.available) return
    if (inFlight !== undefined) {
      if (inFlight.revision >= revision) return
      supersede(inFlight)
    }
    const prompt = recommendationPrompt(snapshot)
    const runId = `recommend-${revision}-${Date.now()}`
    const turn: SideTurn = { runId, revision, text: "", settled: false, timer: undefined, unsubscribe: () => {} }
    inFlight = turn
    const settle = (): void => {
      const suggestions = parseRecommendations(turn.text, snapshot.catalog, snapshot.state.surface)
      finish(turn)
      if (suggestions.length === 0) return
      store.dispatch({ type: "recommendations.updated", actor: "smithers", suggestions, source: "agent", revision })
    }
    turn.unsubscribe = agent.subscribe((frame: AgentTurnFrame) => {
      if (frame.runId !== runId || turn.settled) return
      if (frame.type === "delta") {
        if (frame.kind === "text") turn.text += frame.text
        return
      }
      if (frame.type === "done") {
        if (frame.error !== undefined) finish(turn)
        else settle()
      }
    })
    turn.timer = setTimeout(() => supersede(turn), timeoutMs)
    ctx.unref(turn.timer)
    try {
      const result = await agent.startTurn({
        runId,
        messages: [{ role: "user", content: prompt.user }],
        instructions: prompt.instructions,
        tier,
        // A background turn, named as such: a scripted seam can ignore it.
        purpose: "recommend"
      })
      if (result.status === "error") finish(turn)
    } catch {
      finish(turn)
    }
  }

  const schedule = (): void => {
    if (disposed) return
    if (debounce !== undefined) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = undefined
      void ctx.commands.run(RECOMMEND_FLOW)
    }, debounceMs)
    ctx.unref(debounce)
  }

  const subscribe: RecommendController["subscribe"] = () => {
    const subscription = store.collections.transitions.subscribeChanges((changes) => {
      if (changes.some((change) => change.type === "insert" && isMaterialTransition(change.value.type))) schedule()
    })
    ctx.onDispose(() => {
      disposed = true
      if (debounce !== undefined) clearTimeout(debounce)
      if (inFlight !== undefined) supersede(inFlight)
      subscription.unsubscribe()
    })
  }

  return { recommend, subscribe }
}
