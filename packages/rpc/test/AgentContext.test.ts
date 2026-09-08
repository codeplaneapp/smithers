import { describe, expect, test } from "vitest"
import {
  AGENT_RUNTIME_CONTEXT_VERSION,
  AgentRuntimeContextSchema,
  composeAgentInstructions,
  renderAgentRuntimeContext
} from "../src/AgentContext.ts"
import type { AgentRuntimeContext } from "../src/AgentContext.ts"

const contextFixture = (overrides: Partial<AgentRuntimeContext> = {}): AgentRuntimeContext => ({
  version: AGENT_RUNTIME_CONTEXT_VERSION,
  product: "smithers",
  capturedAt: 1786223000000,
  revision: 7,
  surface: "chat",
  theme: "dark",
  selectedWorldDocument: null,
  connectors: [],
  github: { connected: false, login: null, repositories: null },
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

  test("states connectors and wiki note summaries only when they actually exist, labelled Wiki in prose with the wire fields unchanged", () => {
    const empty = renderAgentRuntimeContext(contextFixture())
    expect(empty).toContain("Connectors: none connected")
    expect(empty).toContain("Wiki: no notes yet.")
    expect(empty).not.toContain("World state")

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
    expect(populated).toContain("Wiki: 2 note(s)")
    expect(populated).toContain("Roadmap.md — \"Roadmap\" (confidence 0.6)")
    expect(populated).toContain("wiki note open: \"Roadmap.md\"")
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
    // Note content is evidence; an empty starter title is not a repository identity.
    expect(rendered).toContain("Answer from their substantive content when relevant")
    expect(rendered).toContain("a blank note or a title alone supplies no repository facts")
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

  /*
   * agent-parity.md: the block stated the GitHub connection and never the
   * Smithers Cloud session, so the model reached for the GitHub prompt when
   * the cloud session was what was missing. One line per state, naming the
   * agent's door (cloud.prompt) when the session is what's missing.
   */
  test("states the Smithers Cloud session, and names cloud.prompt when it is signed out", () => {
    expect(renderAgentRuntimeContext(contextFixture({ cloud: { state: "signed-out", username: null } }))).toContain(
      "- Smithers Cloud: signed out (workspaces, changes and sync need it; cloud.prompt renders the sign-in button)."
    )
    expect(renderAgentRuntimeContext(contextFixture({ cloud: { state: "signed-in", username: "will" } }))).toContain(
      "- Smithers Cloud: signed in as will."
    )
    const degraded = renderAgentRuntimeContext(contextFixture({ cloud: { state: "degraded", username: "will" } }))
    expect(degraded).toContain("- Smithers Cloud: signed in as will with a degraded session")
    expect(degraded).toContain("cloud.prompt")
    expect(renderAgentRuntimeContext(contextFixture({ cloud: { state: "unavailable", username: null } }))).toContain(
      "- Smithers Cloud: unavailable on this host."
    )
    // A boundary built before the field renders no cloud line and still validates.
    expect(renderAgentRuntimeContext(contextFixture())).not.toContain("Smithers Cloud:")
    expect(
      AgentRuntimeContextSchema.safeParse(contextFixture({ cloud: { state: "signed-out", username: null } })).success
    ).toBe(true)
  })

  test("names the active repository, says when none is selected, and stays silent for a client without the field", () => {
    expect(renderAgentRuntimeContext(contextFixture({ activeRepository: "smithersai/smithers" }))).toContain(
      "- Active repository: smithersai/smithers."
    )
    expect(renderAgentRuntimeContext(contextFixture({ activeRepository: null }))).toContain(
      "- Active repository: none selected."
    )
    expect(renderAgentRuntimeContext(contextFixture())).not.toContain("Active repository")
    expect(AgentRuntimeContextSchema.safeParse(contextFixture({ activeRepository: "smithersai/smithers" })).success)
      .toBe(true)
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
