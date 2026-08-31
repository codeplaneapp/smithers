import { z } from "zod"
import { HARNESS_IDS } from "./LocalApp"

/*
 * The named agent roles (docs/LOCAL-APP.md "Tabs" → "Agents"): every role is
 * a job description bound to one model and to the local harness that runs
 * that model. Roles are DATA — the `+` menus, the PTY route, the subagent
 * card, and the orchestrator's instructions all read this one table — so a
 * role can never be launched with a different model than it names, and the
 * server (not the renderer) turns a role id into a launch argv.
 *
 * Model ids and CLI flags are verified against the installed binaries:
 *  - `claude --model <model>` accepts a full model name ("claude-fable-5").
 *  - `codex -m <MODEL>` ("gpt-5.6-sol", "gpt-5.6-luna"; the same ids
 *    packages/model/src/DeferredTools.ts lists for the GPT-5.6 family).
 *  - `opencode --model provider/model`: `opencode models kimi-for-coding`
 *    lists `k3`; `opencode models cerebras` lists `gpt-oss-120b` and
 *    `gemma-4-31b` (opencode 1.18.22, this machine).
 */
export const AGENT_ROLE_IDS = [
  "orchestrator",
  "explainer",
  "implementation",
  "trivial-implementation",
  "ui",
  "fast-ui"
] as const
export const AgentRoleIdSchema = z.enum(AGENT_ROLE_IDS)
export type AgentRoleId = z.infer<typeof AgentRoleIdSchema>

export const AgentRoleSchema = z.object({
  id: AgentRoleIdSchema,
  label: z.string(),
  /** One sentence the model and the UI both read. */
  purpose: z.string(),
  model: z.object({ provider: z.string(), id: z.string(), label: z.string() }),
  /** The local harness that runs this model; its availability is the role's. */
  harness: z.enum(HARNESS_IDS),
  /** The launch argv (argv[0] is the harness binary name, resolved server-side). */
  launch: z.array(z.string()),
  /** Whether this role's job is to delegate to the others. */
  delegates: z.boolean()
})
export type AgentRole = z.infer<typeof AgentRoleSchema>

export const AGENT_ROLES: ReadonlyArray<AgentRole> = [
  {
    id: "orchestrator",
    label: "Orchestrator",
    purpose: "The smartest agent: plans, writes workflows frame by frame, and delegates most work to the other roles.",
    model: { provider: "anthropic", id: "claude-fable-5", label: "Fable 5" },
    harness: "claude",
    launch: ["claude", "--model", "claude-fable-5"],
    delegates: true
  },
  {
    id: "explainer",
    label: "Explainer",
    purpose: "Explains things very well: errors, code, runs, and decisions, in plain language.",
    model: { provider: "kimi-for-coding", id: "k3", label: "Kimi K3" },
    harness: "opencode-kimi",
    launch: ["opencode", "--model", "kimi-for-coding/k3"],
    delegates: false
  },
  {
    id: "implementation",
    label: "Implementation",
    purpose: "Implements non-trivial changes end to end, with tests.",
    model: { provider: "openai", id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    harness: "codex",
    launch: ["codex", "-m", "gpt-5.6-sol"],
    delegates: false
  },
  {
    id: "trivial-implementation",
    label: "Trivial implementation",
    purpose: "Makes small, low-risk, mechanical changes quickly.",
    model: { provider: "openai", id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    harness: "codex",
    launch: ["codex", "-m", "gpt-5.6-luna"],
    delegates: false
  },
  {
    id: "ui",
    label: "UI",
    purpose: "Builds and reviews UI and visual work.",
    model: { provider: "kimi-for-coding", id: "k3", label: "Kimi K3" },
    harness: "opencode-kimi",
    launch: ["opencode", "--model", "kimi-for-coding/k3"],
    delegates: false
  },
  {
    id: "fast-ui",
    label: "Fast UI",
    purpose: "Fast, cheap UI iterations.",
    model: { provider: "cerebras", id: "gpt-oss-120b", label: "Cerebras gpt-oss-120b" },
    harness: "opencode-cerebras",
    launch: ["opencode", "--model", "cerebras/gpt-oss-120b"],
    delegates: false
  }
]

export const isAgentRoleId = (value: string): value is AgentRoleId =>
  (AGENT_ROLE_IDS as ReadonlyArray<string>).includes(value)

export const agentRole = (id: AgentRoleId): AgentRole => {
  const role = AGENT_ROLES.find((candidate) => candidate.id === id)
  if (role === undefined) throw new Error(`Unknown agent role ${id}`)
  return role
}

/** "Explainer · Kimi K3": the menu label. */
export const agentRoleTitle = (role: AgentRole): string => `${role.label} · ${role.model.label}`

/**
 * The launch argv for a role, with the delegated task as the CLI's first
 * prompt when there is one. `claude [prompt]` and `codex [PROMPT]` take it
 * positionally; the OpenCode TUI takes none, so a task runs through
 * `opencode run -m provider/model <message>` (opencode 1.18.22 `run --help`).
 */
export const roleLaunchArgv = (role: AgentRole, task?: string): ReadonlyArray<string> => {
  const base = [...role.launch]
  const prompt = task?.trim() ?? ""
  if (prompt === "") return base
  if (base[0] === "opencode") {
    const model = base[base.indexOf("--model") + 1] ?? ""
    return ["opencode", "run", "-m", model, prompt]
  }
  return [...base, prompt]
}
