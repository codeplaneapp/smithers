import type { RunEvent } from "@mr-burns/shared"

import { db } from "@/db/client"

type RunEventRow = {
  workspace_id: string
  run_id: string
  seq: number
  type: string
  timestamp: string
  node_id: string | null
  message: string | null
}

function mapRunEventRow(row: RunEventRow): RunEvent {
  return {
    seq: row.seq,
    runId: row.run_id,
    type: row.type,
    timestamp: row.timestamp,
    nodeId: row.node_id ?? undefined,
    message: row.message ?? undefined,
  }
}

export function listRunEventRows(workspaceId: string, runId: string, afterSeq = 0) {
  const rows = db
    .query<RunEventRow, [string, string, number]>(
      `
        SELECT
          workspace_id,
          run_id,
          seq,
          type,
          timestamp,
          node_id,
          message
        FROM run_events
        WHERE workspace_id = ?1
          AND run_id = ?2
          AND seq > ?3
        ORDER BY seq ASC
      `
    )
    .all(workspaceId, runId, afterSeq)

  return rows.map(mapRunEventRow)
}

export function getMaxRunEventSeq(workspaceId: string, runId: string) {
  const row = db
    .query<{ max_seq: number | null }, [string, string]>(
      `
        SELECT MAX(seq) AS max_seq
        FROM run_events
        WHERE workspace_id = ?1
          AND run_id = ?2
      `
    )
    .get(workspaceId, runId)

  return row?.max_seq ?? 0
}

export function insertRunEventRow(
  workspaceId: string,
  event: RunEvent & { runId: string }
) {
  db
    .query(
      `
        INSERT OR IGNORE INTO run_events (
          workspace_id,
          run_id,
          seq,
          type,
          timestamp,
          node_id,
          message
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `
    )
    .run(
      workspaceId,
      event.runId,
      event.seq,
      event.type,
      event.timestamp,
      event.nodeId ?? null,
      event.message ?? null
    )
}
