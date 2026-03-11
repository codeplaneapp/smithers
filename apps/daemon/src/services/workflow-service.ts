import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import type { Workflow, WorkflowDocument } from "@mr-burns/shared"

import { defaultWorkflowTemplates } from "@/domain/workflows/templates"
import { runWorkflowGenerationAgent } from "@/services/agent-cli-service"
import { getWorkspace } from "@/services/workspace-service"
import { HttpError } from "@/utils/http-error"
import { slugify } from "@/utils/slugify"

function getWorkflowRoot(workspaceId: string) {
  const workspace = getWorkspace(workspaceId)

  if (!workspace) {
    throw new HttpError(404, `Workspace not found: ${workspaceId}`)
  }

  return path.join(workspace.path, ".mr-burns", "workflows")
}

function inferWorkflowStatus(workflowId: string): Workflow["status"] {
  if (workflowId === "pr-feedback") {
    return "hot"
  }

  if (workflowId === "approval-gate") {
    return "draft"
  }

  return "active"
}

function stripCodeFences(source: string) {
  const fencedMatch = source.match(/```(?:tsx|ts|typescript)?\n([\s\S]*?)```/i)
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim()
  }

  return source.trim()
}

function buildWorkflowGenerationPrompt(params: {
  workflowName: string
  workflowId: string
  userPrompt: string
  workspacePath: string
}) {
  return [
    "You are authoring a Smithers workflow for Mr. Burns inside a real workspace.",
    "Use your file editing tools to create or overwrite the target workflow file.",
    "Do NOT return the workflow source in chat unless absolutely necessary.",
    "Your primary task is to write the file on disk.",
    "After writing the file, respond with a short success confirmation only.",
    "Use stable kebab-case task IDs.",
    `Workflow display name: ${params.workflowName}`,
    `Workflow folder id: ${params.workflowId}`,
    `Target relative file: .mr-burns/workflows/${params.workflowId}/workflow.tsx`,
    `Workspace path: ${params.workspacePath}`,
    "The file must contain a default export that defines a valid Smithers workflow in TypeScript/TSX.",
    "Prefer a simple but production-leaning structure with clear plan/implement/validate style tasks when relevant.",
    "If the user asks for approval steps, use needsApproval on the relevant task.",
    "Create any missing folders needed for the target file.",
    "User request:",
    params.userPrompt,
  ].join("\n\n")
}

function buildWorkflowEditPrompt(params: {
  workflowName: string
  workflowId: string
  userPrompt: string
  workspacePath: string
  relativeFilePath: string
}) {
  return [
    "You are editing an existing Smithers workflow for Mr. Burns inside a real workspace.",
    "First read the current workflow file from disk before making changes.",
    "Then overwrite that same file on disk with the updated workflow.",
    "Do NOT create a new workflow folder or a second file.",
    "Do NOT return the full workflow source in chat unless absolutely necessary.",
    "Your primary task is to update the existing file on disk.",
    "After writing the file, respond with a short success confirmation only.",
    "Preserve stable kebab-case task IDs unless the user explicitly asks to rename them.",
    `Workflow display name: ${params.workflowName}`,
    `Workflow folder id: ${params.workflowId}`,
    `Target relative file: ${params.relativeFilePath}`,
    `Workspace path: ${params.workspacePath}`,
    "The file must continue to contain a default export that defines a valid Smithers workflow in TypeScript/TSX.",
    "If the user asks for approval steps, use needsApproval on the relevant task.",
    "User request:",
    params.userPrompt,
  ].join("\n\n")
}

const workflowAuthorSystemPrompt =
  "You author Smithers workflow files. Write the requested file to disk and then return a short success confirmation."

function getWorkflowFilePath(workspaceId: string, workflowId: string) {
  const workflowRoot = getWorkflowRoot(workspaceId)
  const candidateExtensions = ["workflow.tsx", "workflow.ts"]

  for (const candidate of candidateExtensions) {
    const filePath = path.join(workflowRoot, workflowId, candidate)
    if (existsSync(filePath)) {
      return filePath
    }
  }

  throw new HttpError(404, `Workflow not found: ${workflowId}`)
}

function mapWorkflowFile(workspaceId: string, workflowId: string, filePath: string): Workflow {
  const relativePath = path.relative(getWorkspace(workspaceId)!.path, filePath)
  const stats = statSync(filePath)

  return {
    id: workflowId,
    workspaceId,
    name: workflowId,
    relativePath,
    status: inferWorkflowStatus(workflowId),
    updatedAt: stats.mtime.toISOString(),
  }
}

export function ensureDefaultWorkflowTemplates(workspaceId: string, templateIds?: string[]) {
  const workflowRoot = getWorkflowRoot(workspaceId)
  mkdirSync(workflowRoot, { recursive: true })

  const hasWorkflowFiles = readdirSync(workflowRoot, { withFileTypes: true }).some((entry) => {
    if (!entry.isDirectory()) {
      return false
    }

    return existsSync(path.join(workflowRoot, entry.name, "workflow.tsx"))
  })

  if (hasWorkflowFiles) {
    return
  }

  const selectedTemplateIds = new Set(templateIds ?? [])
  const templatesToWrite = templateIds?.length
    ? defaultWorkflowTemplates.filter((template) => selectedTemplateIds.has(template.id))
    : defaultWorkflowTemplates

  for (const template of templatesToWrite) {
    const workflowDir = path.join(workflowRoot, template.id)
    mkdirSync(workflowDir, { recursive: true })
    writeFileSync(path.join(workflowDir, "workflow.tsx"), `${template.source}\n`, "utf8")
  }
}

export function listWorkflows(workspaceId: string) {
  const workflowRoot = getWorkflowRoot(workspaceId)

  if (!existsSync(workflowRoot)) {
    return []
  }

  return readdirSync(workflowRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        const filePath = getWorkflowFilePath(workspaceId, entry.name)
        return mapWorkflowFile(workspaceId, entry.name, filePath)
      } catch {
        return null
      }
    })
    .filter((workflow): workflow is Workflow => workflow !== null)
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function getWorkflow(workspaceId: string, workflowId: string): WorkflowDocument {
  const filePath = getWorkflowFilePath(workspaceId, workflowId)

  return {
    ...mapWorkflowFile(workspaceId, workflowId, filePath),
    source: readFileSync(filePath, "utf8"),
  }
}

export function saveWorkflow(workspaceId: string, workflowId: string, source: string) {
  const workflowRoot = getWorkflowRoot(workspaceId)
  const workflowDir = path.join(workflowRoot, workflowId)
  const filePath = path.join(workflowDir, "workflow.tsx")

  mkdirSync(workflowDir, { recursive: true })
  writeFileSync(filePath, source, "utf8")

  return getWorkflow(workspaceId, workflowId)
}

export function deleteWorkflow(workspaceId: string, workflowId: string) {
  const workflowRoot = getWorkflowRoot(workspaceId)
  const workflowDir = path.join(workflowRoot, workflowId)

  if (!existsSync(workflowDir)) {
    throw new HttpError(404, `Workflow not found: ${workflowId}`)
  }

  rmSync(workflowDir, { recursive: true, force: true })
}

function finalizeWorkflowFile(workspaceId: string, workflowId: string, filePath: string) {
  if (!existsSync(filePath)) {
    throw new HttpError(500, `Agent did not create workflow file: ${filePath}`)
  }

  const existingSource = readFileSync(filePath, "utf8")
  if (!existingSource.trim()) {
    throw new HttpError(500, `Generated workflow file is empty: ${filePath}`)
  }

  const normalizedSource = `${stripCodeFences(existingSource)}\n`
  if (normalizedSource !== existingSource) {
    writeFileSync(filePath, normalizedSource, "utf8")
  }

  return getWorkflow(workspaceId, workflowId)
}

export async function generateWorkflowFromPrompt(params: {
  workspaceId: string
  name: string
  agentId: string
  prompt: string
}) {
  const workspace = getWorkspace(params.workspaceId)

  if (!workspace) {
    throw new HttpError(404, `Workspace not found: ${params.workspaceId}`)
  }

  const workflowId = slugify(params.name)
  if (!workflowId) {
    throw new HttpError(400, "Workflow name must contain letters or numbers")
  }

  const workflowRoot = getWorkflowRoot(params.workspaceId)
  const workflowDir = path.join(workflowRoot, workflowId)
  const filePath = path.join(workflowDir, "workflow.tsx")

  mkdirSync(workflowDir, { recursive: true })

  const generationPrompt = buildWorkflowGenerationPrompt({
    workflowName: params.name,
    workflowId,
    userPrompt: params.prompt,
    workspacePath: workspace.path,
  })

  await runWorkflowGenerationAgent({
    agentId: params.agentId,
    prompt: generationPrompt,
    cwd: workspace.path,
    systemPrompt: workflowAuthorSystemPrompt,
  })

  return finalizeWorkflowFile(params.workspaceId, workflowId, filePath)
}

export async function editWorkflowFromPrompt(params: {
  workspaceId: string
  workflowId: string
  agentId: string
  prompt: string
}) {
  const workspace = getWorkspace(params.workspaceId)

  if (!workspace) {
    throw new HttpError(404, `Workspace not found: ${params.workspaceId}`)
  }

  const existingWorkflow = getWorkflow(params.workspaceId, params.workflowId)
  const filePath = getWorkflowFilePath(params.workspaceId, params.workflowId)

  const editPrompt = buildWorkflowEditPrompt({
    workflowName: existingWorkflow.name,
    workflowId: params.workflowId,
    userPrompt: params.prompt,
    workspacePath: workspace.path,
    relativeFilePath: existingWorkflow.relativePath,
  })

  await runWorkflowGenerationAgent({
    agentId: params.agentId,
    prompt: editPrompt,
    cwd: workspace.path,
    systemPrompt: workflowAuthorSystemPrompt,
  })

  return finalizeWorkflowFile(params.workspaceId, params.workflowId, filePath)
}
