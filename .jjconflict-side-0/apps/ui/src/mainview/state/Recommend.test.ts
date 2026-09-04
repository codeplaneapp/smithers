import { describe, expect, test } from "bun:test"
import type { CatalogItem, CommandState } from "../flows/registry"
import {
  isMaterialTransition,
  MAX_RECOMMENDATIONS,
  parseRecommendations,
  recommendationPrompt,
  ruleSuggestions
} from "./Recommend"

/*
 * The recommender's pure half: what triggers it, what it asks, how an answer
 * is validated against the registry, and the rule it falls back to.
 */

const catalog: ReadonlyArray<CatalogItem> = [
  { name: "connect", summary: "Connect a repository" },
  { name: "world", summary: "Open the world notes" },
  { name: "flow.list", summary: "List the workflows on your workspace" },
  { name: "issues.view", summary: "View an issue", args: "<number>" },
  { name: "card.maximize", summary: "Maximize a card", hidden: true }
]

const state: CommandState = {
  surface: "chat",
  typing: false,
  hasConnectors: true,
  admin: false,
  signedOut: false,
  identity: "signed-in as will"
}

describe("recommend — triggers", () => {
  test("material transitions regenerate; keystrokes, deltas, menus, and its own write do not", () => {
    for (const type of ["repos.loaded", "connector.local.connected", "message.response.completed", "tab.opened"]) {
      expect(isMaterialTransition(type)).toBe(true)
    }
    for (
      const type of [
        "composer.changed",
        "message.response.delta",
        "add-menu.toggled",
        "recommendations.updated",
        "flow.invoked",
        "toast.shown"
      ]
    ) {
      expect(isMaterialTransition(type)).toBe(false)
    }
  })
})

describe("recommend — the answer contract", () => {
  test("drops unknown and hidden flows, dedupes, caps, golds the first, keeps args only where the flow takes them", () => {
    const answer = JSON.stringify({
      suggestions: [
        { flow: "/issues.view", label: "Open issue 12", args: "12", why: "you asked about it" },
        { flow: "card.maximize", label: "hidden" },
        { flow: "made.up", label: "nope" },
        { flow: "issues.view", label: "duplicate" },
        { flow: "world", label: "Notes", args: "ignored" },
        { flow: "connect", label: "Connect" },
        { flow: "flow.list", label: "Too many" }
      ]
    })
    const suggestions = parseRecommendations(`Sure:\n\`\`\`json\n${answer}\n\`\`\``, catalog)
    expect(suggestions.map((suggestion) => suggestion.flow)).toEqual(["issues.view", "world", "connect"])
    expect(suggestions.length).toBe(MAX_RECOMMENDATIONS)
    expect(suggestions[0]).toMatchObject({
      id: "reco-issues.view",
      label: "Open issue 12",
      args: "12",
      emphasis: "primary",
      why: "you asked about it"
    })
    expect(suggestions[1]?.args).toBeUndefined()
    expect(suggestions[1]?.emphasis).toBe("secondary")
  })

  test("the surface the user is already on is never recommended", () => {
    // Live answer on the chat: "Continue chat" → /chat, a click that changes nothing.
    const withChat = [...catalog, { name: "chat", summary: "Back to the conversation" }]
    const answer = JSON.stringify({ suggestions: [{ flow: "chat", label: "Continue chat" }, { flow: "world", label: "Notes" }] })
    expect(parseRecommendations(answer, withChat, "chat").map((s) => s.flow)).toEqual(["world"])
    expect(parseRecommendations(answer, withChat, "world").map((s) => s.flow)).toEqual(["chat"])
    expect(parseRecommendations(JSON.stringify({ suggestions: [{ flow: "connect" }] }), withChat, "connectors")).toEqual([])
    // Without a surface the parser keeps its old contract.
    expect(parseRecommendations(answer, withChat).map((s) => s.flow)).toEqual(["chat", "world"])
  })

  test("a label the model left out falls back to the flow's summary", () => {
    const [only] = parseRecommendations(`{"suggestions":[{"flow":"world"}]}`, catalog)
    expect(only?.label).toBe("Open the world notes")
  })

  test("prose, bad JSON, and a missing list are empty answers, never errors", () => {
    expect(parseRecommendations("I would click connect.", catalog)).toEqual([])
    expect(parseRecommendations("{not json", catalog)).toEqual([])
    expect(parseRecommendations(`{"answer":"world"}`, catalog)).toEqual([])
    expect(parseRecommendations(`{"suggestions":"world"}`, catalog)).toEqual([])
  })
})

describe("recommend — the prompt", () => {
  test("lists only offerable flows and demands one JSON object", () => {
    const prompt = recommendationPrompt({
      state,
      catalog,
      repoStep: "none",
      repos: ["smithers"],
      connectors: [],
      tabs: ["Smithers", "Terminal"],
      messages: [
        { role: "user", text: "what is failing in CI?" },
        { role: "smithers", text: "Smithers ran /flows", act: "Smithers ran /flows" }
      ],
      cards: [{ kind: "targets", title: "smithers", status: "acted" }]
    })
    expect(prompt.instructions).toContain("ONE JSON object")
    expect(prompt.user).toContain("- issues.view: View an issue (args: <number>)")
    expect(prompt.user).not.toContain("card.maximize")
    expect(prompt.user).toContain("user: what is failing in CI?")
    expect(prompt.user).not.toContain("Smithers ran /flows")
    expect(prompt.user).toContain("Repositories open: smithers")
  })
})

describe("recommend — the rule", () => {
  test("the repo step leads, then the registry's recommendation order, capped", () => {
    const suggestions = ruleSuggestions({ state: { ...state, hasConnectors: false }, catalog, repoStep: "local" })
    expect(suggestions.map((suggestion) => suggestion.flow)).toEqual(["repo.open", "connect", "world"])
    expect(suggestions[0]?.emphasis).toBe("primary")
  })

  test("with a repository open the repo step is gone and the first recommendation is gold", () => {
    const suggestions = ruleSuggestions({ state, catalog, repoStep: "none" })
    expect(suggestions.map((suggestion) => suggestion.flow)).toEqual(["world", "connect"])
    expect(suggestions[0]?.emphasis).toBe("primary")
  })

  test("a streaming turn offers nothing: the pills are disabled anyway", () => {
    expect(ruleSuggestions({ state: { ...state, typing: true }, catalog, repoStep: "none" })).toEqual([])
  })
})
