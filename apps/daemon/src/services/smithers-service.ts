import path from "node:path"
import { existsSync } from "node:fs"

import type { CancelRunInput, ResumeRunInput, Run, StartRunInput } from "@burns/shared"

import {
  cancelSmithersRun,
  createSmithersRun,
  getSmithersRun,
  listSmithersRuns,
  resumeSmithersRun,
  streamSmithersRunEvents,
} from "@/integrations/smithers/http-client"
import { ensureWorkspaceSmithersBaseUrl } from "@/services/smithers-instance-service"
import { getWorkspaceWorkflowRootPath } from "@/services/workspace-layout"
import { repairLegacyDefaultWorkflowTemplate } from "@/services/workflow-service"
import { getWorkspace } from "@/services/workspace-service"
import { HttpError } from "@/utils/http-error"

const EPOCH_ISO_TIMESTAMP = "1970-01-01T00:00:00.000Z"

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
  const status = asString(value)
    ?.toLowerCase()
    .trim()
    .replaceAll("_", "-")
    .replaceAll(" ", "-")

  if (!status) {
    return "running"
  }

  if (
    status === "waiting-approval" ||
    status === "needs-approval" ||
    status === "pending-approval" ||
    status === "wait-approval" ||
    status === "awaiting-approval" ||
    status === "approval-required"
  ) {
    return "waiting-approval"
  }

  if (
    status === "finished" ||
    status === "completed" ||
    status === "success" ||
    status === "done"
  ) {
    return "finished"
  }

  if (status === "failed" || status === "error" || status === "errored") {
    return "failed"
  }

  if (status === "cancelled" || status === "canceled") {
    return "cancelled"
  }

  if (
    status === "running" ||
    status === "in-progress" ||
    status === "inprogress" ||
    status === "active"
  ) {
    return "running"
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
  const state = asObject(run?.state)

  const workflowId =
    asString(run?.workflowId) ??
    asString(run?.workflow_id) ??
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
    asString(run?.updatedAt) ??
    EPOCH_ISO_TIMESTAMP

  const statusValue =
    asString(run?.status) ??
    asString(run?.stateKey) ??
    asString(run?.runState) ??
    asString(state?.key) ??
    asString(state?.status)

  return {
    id: asString(run?.runId) ?? asString(run?.id) ?? "unknown-run",
    workspaceId,
    workflowId,
    workflowName,
    status: normalizeStatus(statusValue),
    startedAt,
    finishedAt:
      asString(run?.finishedAt) ??
      asString(run?.endedAt) ??
      asString(run?.completedAt) ??
      null,
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
  const workflowDirectory = path.join(getWorkspaceWorkflowRootPath(workspacePath), workflowId)
  const tsxPath = path.join(workflowDirectory, "workflow.tsx")
  const tsPath = path.join(workflowDirectory, "workflow.ts")

  if (existsSync(tsxPath)) {
    return tsxPath
  }

  if (existsSync(tsPath)) {
    return tsPath
  }

  return tsxPath
}

function resolveWorkflowPathFromRun(workspacePath: string, run: unknown) {
  const runObject = asObject(run)
  const workflow = asObject(runObject?.workflow)
  const workflowRef = asObject(runObject?.workflowRef)

  const directWorkflowPath =
    asString(runObject?.workflowPath) ??
    asString(runObject?.workflow_path)

  if (directWorkflowPath) {
    return directWorkflowPath
  }

  const workflowId =
    asString(runObject?.workflowId) ??
    asString(runObject?.workflow_id) ??
    asString(workflow?.id) ??
    asString(workflowRef?.id)

  if (!workflowId) {
    return null
  }

  return resolveWorkflowPath(workspacePath, workflowId)
}

function getWorkflowIdFromRun(run: unknown) {
  const runObject = asObject(run)
  const workflow = asObject(runObject?.workflow)
  const workflowRef = asObject(runObject?.workflowRef)

  return (
    asString(runObject?.workflowId) ??
    asString(runObject?.workflow_id) ??
    asString(workflow?.id) ??
    asString(workflowRef?.id) ??
    null
  )
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
  repairLegacyDefaultWorkflowTemplate(workspaceId, input.workflowId)
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
  const existingRunPayload = await getSmithersRun(baseUrl, runId)
  const unwrappedRun = unwrapRun(existingRunPayload)
  const workflowId = getWorkflowIdFromRun(unwrappedRun)
  if (workflowId) {
    repairLegacyDefaultWorkflowTemplate(workspaceId, workflowId)
  }

  const workflowPath = resolveWorkflowPathFromRun(workspace.path, unwrappedRun)

  if (!workflowPath) {
    throw new HttpError(422, `Unable to resolve workflowPath for run: ${runId}`)
  }

  const payload = await resumeSmithersRun(baseUrl, runId, {
    workflowPath,
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

export async function connectRunEventStream(
  workspaceId: string,
  runId: string,
  afterSeq?: number,
  signal?: AbortSignal
) {
  const workspace = assertWorkspace(workspaceId)
  const baseUrl = await ensureWorkspaceSmithersBaseUrl(workspace)
  return await streamSmithersRunEvents(baseUrl, runId, afterSeq, signal)
}
