import { describe, expect, it } from "bun:test"

import { ClaudeCodeAgent } from "./ClaudeCodeAgent"

class InspectableClaudeCodeAgent extends ClaudeCodeAgent {
  getInheritedEnv() {
    return this.env
  }
}

describe("ClaudeCodeAgent", () => {
  it("does not inject an empty ANTHROPIC_API_KEY by default", () => {
    const agent = new InspectableClaudeCodeAgent()

    expect(agent.getInheritedEnv()).toBeUndefined()
  })

  it("preserves caller-provided ANTHROPIC_API_KEY values", () => {
    const agent = new InspectableClaudeCodeAgent({
      env: {
        ANTHROPIC_API_KEY: "real-key",
        EXTRA_FLAG: "enabled",
      },
    })

    expect(agent.getInheritedEnv()).toEqual({
      ANTHROPIC_API_KEY: "real-key",
      EXTRA_FLAG: "enabled",
    })
  })
})
