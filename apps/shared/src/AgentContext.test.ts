import { describe, expect, test } from "bun:test"
import {
  AGENT_RUNTIME_CONTEXT_VERSION,
  AgentRuntimeContextSchema,
  composeAgentInstructions,
  renderAgentRuntimeContext
} from "./AgentContext"
import type { AgentRuntimeContext } from "./AgentContext"

const contextFixture = (overrides: Partial<AgentRuntimeContext> = {}): AgentRuntimeContext => ({
  version: AGENT_RUNTIME_CONTEXT_VERSION,
  product: "smithers",
  capturedAt: 1786223000000,
  revision: 7,
  surface: "chat",
  theme: "dark",
  selectedWorldDocument: null,
  connectors: [],
  github: { connected: false, login: null, watchedRepos: null },
  worldState: { documentCount: 0, documents: [] },
  capabilities: ["Hold a streaming conversation in this chat and read its visible transcript."],
  limitations: ["Cannot see or control the host environment beyond what this context block states."],
  ...overrides
})

describe("renderAgentRuntimeContext", () => {
  test("truthfully identifies the Smithers product and the current surface", () => {
    const rendered = renderAgentRuntimeContext(contextFixture())
    expect(rendered).toContain("Smithers")
    expect(rendered).toContain("running INSIDE the Smithers product")
    expect(rendered).toContain("Current surface: chat")
    expect(rendered).toContain("app-state revision 7")
    // The chat surface says nothing about panes: there is no pane open.
    expect(rendered).not.toContain("embedded pane")
  })

  test("a pane surface is stated as a pane, never as a chat that went away", () => {
    // Chat-first: opening World or Connectors does not replace the
    // conversation, so the context must not imply the composer is gone.
    for (const surface of ["world", "connectors"] as const) {
      const rendered = renderAgentRuntimeContext(contextFixture({ surface }))
      expect(rendered).toContain(`Current surface: ${surface}`)
      expect(rendered).toContain("embedded pane inside the chat shell")
      expect(rendered).toContain("transcript and composer stay visible")
    }
  })

  test("states connectors and world-state summaries only when they actually exist", () => {
    const empty = renderAgentRuntimeContext(contextFixture())
    expect(empty).toContain("Connectors: none connected")
    expect(empty).toContain("World state: no documents yet.")

    const populated = renderAgentRuntimeContext(
      contextFixture({
        connectors: [
          {
            kind: "local-repository",
            name: "smithers",
            status: "connected",
            access: "read-write",
            root: "/Users/will/smithers",
            branch: "main"
          }
        ],
        worldState: {
          documentCount: 2,
          documents: [
            { path: "Notes.md", title: "Notes", confidence: 1 },
            { path: "Roadmap.md", title: "Roadmap", confidence: 0.6 }
          ]
        },
        selectedWorldDocument: "Roadmap.md"
      })
    )
    expect(populated).toContain(
      "local-repository \"smithers\" (connected, read-write access) at /Users/will/smithers, branch main"
    )
    expect(populated).toContain("World state: 2 document(s)")
    expect(populated).toContain("Roadmap.md — \"Roadmap\" (confidence 0.6)")
    expect(populated).toContain("world document open: \"Roadmap.md\"")
  })

  /*
   * §10.8: a note holding a fact recorded nowhere else was invisible to the
   * model — the block carried paths, titles and confidences and never a word
   * the user wrote. The World pane calls itself "what Smithers currently
   * understands", so the notes' own text is the substance of that claim.
   */
  test("a world note's own words are in the block, marked when the budget cut them", () => {
    const rendered = renderAgentRuntimeContext(
      contextFixture({
        worldState: {
          documentCount: 3,
          documents: [
            {
              path: "Glossary.md",
              title: "Glossary",
              confidence: 1,
              body: "The canary codeword for this workspace is zarquon-mimsy-7741."
            },
            { path: "Long.md", title: "Long", confidence: 1, body: "the head of it", bodyTruncated: true },
            { path: "Dropped.md", title: "Dropped", confidence: 1, body: "", bodyTruncated: true }
          ]
        }
      })
    )
    expect(rendered).toContain("zarquon-mimsy-7741")
    // A cut note says it was cut, so the model never reads silence as "empty".
    expect(rendered).toContain("note truncated here")
    expect(rendered).toContain("did not fit this turn's context budget")
    // And the block says plainly that the notes are the answer.
    expect(rendered).toContain("These notes ARE what Smithers understands")
  })

  test("a note-less document list still renders, so an older client is not broken by the new field", () => {
    const rendered = renderAgentRuntimeContext(
      contextFixture({
        worldState: {
          documentCount: 1,
          documents: [{ path: "Notes.md", title: "Notes", confidence: 1 }]
        }
      })
    )
    expect(rendered).toContain("Notes.md — \"Notes\" (confidence 1)")
    expect(rendered).not.toContain("truncated")
  })

  test("carries the honest capabilities and limitations verbatim", () => {
    const rendered = renderAgentRuntimeContext(contextFixture())
    expect(rendered).toContain("Hold a streaming conversation in this chat")
    expect(rendered).toContain("Cannot see or control the host environment")
  })

  test("renders an out-of-range timestamp as unknown instead of throwing", () => {
    // The boundary renders whatever crossed the wire; a bogus capturedAt must
    // not turn the turn into a misleading upstream failure.
    const rendered = renderAgentRuntimeContext(contextFixture({ capturedAt: 1e20 }))
    expect(rendered).toContain("Captured: unknown")
    expect(rendered).toContain("running INSIDE the Smithers product")
  })
})

describe("composeAgentInstructions", () => {
  test("returns the instructions untouched when no context rides the turn", () => {
    expect(composeAgentInstructions("Be brief.")).toBe("Be brief.")
  })

  test("appends the rendered context block after the instructions", () => {
    const composed = composeAgentInstructions("Be brief.", contextFixture())
    expect(composed.startsWith("Be brief.\n\n")).toBe(true)
    expect(composed).toContain("Runtime context")
  })
})

describe("AgentRuntimeContextSchema", () => {
  test("accepts the versioned contract and rejects a foreign version", () => {
    expect(AgentRuntimeContextSchema.safeParse(contextFixture()).success).toBe(true)
    expect(
      AgentRuntimeContextSchema.safeParse({ ...contextFixture(), version: 2 }).success
    ).toBe(false)
  })

  test("rejects a capturedAt outside the representable time range", () => {
    expect(
      AgentRuntimeContextSchema.safeParse({ ...contextFixture(), capturedAt: 1e20 }).success
    ).toBe(false)
  })
})
