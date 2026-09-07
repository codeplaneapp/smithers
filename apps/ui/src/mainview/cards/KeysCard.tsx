/*
 * The BYOK keys card: providers with masked previews only (the secret law —
 * key material never rides in a payload), and one removal act per row bound
 * to keys.remove through onRunCommand, the delegated registry dispatch. The
 * footer names the other secret store, a repository's agent environment, by
 * its flows; the Secrets button in the chrome opens this card.
 */
import { Button } from "@smthrs/ui"
import { KeyRound } from "lucide-react"
import type { Card } from "../state/AppState"
import type { CardFamily } from "./CardFamily"
import { settledPill } from "./CardFamily"

export const KeysCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "keys" }>
  readonly onRunCommand: (name: string, args?: string) => void
}) => (
  <div className="world-card-list">
    <ul className="world-card-list">
      {card.payload.keys.length === 0 ? <li className="world-card-empty">No provider keys yet.</li> : (
        card.payload.keys.map((key) => (
          <li key={key.provider} className="connect-store-row">
            <span className="connect-store-icon">
              <KeyRound size={16} aria-hidden="true" />
            </span>
            <span className="connect-store-text">
              <strong>{key.provider}</strong>
              <span>{key.masked}</span>
            </span>
            <Button
              size="sm"
              variant="outline"
              data-flow="keys.remove"
              aria-label={`Remove the ${key.provider} key`}
              onClick={() => onRunCommand("keys.remove", key.provider)}
            >
              Remove
            </Button>
          </li>
        ))
      )}
    </ul>
    <p className="world-card-path" data-testid="keys-env-hint">
      Repository secrets and variables live in the agent environment: /env.view shows them, /env.set NAME=value adds one.
    </p>
  </div>
)

export const keysCardFamily: CardFamily<"keys"> = {
  keys: {
    render: (card, actions) => <KeysCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
