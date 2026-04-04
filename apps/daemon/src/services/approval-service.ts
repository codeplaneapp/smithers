import { randomUUID } from "node:crypto"

import type { Approval, ApprovalDecisionInput, ApprovalInboxItem } from "@burns/shared"

import {
  findApprovalRow,
  listApprovalRowsByWorkspace,
  listPendingApprovalInboxRows,
  upsertApprovalRow,
} from "@/db/repositories/approval-repository"
import { approveSmithersNode, denySmithersNode } from "@/integrations/smithers/http-client"
import { appendRunEvent } from "@/services/run-event-service"
import { listRuns, resumeRun as resumeSmithersWorkflowRun } from "@/services/smithers-service"
import { ensureWorkspaceSmithersBaseUrl } from "@/services/smithers-instance-service"
import { getWorkspace } from "@/services/workspace-service"
import { HttpError } from "@/utils/http-error"

function assertWorkspaceExists(workspaceId: string) {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) {
    throw new HttpError(404, `Workspace not found: ${workspaceId}`)
  }

  return workspace
}

function ensurePendingApproval(params: {
  workspaceId: string
  runId: string
  nodeId: string
  label?: string
  note?: string
}) {
  const existing = findApprovalRow(params.workspaceId, params.runId, params.nodeId)
  if (existing) {
    return existing
  }

  return upsertApprovalRow({
    id: `approval-${randomUUID()}`,
    workspaceId: params.workspaceId,
    runId: params.runId,
    nodeId: params.nodeId,
    label: params.label ?? params.nodeId,
    status: "pending",
    waitMinutes: 0,
    note: params.note,
  })!
}

export function listApprovals(workspaceId: string) {
  assertWorkspaceExists(workspaceId)
  return listApprovalRowsByWorkspace(workspaceId)
}

function parseIsoToMs(value: string) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

async function resolveRunContextByWorkspace(workspaceIds: string[]) {
  const entries = await Promise.all(
    workspaceIds.map(async (workspaceId) => {
      try {
        const runs = await listRuns(workspaceId)
        return [
          workspaceId,
          new Map(
            runs.map((run) => [
              run.id,
              {
                workflowName: run.workflowName,
                runStatus: run.status,
              },
            ])
          ),
        ] as const
      } catch {
        return [workspaceId, new Map()] as const
      }
    })
  )

  return new Map(entries)
}

export async function listPendingApprovalInbox() {
  const rows = listPendingApprovalInboxRows()
  if (rows.length === 0) {
    return [] as ApprovalInboxItem[]
  }

  const workspaceIds = [...new Set(rows.map((row) => row.workspaceId))]
  const runContextByWorkspace = await resolveRunContextByWorkspace(workspaceIds)
  const now = Date.now()

  const approvals = rows
    .map<ApprovalInboxItem>((row) => {
      const runContext = runContextByWorkspace.get(row.workspaceId)?.get(row.runId)
      const requestedAtMs = parseIsoToMs(row.requestedAt) ?? now
      const waitingMs = Math.max(0, now - requestedAtMs)
      const nodeLabel = row.label?.trim() ? row.label : row.nodeId

      return {
        id: row.id,
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
        runId: row.runId,
        nodeId: row.nodeId,
        iteration: 0,
        workflowName: runContext?.workflowName ?? "Run not found",
        runStatus: runContext?.runStatus ?? null,
        runFound: Boolean(runContext),
        nodeLabel,
        requestTitle: nodeLabel,
        requestSummary: row.note ?? null,
        requestedAt: row.requestedAt,
        requestedAtMs,
        waitingMs,
        waitingMinutes: Math.floor(waitingMs / 60_000),
        note: row.note,
      }
    })
    .sort((left, right) => right.waitingMs - left.waitingMs)

  return approvals
}

export function upsertPendingApproval(params: {
  workspaceId: string
  runId: string
  nodeId: string
  label?: string
  note?: string
}) {
  assertWorkspaceExists(params.workspaceId)
  return ensurePendingApproval(params)
}

export function syncApprovalFromEvent(params: {
  workspaceId: string
  runId: string
  nodeId: string
  status: "pending" | "approved" | "denied"
  message?: string
}) {
  assertWorkspaceExists(params.workspaceId)

  const existing = ensurePendingApproval({
    workspaceId: params.workspaceId,
    runId: params.runId,
    nodeId: params.nodeId,
    label: params.nodeId,
    note: params.message,
  })

  if (params.status === "pending") {
    return existing
  }

  return upsertApprovalRow({
    ...existing,
    status: params.status,
    note: params.message ?? existing.note,
    decidedAt: new Date().toISOString(),
  })!
}

export async function decideApproval(params: {
  workspaceId: string
  runId: string
  nodeId: string
  decision: "approved" | "denied"
  input: ApprovalDecisionInput
}) {
  const workspace = assertWorkspaceExists(params.workspaceId)
  const baseUrl = await ensureWorkspaceSmithersBaseUrl(workspace)
  const existingApproval = findApprovalRow(params.workspaceId, params.runId, params.nodeId)
  if (existingApproval && existingApproval.status !== "pending") {
    throw new HttpError(409, "Approval already resolved")
  }

  const pendingApproval = existingApproval ?? ensurePendingApproval({
    workspaceId: params.workspaceId,
    runId: params.runId,
    nodeId: params.nodeId,
  })

  const payload = {
    note: params.input.note,
    decidedBy: params.input.decidedBy,
  }

  try {
    if (params.decision === "approved") {
      await approveSmithersNode(baseUrl, params.runId, params.nodeId, payload)
    } else {
      await denySmithersNode(baseUrl, params.runId, params.nodeId, payload)
    }
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      throw new HttpError(409, "Approval already resolved")
    }
    throw error
  }

  const decidedAt = new Date().toISOString()
  const updatedApproval = upsertApprovalRow({
    id: pendingApproval.id,
    workspaceId: params.workspaceId,
    runId: params.runId,
    nodeId: params.nodeId,
    label: pendingApproval.label,
    status: params.decision === "approved" ? "approved" : "denied",
    waitMinutes: 0,
    note: params.input.note ?? pendingApproval.note,
    decidedBy: params.input.decidedBy,
    decidedAt,
  })

  if (!updatedApproval) {
    throw new HttpError(500, "Failed to persist approval decision")
  }

  appendRunEvent(params.workspaceId, params.runId, {
    type: params.decision === "approved" ? "approval.approved" : "approval.denied",
    timestamp: decidedAt,
    nodeId: params.nodeId,
    message:
      params.input.note ??
      `${params.input.decidedBy} ${params.decision === "approved" ? "approved" : "denied"} node ${params.nodeId}`,
  })

  if (params.decision === "approved") {
    await resumeSmithersWorkflowRun(params.workspaceId, params.runId, {})
  }

  return updatedApproval
}
