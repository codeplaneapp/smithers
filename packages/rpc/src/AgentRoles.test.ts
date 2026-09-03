import { describe, expect, test } from "bun:test"
import {
  AGENT_ROLE_IDS,
  AGENT_ROLES,
  AgentPutRequestSchema,
  AgentRoleSchema,
  agentIdFromLabel,
  agentRole,
  agentRoleTitle,
  findAgentRole,
  isAgentRoleId,
  isBuiltinAgentRoleId,
  orderedAgentRoles,
  roleLaunchArgv
} from "./AgentRoles"
import type { AgentRole } from "./AgentRoles"
import { HARNESS_IDS } from "./LocalApp"

const CLAUDE = { binary: "claude", flag: ["--model"] }
const CODEX = { binary: "codex", flag: ["-m"] }
const OPENCODE = { binary: "opencode", flag: ["--model"] }

const custom = {
  id: "reviewer",
  label: "Reviewer",
  purpose: "Reviews diffs for correctness and tests.",
  model: { provider: "openai", id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  harness: "codex",
  delegates: false,
  builtin: false,
  createdAt: 10,
  updatedAt: 10
} satisfies AgentRole

describe("the agent role registry", () => {
  test("seeds every built-in once, bound to a real harness and the verified model id, and stores no argv", () => {
    expect(AGENT_ROLES.map((role) => role.id)).toEqual([...AGENT_ROLE_IDS])
    for (const role of AGENT_ROLES) {
      expect(HARNESS_IDS).toContain(role.harness)
      expect(role.purpose.length).toBeGreaterThan(10)
      expect(role.builtin).toBe(true)
      expect(AgentRoleSchema.safeParse(role).success).toBe(true)
      expect("launch" in role).toBe(false)
    }
    expect(agentRole("orchestrator")).toMatchObject({ model: { id: "claude-fable-5" }, harness: "claude", delegates: true })
    expect(agentRole("explainer")).toMatchObject({ model: { id: "kimi-for-coding/k3", provider: "kimi-for-coding" }, harness: "opencode-kimi" })
    expect(agentRole("implementation")).toMatchObject({ model: { id: "gpt-5.6-sol" }, harness: "codex" })
    expect(agentRole("trivial-implementation")).toMatchObject({ model: { id: "gpt-5.6-luna" }, harness: "codex" })
    expect(agentRole("ui")).toMatchObject({ harness: "opencode-kimi", model: { id: "kimi-for-coding/k3" } })
    expect(agentRole("fast-ui")).toMatchObject({ harness: "opencode-cerebras", model: { id: "cerebras/gpt-oss-120b" } })
    expect(AGENT_ROLES.filter((role) => role.delegates).map((role) => role.id)).toEqual(["orchestrator"])
  })

  test("titles pair the role with its model; a well-formed id is recognised whether or not a row exists", () => {
    expect(agentRoleTitle(agentRole("explainer"))).toBe("Explainer · Kimi K3")
    expect(isAgentRoleId("fast-ui")).toBe(true)
    expect(isAgentRoleId("reviewer")).toBe(true)
    expect(isAgentRoleId("claude")).toBe(true)
    expect(isBuiltinAgentRoleId("fast-ui")).toBe(true)
    expect(isBuiltinAgentRoleId("reviewer")).toBe(false)
    expect(findAgentRole("reviewer")).toBeUndefined()
    expect(findAgentRole("reviewer", [...AGENT_ROLES, custom])?.label).toBe("Reviewer")
  })

  test("the schema accepts a custom row and refuses a bad id, a model with a space, and a model with a leading dash", () => {
    expect(AgentRoleSchema.safeParse(custom).success).toBe(true)
    for (const id of ["Reviewer", "1st", "a", "has space", "-lead", "x".repeat(42)]) {
      expect(AgentRoleSchema.safeParse({ ...custom, id }).success).toBe(false)
      expect(isAgentRoleId(id)).toBe(false)
    }
    for (const model of ["gpt 5", "-m", "--dangerously-skip-permissions", "", "x".repeat(82)]) {
      expect(AgentRoleSchema.safeParse({ ...custom, model: { ...custom.model, id: model } }).success).toBe(false)
      expect(AgentPutRequestSchema.safeParse({
        label: custom.label,
        purpose: custom.purpose,
        harness: custom.harness,
        model: { ...custom.model, id: model }
      }).success).toBe(false)
    }
    // Provider-qualified ids (opencode) and dotted versions pass.
    expect(AgentRoleSchema.safeParse({ ...custom, model: { ...custom.model, id: "cerebras/gpt-oss-120b" } }).success).toBe(true)
    expect(AgentPutRequestSchema.safeParse({ label: "R", purpose: "", harness: "codex", model: custom.model }).success).toBe(true)
    expect(AgentPutRequestSchema.safeParse({ label: "R", purpose: "", harness: "codex", model: custom.model, extra: 1 }).success).toBe(false)
  })

  test("the launch argv is composed per harness: binary, model flag, model id, then the task as the first prompt", () => {
    expect(roleLaunchArgv(agentRole("orchestrator"), CLAUDE)).toEqual(["claude", "--model", "claude-fable-5"])
    expect(roleLaunchArgv(agentRole("orchestrator"), CLAUDE, " plan it ")).toEqual(["claude", "--model", "claude-fable-5", "plan it"])
    expect(roleLaunchArgv(agentRole("implementation"), CODEX, "add a retry")).toEqual(["codex", "-m", "gpt-5.6-sol", "add a retry"])
    expect(roleLaunchArgv(custom, CODEX)).toEqual(["codex", "-m", "gpt-5.6-terra"])
    expect(roleLaunchArgv(agentRole("explainer"), OPENCODE)).toEqual(["opencode", "--model", "kimi-for-coding/k3"])
    expect(roleLaunchArgv(agentRole("explainer"), OPENCODE, "why did this fail")).toEqual([
      "opencode",
      "run",
      "-m",
      "kimi-for-coding/k3",
      "why did this fail"
    ])
    expect(roleLaunchArgv(agentRole("ui"), OPENCODE, "   ")).toEqual(["opencode", "--model", "kimi-for-coding/k3"])
  })

  test("renderer input never reaches argv verbatim: a model id that is a flag is refused at composition", () => {
    expect(() => roleLaunchArgv({ model: { ...custom.model, id: "--yolo" } }, CODEX)).toThrow(/not a model id/)
    expect(() => roleLaunchArgv({ model: { ...custom.model, id: "gpt -m evil" } }, CODEX)).toThrow(/not a model id/)
    // The task is one positional argument, whatever it contains.
    expect(roleLaunchArgv(custom, CODEX, "--dangerously-skip-permissions do it")).toEqual([
      "codex",
      "-m",
      "gpt-5.6-terra",
      "--dangerously-skip-permissions do it"
    ])
  })

  test("orderedAgentRoles keeps the built-ins first in table order, custom agents oldest first; an empty list is the built-ins", () => {
    const later = { ...custom, id: "docs-writer", label: "Docs writer", createdAt: 20, updatedAt: 20 }
    const ordered = orderedAgentRoles([later, custom, ...[...AGENT_ROLES].reverse()])
    expect(ordered.map((role) => role.id)).toEqual([...AGENT_ROLE_IDS, "reviewer", "docs-writer"])
    expect(orderedAgentRoles([])).toBe(AGENT_ROLES)
  })

  test("an id derives from a name when none was typed", () => {
    expect(agentIdFromLabel("Docs writer")).toBe("docs-writer")
    expect(agentIdFromLabel("  Reviewer (mine) ")).toBe("reviewer-mine")
    expect(agentIdFromLabel("42")).toBeUndefined()
    expect(agentIdFromLabel("")).toBeUndefined()
  })
})
