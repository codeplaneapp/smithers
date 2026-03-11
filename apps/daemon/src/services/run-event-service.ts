import type { RunEvent } from "@mr-burns/shared"

import {
  getMaxRunEventSeq,
  insertRunEventRow,
  listRunEventRows,
} from "@/db/repositories/run-event-repository"

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return undefined
}

export function listRunEvents(workspaceId: string, runId: string, afterSeq = 0) {
  return listRunEventRows(workspaceId, runId, afterSeq)
}

export function appendRunEvent(
  workspaceId: string,
  runId: string,
  event: Omit<RunEvent, "runId" | "seq">
) {
  const seq = getMaxRunEventSeq(workspaceId, runId) + 1
  const normalized: RunEvent = {
    seq,
    runId,
    type: event.type,
    timestamp: event.timestamp,
    nodeId: event.nodeId,
    message: event.message,
  }

  insertRunEventRow(workspaceId, normalized)
  return normalized
}

export function persistSmithersEvent(workspaceId: string, runId: string, payload: unknown) {
  const objectPayload = asObject(payload)

  const incomingSeq =
    asNumber(objectPayload?.seq) ??
    asNumber(asObject(objectPayload?.meta)?.seq) ??
    asNumber(asObject(objectPayload?.event)?.seq)

  const seq =
    incomingSeq !== undefined
      ? incomingSeq
      : getMaxRunEventSeq(workspaceId, runId) + 1

  const eventRunId =
    asString(objectPayload?.runId) ??
    asString(asObject(objectPayload?.run)?.id) ??
    runId

  const normalized: RunEvent = {
    seq,
    runId: eventRunId,
    type: asString(objectPayload?.type) ?? "smithers.event",
    timestamp: asString(objectPayload?.timestamp) ?? new Date().toISOString(),
    nodeId:
      asString(objectPayload?.nodeId) ??
      asString(asObject(objectPayload?.node)?.id),
    message:
      asString(objectPayload?.message) ??
      asString(objectPayload?.summary),
  }

  insertRunEventRow(workspaceId, normalized)
  return normalized
}
