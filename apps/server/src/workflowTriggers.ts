/*
 * The dispatchers a repository's runs wait on: GET /api/workflow/triggers?repo=owner/repo.
 *
 * A trigger is a durable registration in the workspace's trigger store
 * (`@smthrs/triggers` TriggerStore: id, flowId, cron, timezone, enabled,
 * lastFiredAt). The per-user gateway relays no procedure that reads that
 * store: `Control.list` knows `flows` and `runs` only, and the gateway's
 * projections carry no trigger rows. Until a `List { _tag: "triggers" }`
 * request (or a `triggers` projection) ships on the gateway, this route
 * answers the one honest thing it can: an empty list and the reason it is
 * empty. The client renders the reason; it never invents rows.
 */

/** One trigger row as the client renders it. */
export interface WorkflowTrigger {
  readonly id: string
  readonly flowId: string
  readonly cron: string
  readonly timezone?: string
  readonly enabled: boolean
  readonly lastFiredAt?: number
}

/** The route's answer: the repository's triggers, or why there are none to show. */
export interface WorkflowTriggersBody {
  readonly status: "ok"
  readonly repo: string
  readonly triggers: ReadonlyArray<WorkflowTrigger>
  readonly reason?: string
}

/** Why the list is empty on this deployment: a statement about the gateway, not about the repository. */
export const TRIGGERS_UNAVAILABLE_REASON =
  "Your Smithers Cloud workspace does not serve its trigger store yet, so there are no triggers to list here. Triggers registered with the smthrs CLI keep firing under smthrs serve; smthrs triggers list shows them."

/** The trigger list for one repository. */
export const workflowTriggers = (repo: string): WorkflowTriggersBody => ({
  status: "ok",
  repo,
  triggers: [],
  reason: TRIGGERS_UNAVAILABLE_REASON
})
