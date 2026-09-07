/*
 * The dispatchers card (triggers.list): the events a repository's runs wait
 * for, one row each, in words. Each row states the event, the flow it runs,
 * and its state: enabled or disabled, and when it last fired if the store
 * recorded it. An empty list carries the seam's own reason when it has one,
 * and never a made-up row. Read-only: a trigger is registered and fired
 * from the CLI today, so the card offers no act.
 */
import type { Card } from "../state/AppState"
import { timeLabel as clockLabel } from "../Timestamps"
import { describeSchedule } from "./TriggerEvents"

export const TriggerListCardBody = ({
  card
}: {
  readonly card: Extract<Card, { kind: "trigger-list" }>
}) => {
  const { triggers, reason } = card.payload
  if (triggers.length === 0) {
    return (
      <p className="smithers-card-note" data-testid="trigger-list-empty">
        {reason ?? "No triggers on this repository yet."}
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
    </ul>
  )
}
