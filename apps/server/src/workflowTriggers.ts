/*
 * The dispatchers a repository's runs wait on: GET /api/workflow/triggers?repo=owner/repo.
 *
 * Two kinds of dispatcher wait on a workspace. A trigger is a durable
 * registration in the workspace's trigger store (`@smthrs/triggers`
 * TriggerStore: id, flowId, cron, timezone, enabled, lastFiredAt). A
 * webhook is a channel registered with the control plane's `Channels`
 * coordinator (`Webhook.make` registers a channel by name; its inbound map
 * names the flow each verified payload starts).
 *
 * The per-user gateway relays no procedure that reads either registry:
 * `Control.list` knows `flows` and `runs` only, no projection carries
 * trigger rows, and `Channels` exposes register, lookup, ingest, and project
 * with no list. Until a `List { _tag: "triggers" }` request (or a `triggers`
 * projection) ships for the store, and a `Channels.list` (or a
 * `List { _tag: "channels" }` request) ships for the registered webhooks,
 * this route answers the one honest thing it can: empty lists and the
 * reason they are empty. The client renders the reason; it never invents rows.
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

/**
 * One registered webhook as the client renders it: the channel name, and the
 * flow it starts when the declaration fixes one (a channel's inbound map may
 * choose the flow per payload, so the flow is optional).
 */
export interface WorkflowWebhook {
  readonly name: string
  readonly flowId?: string
}

/** The route's answer: the repository's triggers and webhooks, or why there are none to show. */
export interface WorkflowTriggersBody {
  readonly status: "ok"
  readonly repo: string
  readonly triggers: ReadonlyArray<WorkflowTrigger>
  readonly webhooks: ReadonlyArray<WorkflowWebhook>
  readonly reason?: string
}

/** Why the lists are empty on this deployment: a statement about the gateway, not about the repository. */
export const TRIGGERS_UNAVAILABLE_REASON =
  "Your Smithers Cloud workspace does not serve its trigger store or its webhook registry yet, so there are no triggers or webhooks to list here. The gateway needs a List { _tag: \"triggers\" } request for scheduled triggers and a Channels.list export for registered webhooks. Triggers and webhooks registered with the smthrs CLI keep firing under smthrs serve; smthrs triggers list shows the triggers."

/** The trigger and webhook lists for one repository. */
export const workflowTriggers = (repo: string): WorkflowTriggersBody => ({
  status: "ok",
  repo,
  triggers: [],
  webhooks: [],
  reason: TRIGGERS_UNAVAILABLE_REASON
})
