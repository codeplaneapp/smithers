/*
 * The live dispatchers of a repository: GET /api/workflow/triggers?repo=owner/repo.
 *
 * The declared rules (the `on` table of `.smithers/factory.json`) are not this
 * route's business: the app reads them from the public mirror through the
 * contents route, signed in or not. This route answers the OTHER source, the
 * box: the durable registrations in the workspace's trigger store
 * (`@smthrs/triggers` TriggerStore, read through `Control.list
 * { _tag: "triggers" }` over the gateway relay) and the webhook channels the
 * control plane's `Channels` coordinator holds.
 *
 * `live` is the one fact the client needs beside the rows: true only when a
 * signed-in session's box answered the listing on this call. Signed out, no
 * identity seam, no box provisioned, a box that cannot be reached, or a box
 * whose host serves no trigger store all answer the same honest 200 with
 * `live: false` and empty lists. The route never states a reason as if it
 * were a row, and never provisions a box to answer a read.
 *
 * Webhooks: `Channels` exposes register, lookup, ingest and project with no
 * list, so the webhook list is empty until a `Channels.list` export exists;
 * `live: true` therefore speaks for the trigger store alone.
 */
import type { GatewayRpcFrame } from "./gatewayRpc"

/** One trigger row as the client renders it. */
export interface WorkflowTrigger {
  readonly id: string
  readonly flowId: string
  readonly cron: string
  readonly timezone?: string
  readonly enabled: boolean
  readonly lastFiredAt?: number
  readonly nextFireAt?: number
  readonly activeRunId?: string
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

/** The route's answer: the box's live rows when a box answered, and whether one did. */
export interface WorkflowTriggersBody {
  readonly status: "ok"
  readonly repo: string
  readonly live: boolean
  readonly triggers: ReadonlyArray<WorkflowTrigger>
  readonly webhooks: ReadonlyArray<WorkflowWebhook>
}

/** The answer when no box answered: signed out, no box, or a box without a trigger store. */
export const noLiveTriggers = (repo: string): WorkflowTriggersBody => ({
  status: "ok",
  repo,
  live: false,
  triggers: [],
  webhooks: []
})

/** The `List { _tag: "triggers" }` request the relay carries to the box. */
export const LIST_TRIGGERS_PAYLOAD = { _tag: "triggers" } as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * One `TriggerSummary` (`@smthrs/control` ControlSchema) as a client row.
 * Only well-formed items become rows; the first upcoming occurrence is the
 * next fire.
 */
const triggerRow = (item: unknown): WorkflowTrigger | undefined => {
  if (!isRecord(item)) return undefined
  if (typeof item.triggerId !== "string" || typeof item.flowId !== "string" || typeof item.cron !== "string") return undefined
  const next = Array.isArray(item.nextOccurrencesMs) ? item.nextOccurrencesMs[0] : undefined
  return {
    id: item.triggerId,
    flowId: item.flowId,
    cron: item.cron,
    ...(typeof item.timezone === "string" ? { timezone: item.timezone } : {}),
    enabled: item.enabled === true,
    ...(typeof item.lastFiredAtMs === "number" ? { lastFiredAt: item.lastFiredAtMs } : {}),
    ...(typeof next === "number" ? { nextFireAt: next } : {}),
    ...(typeof item.activeRunId === "string" ? { activeRunId: item.activeRunId } : {})
  }
}

/**
 * The route body for a box's answer to `List { _tag: "triggers" }`. A refusal
 * (a host without a trigger store answers `this host serves no trigger
 * store`) or a malformed page is "no box answered", never an empty live list.
 */
export const workflowTriggersFromFrame = (repo: string, frame: GatewayRpcFrame): WorkflowTriggersBody => {
  if (!frame.ok) return noLiveTriggers(repo)
  const page = frame.payload
  if (!isRecord(page) || page._tag !== "triggers" || !Array.isArray(page.items)) return noLiveTriggers(repo)
  const triggers = page.items.map(triggerRow).filter((row): row is WorkflowTrigger => row !== undefined)
  return { status: "ok", repo, live: true, triggers, webhooks: [] }
}
