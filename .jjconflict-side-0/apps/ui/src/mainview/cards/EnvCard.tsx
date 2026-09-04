/*
 * The agent-environment card: vars, the setup script, and secret NAMES only —
 * secret values are write-only upstream and never render. Mutation goes
 * through the typed /env.set command, not in-card buttons.
 */
import { Badge } from "@smthrs/ui"
import { KeyRound, Terminal } from "lucide-react"
import type { Card } from "../state/AppState"

export const EnvCardBody = ({
  card
}: {
  readonly card: Extract<Card, { kind: "env" }>
}) => (
  <div className="world-card-list">
    <p className="world-card-path">{card.payload.repo}</p>
    {card.payload.vars.length === 0 ?
      <p className="world-card-empty">No environment variables yet — /env.set NAME=value adds one.</p> :
      (
        <ul className="world-card-list">
          {card.payload.vars.map((entry) => (
            <li key={entry.name} className="world-card-row">
              <span className="world-card-title">{entry.name}</span>
              <span className="world-card-path">{entry.value}</span>
            </li>
          ))}
        </ul>
      )}
    {card.payload.setupScript !== null ?
      (
        <div className="connect-store-row">
          <span className="connect-store-icon">
            <Terminal size={16} aria-hidden="true" />
          </span>
          <span className="connect-store-text">
            <strong>Setup script</strong>
          </span>
        </div>
      ) :
      null}
    {card.payload.setupScript !== null ? <pre className="world-card-path">{card.payload.setupScript}</pre> : null}
    {card.payload.secretNames.length > 0 ?
      (
        <ul className="connect-store-list">
          {card.payload.secretNames.map((name) => (
            <li key={name} className="connect-store-row">
              <span className="connect-store-icon">
                <KeyRound size={16} aria-hidden="true" />
              </span>
              <span className="world-card-title">{name}</span>
              <Badge variant="outline">secret — write-only</Badge>
            </li>
          ))}
        </ul>
      ) :
      null}
  </div>
)
