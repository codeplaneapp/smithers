import type { CatalogItem, CommandState } from "../flows/registry"
import { recommendedNames, visible } from "../flows/registry"
import { repoSuggestion } from "../Onboarding"
import type { RepoStep } from "../Onboarding"
import type { AppTransition, Card, Message, Suggestion } from "./AppState"

/*
 * The next-step pills as a WORKFLOW, not a rule (will, 2026-08-30): after every
 * material change a cheap agent reads the live state and picks what to click
 * next. This module is the pure half — what counts as material, the prompt,
 * the strict answer contract, and the rule that stands in when the agent
 * cannot answer. The controller half (controller/recommend.ts) owns the
 * debounce, the side turn, and the store write.
 */

/** The registered flow the regeneration runs through (hidden, system-invoked). */
export const RECOMMEND_FLOW = "system.recommend"
/** A pill row longer than this is a menu, not a recommendation. */
export const MAX_RECOMMENDATIONS = 3

/*
 * The transitions after which the recommendation is stale: the state a pill
 * answers has changed. Keystrokes, stream deltas, menus, and the recommender's
 * own write are deliberately absent — regenerating on those would loop.
 */
export const MATERIAL_TRANSITIONS: ReadonlySet<AppTransition["type"]> = new Set<AppTransition["type"]>([
  "repos.loaded",
  "connector.local.connected",
  "connector.removed",
  "message.response.completed",
  "message.response.failed",
  "card.approval.decided",
  "tab.opened",
  "tab.closed",
  "watched.replaced",
  "identity.session.loaded",
  "identity.session.cleared",
  "conversation.reset",
  "conversation.cleared"
])

export const isMaterialTransition = (type: string): boolean =>
  MATERIAL_TRANSITIONS.has(type as AppTransition["type"])

/** The compact state the recommender reads; every field is a projection of the store. */
export interface RecommendInput {
  readonly state: CommandState
  readonly catalog: ReadonlyArray<CatalogItem>
  readonly repoStep: RepoStep
  readonly repos: ReadonlyArray<string>
  readonly connectors: ReadonlyArray<string>
  readonly tabs: ReadonlyArray<string>
  readonly messages: ReadonlyArray<Pick<Message, "role" | "text" | "act">>
  readonly cards: ReadonlyArray<Pick<Card, "kind" | "title" | "status">>
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** The flows a recommendation may name: listed, never hidden. */
export const offerable = (catalog: ReadonlyArray<CatalogItem>): ReadonlyArray<CatalogItem> => visible(catalog)

/**
 * The side turn's instructions and one user message. The catalog is the
 * whole vocabulary: the model chooses from it and never invents a flow.
 */
export const recommendationPrompt = (input: RecommendInput): { readonly instructions: string; readonly user: string } => {
  const flows = offerable(input.catalog)
    .map((command) => `- ${command.name}: ${command.summary}${command.args === undefined ? "" : ` (args: ${command.args})`}`)
    .join("\n")
  const recent = input.messages
    .filter((message) => message.act === undefined && message.text.trim() !== "")
    .slice(-6)
    .map((message) => `${message.role === "user" ? "user" : "smithers"}: ${clip(message.text.replace(/\s+/g, " "), 200)}`)
    .join("\n")
  const cards = input.cards.slice(-5).map((card) => `- ${card.kind} "${card.title}" (${card.status})`).join("\n")
  const instructions = [
    "You recommend the next click in the Smithers app. Answer with ONE JSON object and nothing else:",
    `{"suggestions":[{"flow":"<flow name from the list>","label":"<2-4 words>","args":"<optional>","why":"<one short clause>"}]}`,
    `At most ${MAX_RECOMMENDATIONS} suggestions, best first. Only name flows from the list; an empty list is a valid answer.`,
    "Prefer the genuinely next step for this state over anything generic."
  ].join("\n")
  const user = [
    `Identity: ${input.state.identity ?? "unknown"}`,
    `Surface: ${input.state.surface}`,
    `Repositories open: ${input.repos.length === 0 ? "none" : input.repos.join(", ")}`,
    `Local connectors: ${input.connectors.length === 0 ? "none" : input.connectors.join(", ")}`,
    `Tabs: ${input.tabs.join(", ")}`,
    `Repo step: ${input.repoStep}`,
    `Recent conversation:\n${recent === "" ? "(empty)" : recent}`,
    `Recent cards:\n${cards === "" ? "(none)" : cards}`,
    `Flows:\n${flows}`
  ].join("\n\n")
  return { instructions, user }
}

const firstJsonObject = (text: string): string | undefined => {
  const unfenced = text.replace(/```(?:json)?/gi, "")
  const start = unfenced.indexOf("{")
  const end = unfenced.lastIndexOf("}")
  return start === -1 || end <= start ? undefined : unfenced.slice(start, end + 1)
}

const asString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined)

/**
 * The model's answer, validated against the registry: unknown and hidden flows
 * are dropped, duplicates collapse, the row is capped, the first is gold. Bad
 * JSON is an empty answer, never a thrown error — the caller falls back.
 */
/** The flow that opens the surface the user is already on: a no-op click, never a recommendation. */
export const currentSurfaceFlow = (surface: CommandState["surface"]): string =>
  surface === "world" ? "world" : surface === "connectors" ? "connect" : "chat"

export const parseRecommendations = (
  text: string,
  catalog: ReadonlyArray<CatalogItem>,
  surface?: CommandState["surface"]
): ReadonlyArray<Suggestion> => {
  const json = firstJsonObject(text)
  if (json === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (typeof parsed !== "object" || parsed === null) return []
  const raw = (parsed as { suggestions?: unknown }).suggestions
  if (!Array.isArray(raw)) return []
  const allowed = new Map(offerable(catalog).map((command) => [command.name, command]))
  const seen = new Set<string>()
  const suggestions: Array<Suggestion> = []
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    const flow = asString(record.flow)?.replace(/^\/+/, "")
    if (flow === undefined) continue
    const command = allowed.get(flow)
    if (command === undefined || seen.has(flow)) continue
    // The live answer recommended "Continue chat" on the chat: a click that changes nothing.
    if (surface !== undefined && flow === currentSurfaceFlow(surface)) continue
    seen.add(flow)
    const args = asString(record.args)
    const why = asString(record.why)
    suggestions.push({
      id: `reco-${flow}`,
      label: clip(asString(record.label) ?? command.summary, 40),
      flow,
      ...(args === undefined || command.args === undefined ? {} : { args }),
      emphasis: suggestions.length === 0 ? "primary" : "secondary",
      ...(why === undefined ? {} : { why: clip(why, 120) })
    })
    if (suggestions.length >= MAX_RECOMMENDATIONS) break
  }
  return suggestions
}

/**
 * The rule the agent replaces and falls back to: the repo step first (the
 * onboarding pill), then the registry's recommendation order, capped. While a
 * turn streams the pills are disabled anyway, so the row is empty then.
 */
export const ruleSuggestions = (input: Pick<RecommendInput, "state" | "catalog" | "repoStep">): ReadonlyArray<Suggestion> => {
  if (input.state.typing) return []
  const byName = new Map(offerable(input.catalog).map((command) => [command.name, command]))
  const lead = repoSuggestion(input.repoStep)
  const rest = recommendedNames(input.state)
    .filter((name) => byName.has(name) && !lead.some((suggestion) => suggestion.flow === name))
    .map((name): Suggestion => ({
      id: `reco-${name}`,
      label: byName.get(name)?.summary ?? name,
      flow: name,
      emphasis: lead.length === 0 && name === recommendedNames(input.state)[0] ? "primary" : "secondary"
    }))
  return [...lead, ...rest].slice(0, MAX_RECOMMENDATIONS)
}
