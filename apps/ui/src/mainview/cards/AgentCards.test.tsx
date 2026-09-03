import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { AgentFormCardBody, AgentModelsCardBody, AgentsCardBody } from "./AgentCards"

/*
 * Agents as data (custom-agents.md): the Agents card's rows and acts, the
 * form card's create path (every field commits through agent.form, the
 * submit IS agent.create, nothing lives in component state), and the models
 * card. Every act is asserted as the flow it names.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

type AgentsCard = Extract<Card, { kind: "agents" }>
type AgentFormCard = Extract<Card, { kind: "agent-form" }>
type AgentModelsCard = Extract<Card, { kind: "agent-models" }>

const base = { title: "Agents", status: "active" as const, createdAt: 0, ordinal: 0 }

const agentsCard = (payload: AgentsCard["payload"]): AgentsCard => ({ ...base, id: "agents", kind: "agents", payload })

const orchestrator: AgentsCard["payload"]["agents"][number] = {
  id: "orchestrator",
  label: "Orchestrator",
  purpose: "Plans and delegates.",
  harness: "claude",
  harnessName: "Claude Code",
  model: { provider: "anthropic", id: "claude-fable-5", label: "Fable 5" },
  builtin: true,
  available: true,
  reason: "",
  account: "will@example.com"
}
const reviewer: AgentsCard["payload"]["agents"][number] = {
  ...orchestrator,
  id: "reviewer",
  label: "Reviewer",
  purpose: "Reviews diffs.",
  harness: "codex",
  harnessName: "Codex",
  model: { provider: "openai", id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  builtin: false,
  account: "OPENAI_API_KEY"
}
const docs: AgentsCard["payload"]["agents"][number] = {
  ...reviewer,
  id: "docs-writer",
  label: "Docs writer",
  harness: "opencode-kimi",
  harnessName: "OpenCode · Kimi",
  model: { provider: "kimi-for-coding", id: "kimi-for-coding/k3", label: "Kimi K3" },
  available: false,
  reason: "OpenCode · Kimi has no credential for Kimi K3",
  account: ""
}

const formCard = (payload: Partial<AgentFormCard["payload"]> = {}): AgentFormCard => ({
  ...base,
  id: "agent-form",
  kind: "agent-form",
  title: "New agent",
  payload: {
    mode: "create",
    draft: { id: "", label: "", purpose: "", harness: "codex", model: "" },
    harnesses: [
      { id: "claude", displayName: "Claude Code", status: "signed-in", account: "will@example.com" },
      { id: "codex", displayName: "Codex", status: "api-key", account: "OPENAI_API_KEY" },
      { id: "opencode", displayName: "OpenCode", status: "binary-only", account: "" }
    ],
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    modelsSource: "suggestions",
    phase: "editing",
    ...payload
  }
})

const mount = (node: React.ReactNode): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(node)
  })
  return host
}

const recorder = () => {
  const calls: Array<[string, string | undefined]> = []
  return { calls, onRunCommand: (name: string, args?: string) => void calls.push([name, args]) }
}

const click = (host: HTMLElement, selector: string): void => {
  const element = host.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`no element for ${selector}`)
  element.click()
}

describe("the Agents card", () => {
  test("lists every agent with its harness, model, and live availability, and each act names its flow", () => {
    const { calls, onRunCommand } = recorder()
    const host = mount(<AgentsCardBody card={agentsCard({ native: true, agents: [orchestrator, reviewer, docs] })} onRunCommand={onRunCommand} />)
    const rows = [...host.querySelectorAll<HTMLElement>("[data-agent]")]
    expect(rows.map((row) => row.dataset.agent)).toEqual(["orchestrator", "reviewer", "docs-writer"])
    expect(rows[0]?.textContent).toContain("Orchestrator")
    expect(rows[0]?.textContent).toContain("Claude Code · claude-fable-5 · ● will@example.com")
    expect(rows[1]?.textContent).toContain("Reviewer (mine)")
    expect(rows[2]?.textContent).toContain("○ OpenCode · Kimi has no credential for Kimi K3")
    // A built-in offers Launch and Edit, never Remove; a custom one offers Remove too; an unavailable one offers no Launch.
    expect(host.querySelector("[data-testid=agents-launch-orchestrator]")).not.toBeNull()
    expect(host.querySelector("[data-testid=agents-remove-orchestrator]")).toBeNull()
    expect(host.querySelector("[data-testid=agents-remove-reviewer]")).not.toBeNull()
    expect(host.querySelector("[data-testid=agents-launch-docs-writer]")).toBeNull()
    expect(host.querySelector("[data-testid=agents-edit-docs-writer]")).not.toBeNull()
    click(host, "[data-testid=agents-launch-orchestrator]")
    click(host, "[data-testid=agents-edit-reviewer]")
    click(host, "[data-testid=agents-remove-reviewer]")
    click(host, "[data-testid=agents-new]")
    expect(calls).toEqual([
      ["agent.role", "orchestrator"],
      ["agent.new", "reviewer"],
      ["agent.remove", "reviewer"],
      ["agent.new", undefined]
    ])
    // Every button is the flow it runs.
    expect(host.querySelector("[data-testid=agents-launch-orchestrator]")?.getAttribute("data-flow")).toBe("agent.role")
    expect(host.querySelector("[data-testid=agents-remove-reviewer]")?.getAttribute("data-flow")).toBe("agent.remove")
  })

  test("on the web host it lists nothing local and says where agents run", () => {
    const host = mount(<AgentsCardBody card={agentsCard({ native: false, agents: [] })} onRunCommand={() => {}} />)
    expect(host.textContent).toBe("Agents run on the native app's harnesses.")
    expect(host.querySelector("[data-flow]")).toBeNull()
  })

  test("the last act's refusal stays on the card", () => {
    const host = mount(<AgentsCardBody card={agentsCard({ native: true, agents: [orchestrator], error: "The server answered 500" })} onRunCommand={() => {}} />)
    expect(host.querySelector("[role=alert]")?.textContent).toBe("The server answered 500")
  })
})

describe("the New agent form card", () => {
  test("every field commits through agent.form and the submit is agent.create with the draft's id, harness, model, and purpose", () => {
    const { calls, onRunCommand } = recorder()
    const host = mount(<AgentFormCardBody card={formCard()} onRunCommand={onRunCommand} />)
    const label = host.querySelector<HTMLInputElement>("[data-testid=agent-form-label]")
    if (label === null) throw new Error("no name field")
    label.value = "Reviewer"
    label.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    const purpose = host.querySelector<HTMLInputElement>("[data-testid=agent-form-purpose]")
    if (purpose === null) throw new Error("no purpose field")
    purpose.value = "Reviews diffs for correctness"
    purpose.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    click(host, "[data-testid=agent-form-harness-claude]")
    const model = host.querySelector<HTMLInputElement>("[data-testid=agent-form-model]")
    if (model === null) throw new Error("no model field")
    model.value = "gpt-5.6-terra"
    model.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    expect(calls).toEqual([
      ["agent.form", "label Reviewer"],
      ["agent.form", "purpose Reviews diffs for correctness"],
      ["agent.form", "harness claude"],
      ["agent.form", "model gpt-5.6-terra"]
    ])
    // The submit needs an id (from the draft's name), a harness, and a model: with an empty draft it is disabled.
    expect(host.querySelector<HTMLButtonElement>("[data-testid=agent-form-submit]")?.disabled).toBe(true)
    // The suggestions ride a datalist, and the harness chips show the live signal.
    expect([...host.querySelectorAll("datalist option")].map((option) => option.getAttribute("value"))).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
    expect(host.querySelector("[data-testid=agent-form-harness-codex]")?.getAttribute("aria-checked")).toBe("true")
    expect(host.querySelector("[data-testid=agent-form-harness-opencode]")?.textContent).toContain("○")
    expect(host.querySelector("[data-testid=agent-form-harness-claude]")?.textContent).toContain("●")
  })

  test("a filled draft submits agent.create with the id derived from the name; Cancel is agent.form cancel", () => {
    const { calls, onRunCommand } = recorder()
    const host = mount(
      <AgentFormCardBody
        card={formCard({ draft: { id: "", label: "Docs writer", purpose: "Writes the docs.", harness: "codex", model: "gpt-5.6-terra" } })}
        onRunCommand={onRunCommand}
      />
    )
    const submit = host.querySelector<HTMLButtonElement>("[data-testid=agent-form-submit]")
    expect(submit?.disabled).toBe(false)
    expect(submit?.getAttribute("data-flow")).toBe("agent.create")
    expect(submit?.textContent).toBe("Create agent")
    submit?.click()
    click(host, "[data-testid=agent-form-cancel]")
    expect(calls).toEqual([
      ["agent.create", "docs-writer codex gpt-5.6-terra Writes the docs."],
      ["agent.form", "cancel"]
    ])
  })

  test("edit mode fixes the id and the harness and submits agent.edit with flags; saved and cancelled phases read as one line", () => {
    const { calls, onRunCommand } = recorder()
    const host = mount(
      <AgentFormCardBody
        card={formCard({ mode: "edit", draft: { id: "reviewer", label: "Reviewer", purpose: "Reviews diffs.", harness: "codex", model: "gpt-5.6-sol" } })}
        onRunCommand={onRunCommand}
      />
    )
    expect(host.querySelector<HTMLButtonElement>("[data-testid=agent-form-harness-claude]")?.disabled).toBe(true)
    const submit = host.querySelector<HTMLButtonElement>("[data-testid=agent-form-submit]")
    expect(submit?.getAttribute("data-flow")).toBe("agent.edit")
    expect(submit?.textContent).toBe("Save")
    submit?.click()
    expect(calls).toEqual([["agent.edit", "reviewer --model gpt-5.6-sol --purpose Reviews diffs. --label Reviewer"]])
    const saved = mount(<AgentFormCardBody card={formCard({ phase: "saved", draft: { id: "reviewer", label: "Reviewer", purpose: "", harness: "codex", model: "x" } })} onRunCommand={onRunCommand} />)
    expect(saved.textContent).toBe("Created Reviewer.")
    const cancelled = mount(<AgentFormCardBody card={formCard({ phase: "cancelled" })} onRunCommand={onRunCommand} />)
    expect(cancelled.textContent).toBe("Cancelled.")
    const failed = mount(<AgentFormCardBody card={formCard({ phase: "failed", error: "codex takes no such model" })} onRunCommand={onRunCommand} />)
    expect(failed.querySelector("[role=alert]")?.textContent).toBe("codex takes no such model")
  })
})

describe("the models card", () => {
  test("lists what the harness printed, or the reason it printed nothing", () => {
    const card: AgentModelsCard = {
      ...base,
      id: "agent-models-opencode",
      kind: "agent-models",
      title: "Models · OpenCode",
      payload: { harnessId: "opencode", displayName: "OpenCode", models: ["kimi-for-coding/k3", "cerebras/gpt-oss-120b"], source: "list" }
    }
    const host = mount(<AgentModelsCardBody card={card} />)
    expect([...host.querySelectorAll("li")].map((row) => row.textContent)).toEqual(["kimi-for-coding/k3", "cerebras/gpt-oss-120b"])
    const empty = mount(<AgentModelsCardBody card={{ ...card, payload: { ...card.payload, models: [], reason: "opencode models exited 2: no credential" } }} />)
    expect(empty.textContent).toBe("opencode models exited 2: no credential")
  })
})
