import { existsSync } from "node:fs"
import path from "node:path"

import type { RunEvent } from "@mr-burns/shared"
import { Database } from "bun:sqlite"

import {
  getMaxRunEventSeq,
  insertRunEventRow,
  listRunEventRows,
} from "@/db/repositories/run-event-repository"
import { getWorkspace } from "@/services/workspace-service"

type SmithersEventRow = {
  seq: number
  payload_json: string
}

type SmithersEventCandidate = {
  seq: number
  type?: string
  nodeId?: string
  timestamp?: string
  rawPayload: unknown
}

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

function parseRawPayloadJson(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson)
  } catch {
    return undefined
  }
}

function toTimestampIso(value: unknown): string | undefined {
  const timestamp = asString(value)
  if (timestamp) {
    return timestamp
  }

  const timestampMs = asNumber(value)
  if (timestampMs === undefined) {
    return undefined
  }

  return new Date(Math.floor(timestampMs)).toISOString()
}

function eventSignature(type: string, nodeId?: string) {
  return `${type}::${nodeId ?? ""}`
}

function exactEventSignature(type: string, nodeId: string | undefined, timestamp: string) {
  return `${type}::${nodeId ?? ""}::${timestamp}`
}

function readSmithersEventCandidates(
  workspaceId: string,
  runId: string,
  afterSeq: number
) {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) {
    return [] as SmithersEventCandidate[]
  }

  const smithersDbPath = path.join(workspace.path, ".mr-burns", "state", "smithers.sqlite")
  if (!existsSync(smithersDbPath)) {
    return [] as SmithersEventCandidate[]
  }

  const smithersDb = new Database(smithersDbPath, { readonly: true })

  try {
    const rows = smithersDb
      .query<SmithersEventRow, [string, number]>(
        `
          SELECT
            seq,
            payload_json
          FROM _smithers_events
          WHERE run_id = ?1
            AND seq > ?2
          ORDER BY seq ASC
        `
      )
      .all(runId, afterSeq)

    const candidates: SmithersEventCandidate[] = []
    for (const row of rows) {
      const parsedPayload = parseRawPayloadJson(row.payload_json)
      if (parsedPayload !== undefined) {
        const payloadObject = asObject(parsedPayload)
        const candidate: SmithersEventCandidate = {
          seq: row.seq,
          type: asString(payloadObject?.type),
          nodeId:
            asString(payloadObject?.nodeId) ??
            asString(asObject(payloadObject?.node)?.id),
          timestamp:
            toTimestampIso(payloadObject?.timestamp) ??
            toTimestampIso(payloadObject?.timestampMs),
          rawPayload: parsedPayload,
        }
        candidates.push(candidate)
      }
    }

    return candidates
  } catch {
    return [] as SmithersEventCandidate[]
  } finally {
    smithersDb.close()
  }
}

function hydrateMissingRawPayloads(
  events: RunEvent[],
  candidates: SmithersEventCandidate[]
) {
  const hydratedPayloadBySeq = new Map<number, unknown>()
  const usedCandidateSeq = new Set<number>()
  const exactCandidatesBySignature = new Map<string, SmithersEventCandidate[]>()

  for (const candidate of candidates) {
    if (!candidate.type || !candidate.timestamp) {
      continue
    }

    const signature = exactEventSignature(
      candidate.type,
      candidate.nodeId,
      candidate.timestamp
    )
    const existing = exactCandidatesBySignature.get(signature) ?? []
    existing.push(candidate)
    exactCandidatesBySignature.set(signature, existing)
  }

  for (const event of events) {
    if (event.rawPayload !== undefined || !event.timestamp) {
      continue
    }

    const signature = exactEventSignature(event.type, event.nodeId, event.timestamp)
    const candidatesForEvent = exactCandidatesBySignature.get(signature)
    if (!candidatesForEvent || candidatesForEvent.length === 0) {
      continue
    }

    const candidate = candidatesForEvent.shift()!
    hydratedPayloadBySeq.set(event.seq, candidate.rawPayload)
    usedCandidateSeq.add(candidate.seq)
  }

  const fallbackCandidatesBySignature = new Map<string, SmithersEventCandidate[]>()
  for (const candidate of candidates) {
    if (usedCandidateSeq.has(candidate.seq) || !candidate.type) {
      continue
    }

    const signature = eventSignature(candidate.type, candidate.nodeId)
    const existing = fallbackCandidatesBySignature.get(signature) ?? []
    existing.push(candidate)
    fallbackCandidatesBySignature.set(signature, existing)
  }

  for (const event of events) {
    if (event.rawPayload !== undefined || hydratedPayloadBySeq.has(event.seq)) {
      continue
    }

    const signature = eventSignature(event.type, event.nodeId)
    const candidatesForEvent = fallbackCandidatesBySignature.get(signature)
    if (!candidatesForEvent || candidatesForEvent.length === 0) {
      continue
    }

    const candidate = candidatesForEvent.shift()!
    hydratedPayloadBySeq.set(event.seq, candidate.rawPayload)
  }

  if (hydratedPayloadBySeq.size === 0) {
    return events
  }

  return events.map((event) => {
    if (event.rawPayload !== undefined) {
      return event
    }

    const hydratedPayload = hydratedPayloadBySeq.get(event.seq)
    if (hydratedPayload === undefined) {
      return event
    }

    return {
      ...event,
      rawPayload: hydratedPayload,
    }
  })
}

export function listRunEvents(workspaceId: string, runId: string, afterSeq = 0) {
  const events = listRunEventRows(workspaceId, runId, afterSeq)
  const hasMissingRawPayload = events.some((event) => event.rawPayload === undefined)
  if (!hasMissingRawPayload) {
    return events
  }

  const candidates = readSmithersEventCandidates(workspaceId, runId, afterSeq)
  if (candidates.length === 0) {
    return events
  }

  return hydrateMissingRawPayloads(events, candidates)
}

export function getLatestRunEventSeq(workspaceId: string, runId: string) {
  return getMaxRunEventSeq(workspaceId, runId)
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
    rawPayload:
      event.rawPayload ?? {
        runId,
        type: event.type,
        timestamp: event.timestamp,
        nodeId: event.nodeId,
        message: event.message,
      },
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
    rawPayload: payload,
  }

  insertRunEventRow(workspaceId, normalized)
  return normalized
}
