import { describe, expect, test } from "bun:test"
import { AGENT_ROLE_IDS, AGENT_ROLES, agentRole, agentRoleTitle, isAgentRoleId, roleLaunchArgv } from "./AgentRoles"
import { HARNESS_IDS } from "./LocalApp"

describe("the agent role registry", () => {
  test("names every role once, bound to a real harness and the verified model id", () => {
    expect(AGENT_ROLES.map((role) => role.id)).toEqual([...AGENT_ROLE_IDS])
    for (const role of AGENT_ROLES) {
      expect(HARNESS_IDS).toContain(role.harness)
      expect(role.launch[0]).toBeDefined()
      expect(role.purpose.length).toBeGreaterThan(10)
    }
    expect(agentRole("orchestrator")).toMatchObject({
      model: { id: "claude-fable-5" },
      harness: "claude",
      launch: ["claude", "--model", "claude-fable-5"],
      delegates: true
    })
    expect(agentRole("explainer")).toMatchObject({ model: { id: "k3", provider: "kimi-for-coding" }, harness: "opencode-kimi" })
    expect(agentRole("implementation")).toMatchObject({ model: { id: "gpt-5.6-sol" }, launch: ["codex", "-m", "gpt-5.6-sol"] })
    expect(agentRole("trivial-implementation")).toMatchObject({ model: { id: "gpt-5.6-luna" }, launch: ["codex", "-m", "gpt-5.6-luna"] })
    expect(agentRole("ui")).toMatchObject({ harness: "opencode-kimi", launch: ["opencode", "--model", "kimi-for-coding/k3"] })
    expect(agentRole("fast-ui")).toMatchObject({ harness: "opencode-cerebras", launch: ["opencode", "--model", "cerebras/gpt-oss-120b"] })
    expect(AGENT_ROLES.filter((role) => role.delegates).map((role) => role.id)).toEqual(["orchestrator"])
  })

  test("titles pair the role with its model, and ids are recognised", () => {
    expect(agentRoleTitle(agentRole("explainer"))).toBe("Explainer · Kimi K3")
    expect(isAgentRoleId("fast-ui")).toBe(true)
    expect(isAgentRoleId("claude")).toBe(false)
  })

  test("a delegated task rides as the CLI's first prompt: positional for claude/codex, `run` for opencode", () => {
    expect(roleLaunchArgv(agentRole("implementation"), "add a retry")).toEqual(["codex", "-m", "gpt-5.6-sol", "add a retry"])
    expect(roleLaunchArgv(agentRole("orchestrator"), " plan it ")).toEqual(["claude", "--model", "claude-fable-5", "plan it"])
    expect(roleLaunchArgv(agentRole("explainer"), "why did this fail")).toEqual([
      "opencode",
      "run",
      "-m",
      "kimi-for-coding/k3",
      "why did this fail"
    ])
    expect(roleLaunchArgv(agentRole("explainer"))).toEqual(["opencode", "--model", "kimi-for-coding/k3"])
    expect(roleLaunchArgv(agentRole("ui"), "   ")).toEqual(["opencode", "--model", "kimi-for-coding/k3"])
  })
})
