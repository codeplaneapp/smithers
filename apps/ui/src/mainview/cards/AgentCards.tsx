import { Button } from "@smthrs/ui"
import { agentIdFromLabel } from "@smthrs/rpc/AgentRoles"
import type { KeyboardEvent } from "react"
import type { Card } from "../state/AppState"

/*
 * The agents as data (docs/workbench-lanes/custom-agents.md), as cards in
 * the chat (THE EMBED LAW): the Agents card lists every built-in and custom
 * agent with its harness's live availability and the acts each row offers
 * (Launch = agent.role, Edit = agent.new <id>, Remove = agent.remove); the
 * form card holds the New-agent draft in its payload — every field commits
 * through the agent.form flow, the submit IS agent.create / agent.edit, and
 * no component state exists; the models card is what a harness's own list
 * command printed. Every act names its flow through onRunCommand.
 */

type AgentsCard = Extract<Card, { kind: "agents" }>
type AgentFormCard = Extract<Card, { kind: "agent-form" }>
type AgentModelsCard = Extract<Card, { kind: "agent-models" }>

export const AgentsCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: AgentsCard
  readonly onRunCommand: (name: string, args?: string) => void
}) => {
  const { native, agents, error } = card.payload
  if (!native) return <p className="smithers-card-note">Agents run on the native app's harnesses.</p>
  return (
    <div className="agents-card">
      <ul className="workflow-list" data-testid="agents-list">
        {agents.map((agent) => (
          <li key={agent.id} className="workflow-list-row agent-row" data-agent={agent.id} data-available={agent.available}>
            <span className="workflow-list-text">
              <strong>{agent.builtin ? agent.label : `${agent.label} (mine)`}</strong>
              <span title={agent.purpose}>
                {agent.harnessName} · {agent.model.id} · {agent.available ? `● ${agent.account === "" ? "signed in" : agent.account}` : `○ ${agent.reason}`}
              </span>
            </span>
            <span className="flow-run-actions">
              {agent.available ?
                (
                  <Button
                    size="sm"
                    variant="outline"
                    data-flow="agent.role"
                    data-testid={`agents-launch-${agent.id}`}
                    title={agent.purpose}
                    onClick={() => onRunCommand("agent.role", agent.id)}
                  >
                    Launch
                  </Button>
                ) :
                null}
              <Button
                size="sm"
                variant="outline"
                data-flow="agent.new"
                data-testid={`agents-edit-${agent.id}`}
                onClick={() => onRunCommand("agent.new", agent.id)}
              >
                Edit
              </Button>
              {agent.builtin ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  data-flow="agent.remove"
                  data-testid={`agents-remove-${agent.id}`}
                  onClick={() => onRunCommand("agent.remove", agent.id)}
                >
                  Remove
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="flow-run-actions">
        <Button size="sm" data-flow="agent.new" data-testid="agents-new" onClick={() => onRunCommand("agent.new")}>
          New agent
        </Button>
      </div>
      {error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {error}
          </p>
        ) :
        null}
    </div>
  )
}

/** Enter commits the field the way leaving it does. */
const blurOnEnter = (event: KeyboardEvent<HTMLInputElement>): void => {
  if (event.key === "Enter") {
    event.preventDefault()
    event.currentTarget.blur()
  }
}

export const AgentFormCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: AgentFormCard
  readonly onRunCommand: (name: string, args?: string) => void
}) => {
  const { mode, draft, harnesses, models, modelsReason, phase, error } = card.payload
  const name = draft.label.trim() === "" ? draft.id : draft.label
  if (phase === "saved") return <p className="smithers-card-note">{mode === "create" ? `Created ${name}.` : `Saved ${name}.`}</p>
  if (phase === "cancelled") return <p className="smithers-card-note">Cancelled.</p>
  /* A field commits when the pointer or Enter leaves it: the payload is the draft, the DOM only holds keystrokes in flight. */
  const commit = (field: string, value: string): void => onRunCommand("agent.form", value === "" ? field : `${field} ${value}`)
  const id = mode === "edit" ? draft.id : (draft.id !== "" ? draft.id : agentIdFromLabel(draft.label) ?? "")
  const submittable = phase === "editing" && id !== "" && draft.harness !== undefined && draft.model.trim() !== ""
  /* The submit IS the flow: agent.create with the draft's id, harness, model, and purpose; agent.edit with the flags. */
  const submitFlow = mode === "create" ? "agent.create" : "agent.edit"
  const submitArgs = mode === "create"
    ? `${id} ${draft.harness ?? ""} ${draft.model.trim()} ${draft.purpose.trim()}`.trim()
    : [
      id,
      `--model ${draft.model.trim()}`,
      `--purpose ${draft.purpose.trim()}`,
      ...(draft.label.trim() === "" ? [] : [`--label ${draft.label.trim()}`])
    ].join(" ")
  const listId = `agent-form-models-${card.id}`
  return (
    <div className="agent-form" data-mode={mode} data-phase={phase}>
      <label className="agent-form-row">
        <span>Name</span>
        <input
          key={`label:${draft.label}`}
          className="flow-run-steer-input"
          aria-label="Name"
          data-testid="agent-form-label"
          defaultValue={draft.label}
          disabled={phase !== "editing"}
          onBlur={(event) => {
            if (event.currentTarget.value !== draft.label) commit("label", event.currentTarget.value)
          }}
          onKeyDown={blurOnEnter}
        />
      </label>
      <label className="agent-form-row">
        <span>Purpose</span>
        <input
          key={`purpose:${draft.purpose}`}
          className="flow-run-steer-input"
          aria-label="Purpose"
          data-testid="agent-form-purpose"
          defaultValue={draft.purpose}
          disabled={phase !== "editing"}
          onBlur={(event) => {
            if (event.currentTarget.value !== draft.purpose) commit("purpose", event.currentTarget.value)
          }}
          onKeyDown={blurOnEnter}
        />
      </label>
      <div className="agent-form-row">
        <span>Harness</span>
        <div className="agent-form-harnesses" role="radiogroup" aria-label="Harness">
          {harnesses.map((harness) => {
            const credentialed = harness.status === "signed-in" || harness.status === "api-key"
            return (
              <button
                key={harness.id}
                type="button"
                role="radio"
                aria-checked={draft.harness === harness.id}
                className="agent-form-harness"
                data-flow="agent.form"
                data-testid={`agent-form-harness-${harness.id}`}
                title={`${harness.status}${harness.account === "" ? "" : ` · ${harness.account}`}`}
                disabled={mode === "edit" || phase !== "editing"}
                onClick={() => draft.harness === harness.id ? undefined : onRunCommand("agent.form", `harness ${harness.id}`)}
              >
                {harness.displayName} {credentialed ? "●" : "○"}
              </button>
            )
          })}
        </div>
      </div>
      <label className="agent-form-row">
        <span>Model</span>
        <input
          key={`model:${draft.model}`}
          className="flow-run-steer-input"
          aria-label="Model"
          data-testid="agent-form-model"
          list={listId}
          defaultValue={draft.model}
          disabled={phase !== "editing" || draft.harness === undefined}
          onBlur={(event) => {
            if (event.currentTarget.value !== draft.model) commit("model", event.currentTarget.value)
          }}
          onKeyDown={blurOnEnter}
        />
        <datalist id={listId}>
          {models.map((model) => <option key={model} value={model} />)}
        </datalist>
      </label>
      {modelsReason !== undefined ? <p className="smithers-card-note">{modelsReason}</p> : null}
      <div className="flow-run-actions">
        <Button variant="ghost" size="sm" data-flow="agent.form" data-testid="agent-form-cancel" disabled={phase !== "editing"} onClick={() => onRunCommand("agent.form", "cancel")}>
          Cancel
        </Button>
        <Button
          size="sm"
          data-flow={submitFlow}
          data-testid="agent-form-submit"
          disabled={!submittable}
          onClick={() => submittable ? onRunCommand(submitFlow, submitArgs) : undefined}
        >
          {phase === "saving" ? "Saving…" : mode === "create" ? "Create agent" : "Save"}
        </Button>
      </div>
      {phase === "failed" && error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {error}
          </p>
        ) :
        null}
    </div>
  )
}

export const AgentModelsCardBody = ({ card }: { readonly card: AgentModelsCard }) => {
  const { displayName, models, reason } = card.payload
  return (
    <div className="agent-models">
      {models.length === 0 ?
        <p className="smithers-card-note">{reason ?? `${displayName} listed no models.`}</p> :
        (
          <ul className="workflow-list" data-testid="agent-models-list">
            {models.map((model) => (
              <li key={model} className="workflow-list-row">
                <span className="workflow-list-text">
                  <strong>{model}</strong>
                </span>
              </li>
            ))}
          </ul>
        )}
      {models.length > 0 && reason !== undefined ? <p className="smithers-card-note">{reason}</p> : null}
    </div>
  )
}
