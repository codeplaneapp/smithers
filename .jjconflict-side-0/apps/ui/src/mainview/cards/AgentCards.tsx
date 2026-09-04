import { Button } from "@smthrs/ui"
import type { Card } from "../state/AppState"

/*
 * The agents as data (docs/workbench-lanes/custom-agents.md), as cards in
 * the chat (THE EMBED LAW): the Agents card lists every built-in and custom
 * agent with its harness's live availability and the acts each row offers
 * (Launch = agent.role, Edit = agent.new <id>, Remove = agent.remove); the
 * models card is what a harness's own list command printed. The New-agent
 * form is the generic flow form (THE FORM LAW, cards/FlowFormCards.tsx)
 * derived from agent.create's schema, which agent.new renders. Every act
 * names its flow through onRunCommand.
 */

type AgentsCard = Extract<Card, { kind: "agents" }>
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
