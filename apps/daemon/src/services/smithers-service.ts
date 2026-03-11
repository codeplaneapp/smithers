import path from "node:path"

import type { CancelRunInput, ResumeRunInput, Run, StartRunInput } from "@mr-burns/shared"

import {
  cancelSmithersRun,
  createSmithersRun,
  getSmithersRun,
  listSmithersRuns,
  resumeSmithersRun,
  streamSmithersRunEvents,
} from "@/integrations/smithers/http-client"
import { ensureWorkspaceSmithersBaseUrl } from "@/services/smithers-instance-service"
import { getWorkspace } from "@/services/workspace-service"
import { HttpError } from "@/utils/http-error"

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

function normalizeStatus(value: unknown): Run["status"] {
  const status = asString(value)?.toLowerCase().trim()

  if (!status) {
    return "running"
  }

  if (
    status === "waiting-approval" ||
    status === "waiting_approval" ||
    status === "needs-approval" ||
    status === "pending-approval"
  ) {
    return "waiting-approval"
  }

  if (status === "finished" || status === "completed" || status === "success") {
    return "finished"
  }

  if (status === "failed" || status === "error") {
    return "failed"
  }

  if (status === "cancelled" || status === "canceled") {
    return "cancelled"
  }

  return "running"
}

function mapSummary(value: unknown): Run["summary"] {
  const source = asObject(value)
  return {
    finished:
      asNumber(source?.finished) ??
      asNumber(source?.done) ??
      asNumber(source?.completed) ??
      0,
    inProgress:
      asNumber(source?.inProgress) ??
      asNumber(source?.running) ??
      asNumber(source?.active) ??
      0,
    pending:
      asNumber(source?.pending) ??
      asNumber(source?.queued) ??
      asNumber(source?.waiting) ??
      0,
  }
}

function mapSmithersRun(workspaceId: string, payload: unknown): Run {
  const run = asObject(payload)
  const workflow = asObject(run?.workflow)
  const workflowRef = asObject(run?.workflowRef)

  const workflowId =
    asString(run?.workflowId) ??
    asString(workflow?.id) ??
    asString(workflowRef?.id) ??
    asString(workflow?.name) ??
    "unknown-workflow"

  const workflowName =
    asString(run?.workflowName) ??
    asString(workflow?.name) ??
    workflowId

  const startedAt =
    asString(run?.startedAt) ??
    asString(run?.createdAt) ??
    new Date().toISOString()

  return {
    id: asString(run?.runId) ?? asString(run?.id) ?? "unknown-run",
    workspaceId,
    workflowId,
    workflowName,
    status: normalizeStatus(run?.status),
    startedAt,
    finishedAt: asString(run?.finishedAt) ?? null,
    summary: mapSummary(run?.summary),
  }
}

function unwrapRuns(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload
  }

  const objectPayload = asObject(payload)
  if (Array.isArray(objectPayload?.runs)) {
    return objectPayload.runs
  }

  return []
}

function unwrapRun(payload: unknown) {
  const objectPayload = asObject(payload)

  return asObject(objectPayload?.run) ?? objectPayload ?? payload
}

function assertWorkspace(workspaceId: string) {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) {
    throw new HttpError(404, `Workspace not found: ${workspaceId}`)
  }

  return workspace
}

function resolveWorkflowPath(workspacePath: string, workflowId: string) {
  return path.join(workspacePath, ".mr-burns", "workflows", workflowId, "workflow.tsx")
}

export async function listRuns(workspaceId: string) {
  const workspace = assertWorkspace(workspaceId)
  const baseUrl = await ensureWorkspaceSmithersBaseUrl(workspace)
  const payload = await listSmithersRuns(baseUrl)
  return unwrapRuns(payload).map((run) => mapSmithersRun(workspaceId, run))
}

export async function getRun(workspaceId: string, runId: string) {
  const workspace = assertWorkspace(workspaceId)
  const baseUrl = await ensureWorkspaceSmithersBaseUrl(workspace)
  const payload = await getSmithersRun(baseUrl, runId)
  return mapSmithersRun(workspaceId, unwrapRun(payload))
}

export async function startRun(workspaceId: string, input: StartRunInput) {
  const workspace = assertWorkspace(workspaceId)
  const baseUrl = await ensureWorkspaceSmithersBaseUrl(workspace)
  const workflowPath = resolveWorkflowPath(workspace.path, input.workflowId)

  const payload = await createSmithersRun(baseUrl, {
    workflowPath,
    input: input.input ?? {},
    metadata: {
      workspaceId,
      workflowId: input.workflowId,
    },
  })

  return mapSmithersRun(workspaceId, unwrapRun(payload))
}

export async function resumeRun(workspaceId: string, runId: string, input: ResumeRunInput) {
  const workspace = assertWorkspace(workspaceId)
  const baseUrl = await ensureWorkspaceSmithersBaseUrl(workspace)
  const payload = await resumeSmithersRun(baseUrl, runId, {
    input: input.input ?? {},
  })

  return mapSmithersRun(workspaceId, unwrapRun(payload))
}

export async function cancelRun(workspaceId: string, runId: string, input: CancelRunInput) {
  const workspace = assertWorkspace(workspaceId)
  const baseUrl = await ensureWorkspaceSmithersBaseUrl(workspace)
  const payload = await cancelSmithersRun(baseUrl, runId, {
    reason: input.reason,
  })

  return mapSmithersRun(workspaceId, unwrapRun(payload))
}

export async function connectRunEventStream(workspaceId: string, runId: string, afterSeq?: number) {
  const workspace = assertWorkspace(workspaceId)
  const baseUrl = await ensureWorkspaceSmithersBaseUrl(workspace)
  return await streamSmithersRunEvents(baseUrl, runId, afterSeq)
}
