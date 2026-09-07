/*
 * The triggers seam: GET /api/workflow/triggers?repo=owner/repo, the
 * dispatchers waiting on one repository. The answer is the route's own
 * contract (apps/server workflowTriggers.ts): `{ status: "ok", repo,
 * triggers, reason? }`. Only well-formed rows are kept; `reason` is why the
 * list is empty and rides to the card unchanged.
 */
import { WORKFLOW_TRIGGERS_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { Card } from "../AppState"
import { readErrorMessage } from "./SeamContext"

export type TriggerRow = Extract<Card, { kind: "trigger-list" }>["payload"]["triggers"][number]

export interface TriggerList {
  readonly triggers: ReadonlyArray<TriggerRow>
  readonly reason?: string
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const triggerRow = (value: unknown): TriggerRow | undefined => {
  const row = asRecord(value)
  if (typeof row.id !== "string" || typeof row.flowId !== "string" || typeof row.cron !== "string") return undefined
  return {
    id: row.id,
    flowId: row.flowId,
    cron: row.cron,
    ...(typeof row.timezone === "string" ? { timezone: row.timezone } : {}),
    enabled: row.enabled === true,
    ...(typeof row.lastFiredAt === "number" ? { lastFiredAt: row.lastFiredAt } : {})
  }
}

/** The repository's triggers, or the honest sentence for why they could not be read. */
export const readTriggers = async (
  http: (url: string, init?: RequestInit) => Promise<Response>,
  baseUrl: string,
  repo: string
): Promise<TriggerList | string> => {
  let response: Response
  try {
    response = await http(`${baseUrl}${WORKFLOW_TRIGGERS_PATH}?repo=${encodeURIComponent(repo)}`)
  } catch {
    return "The triggers couldn't be listed: the workflow service didn't answer."
  }
  if (!response.ok) return readErrorMessage(response, "The triggers couldn't be listed right now.")
  const body = asRecord(await response.json().catch(() => undefined))
  if (body.status !== "ok" || !Array.isArray(body.triggers)) return "The triggers answer was malformed."
  const triggers = body.triggers.map(triggerRow).filter((row): row is TriggerRow => row !== undefined)
  return typeof body.reason === "string" && body.reason !== "" ? { triggers, reason: body.reason } : { triggers }
}
