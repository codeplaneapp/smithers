/*
 * The dispatchers card (triggers.list): the events a repository's runs wait
 * for, one row each, in words. A trigger row states the schedule, the flow
 * it runs, and its state: enabled or disabled, and when it last fired if the
 * store recorded it. A webhook row states the channel and the flow it starts
 * when the declaration fixed one; a registered channel carries no enabled or
 * last-fired state, so none is printed. Empty lists carry the seam's own
 * reason when it has one, and never a made-up row. Read-only: a dispatcher
 * is registered from the CLI today, so the card offers no act.
 */
import type { Card } from "../state/AppState"
import { timeLabel as clockLabel } from "../Timestamps"
import { describeSchedule } from "./TriggerEvents"
import type { CardFamily } from "./CardFamily"
import { settledPill } from "./CardFamily"

export const TriggerListCardBody = ({
  card
}: {
  readonly card: Extract<Card, { kind: "trigger-list" }>
}) => {
  const { triggers, reason } = card.payload
  const webhooks = card.payload.webhooks ?? []
  if (triggers.length === 0 && webhooks.length === 0) {
    return (
      <p className="smithers-card-note" data-testid="trigger-list-empty">
        {reason ?? "No triggers or webhooks on this repository yet."}
      </p>
    )
  }
  return (
    <ul className="workflow-list" data-testid="trigger-list">
      {triggers.map((trigger) => (
        <li key={trigger.id} className="workflow-list-row" data-trigger={trigger.id} data-enabled={trigger.enabled}>
          <span className="workflow-list-text">
            <strong>{describeSchedule(trigger.cron, trigger.timezone)}</strong>
            <span>runs {trigger.flowId}</span>
            <span data-testid={`trigger-state-${trigger.id}`}>
              {trigger.enabled ? "enabled" : "disabled"}
              {" · "}
              {trigger.lastFiredAt === undefined ? "never fired" : `last fired ${clockLabel(trigger.lastFiredAt)}`}
            </span>
          </span>
        </li>
      ))}
      {webhooks.map((webhook) => (
        <li key={`webhook:${webhook.name}`} className="workflow-list-row" data-webhook={webhook.name}>
          <span className="workflow-list-text">
            <strong>Webhook {webhook.name}</strong>
            {webhook.flowId === undefined ? null : <span>runs {webhook.flowId}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

export const triggersCardFamily: CardFamily<"trigger-list"> = {
  "trigger-list": { render: (card) => <TriggerListCardBody card={card} />, pill: settledPill }
}
