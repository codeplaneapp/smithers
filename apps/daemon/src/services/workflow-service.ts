import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import type {
  Workflow,
  WorkflowAuthoringStage,
  WorkflowDocument,
  WorkflowLaunchFieldsResponse,
} from "@mr-burns/shared"

import type { AgentCliEvent } from "@/agents/BaseCliAgent"
import { defaultWorkflowTemplates } from "@/domain/workflows/templates"
import { runWorkflowGenerationAgent } from "@/services/agent-cli-service"
import { getWorkspace } from "@/services/workspace-service"
import { HttpError } from "@/utils/http-error"
import { slugify } from "@/utils/slugify"

const workflowPromptScaffold = `import { createSmithers, Sequence } from "smithers-orchestrator"
import { z } from "zod"

const { Workflow, Task, smithers, outputs } = createSmithers({
  plan: z.object({ summary: z.string() }),
  implement: z.object({ summary: z.string() }),
  validate: z.object({ summary: z.string() }),
})

export default smithers((ctx) => (
  <Workflow name="example-workflow">
    <Sequence>
      <Task id="plan" output={outputs.plan}>
        {{ summary: \`Plan for input: \${JSON.stringify(ctx.input ?? {})}\` }}
      </Task>
      <Task id="implement" output={outputs.implement}>
        {{ summary: "Implementation complete." }}
      </Task>
      <Task id="validate" output={outputs.validate}>
        {{ summary: "Validation complete." }}
      </Task>
    </Sequence>
  </Workflow>
))`

const defaultTemplateById = new Map<string, string>(
  defaultWorkflowTemplates.map((template) => [template.id, template.source])
)

const MAX_WORKFLOW_AUTHORING_ATTEMPTS = 2

type WorkflowAuthoringProgressEvent = {
  stage: WorkflowAuthoringStage
  message: string
  attempt?: number
  totalAttempts?: number
}

type WorkflowAuthoringProgressHandler = (event: WorkflowAuthoringProgressEvent) => void
type WorkflowAuthoringOutputHandler = (event: { stream: "stdout" | "stderr"; chunk: string }) => void
type WorkflowAuthoringAgentEventHandler = (event: AgentCliEvent) => void

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

function isLegacyBareSmithersSource(source: string) {
  return (
    /export\s+default\s+smithers\s*\(/.test(source) &&
    !/createSmithers/.test(source)
  )
}

function assertWorkflowSourceIsValid(source: string) {
  if (!source.trim()) {
    throw new HttpError(400, "Workflow source cannot be empty")
  }

  if (!/from\s+["']smithers-orchestrator["']/.test(source)) {
    throw new HttpError(400, "Workflow must import from smithers-orchestrator")
  }

  if (!/createSmithers/.test(source)) {
    throw new HttpError(
      400,
      "Workflow must define smithers via createSmithers(...) before export default"
    )
  }

  if (!/export\s+default\s+smithers\s*\(/.test(source)) {
    throw new HttpError(400, "Workflow must default export smithers((ctx) => (...))")
  }

  if (!/<Workflow\b/.test(source) || !/<Task\b/.test(source)) {
    throw new HttpError(400, "Workflow must contain <Workflow> and at least one <Task>")
  }

  if (!/output\s*=\s*{outputs\.[a-zA-Z0-9_]+}/.test(source)) {
    throw new HttpError(400, "Each task output should use output={outputs.<schemaKey>}")
  }

  if (/output\s*=\s*["'][^"']+["']/.test(source)) {
    throw new HttpError(
      400,
      "String task outputs are not valid. Use output={outputs.<schemaKey>} from createSmithers."
    )
  }
}

function normalizeAndValidateWorkflowSource(source: string) {
  const normalizedSource = `${stripCodeFences(source)}\n`
  assertWorkflowSourceIsValid(normalizedSource)
  return normalizedSource
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
    "Do not use a bare global smithers symbol. Always define it from createSmithers(...).",
    "Always import createSmithers from smithers-orchestrator and z from zod.",
    "Always define output schemas and reference outputs with output={outputs.<schemaKey>}.",
    "Create any missing folders needed for the target file.",
    "Use this scaffold shape and adapt IDs/schemas/prompts:",
    `\`\`\`tsx\n${workflowPromptScaffold}\n\`\`\``,
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
    "Do not use a bare global smithers symbol. Always define it from createSmithers(...).",
    "Always import createSmithers from smithers-orchestrator and z from zod.",
    "Always define output schemas and reference outputs with output={outputs.<schemaKey>}.",
    "Use this scaffold shape when rewriting if needed:",
    `\`\`\`tsx\n${workflowPromptScaffold}\n\`\`\``,
    "User request:",
    params.userPrompt,
  ].join("\n\n")
}

function buildWorkflowRepairPrompt(params: {
  workflowName: string
  workflowId: string
  userPrompt: string
  workspacePath: string
  relativeFilePath: string
  validationError: string
}) {
  return [
    "You are repairing a Smithers workflow file after validation failed.",
    "Read the current workflow file and overwrite that same file on disk with a corrected version.",
    "Do not create a second workflow file and do not rename the workflow folder.",
    "Do not return the full file in chat.",
    "After fixing the file on disk, reply with a short success confirmation only.",
    `Workflow display name: ${params.workflowName}`,
    `Workflow folder id: ${params.workflowId}`,
    `Target relative file: ${params.relativeFilePath}`,
    `Workspace path: ${params.workspacePath}`,
    "The file must import createSmithers from smithers-orchestrator and z from zod.",
    "The file must define smithers via createSmithers(...) and default export smithers((ctx) => (...)).",
    "Every task output must use output={outputs.<schemaKey>}.",
    "Validation error to fix:",
    params.validationError,
    "Original user request (preserve intent):",
    params.userPrompt,
    "Scaffold reference:",
    `\`\`\`tsx\n${workflowPromptScaffold}\n\`\`\``,
  ].join("\n\n")
}

function getErrorMessage(error: unknown) {
  if (error instanceof HttpError) {
    return error.message
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message
  }

  return "Workflow authoring failed with an unknown error."
}

function isNonFatalCodexWarning(error: unknown) {
  const message = getErrorMessage(error).toLowerCase()

  if (!message.includes("mcp") && !message.includes("network")) {
    return false
  }

  return (
    message.includes("transport channel closed") ||
    message.includes("connection refused") ||
    message.includes("failed to start") ||
    message.includes("network error")
  )
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

function toFieldLabel(key: string) {
  const withSpaces = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()

  if (!withSpaces) {
    return key
  }

  return withSpaces[0].toUpperCase() + withSpaces.slice(1)
}

function extractFirstTaskSegment(source: string) {
  const taskMatch = source.match(/<Task\b[\s\S]*?<\/Task>/)
  if (!taskMatch?.[0]) {
    return {
      entryTaskId: null,
      taskSegment: null,
    }
  }

  const taskSegment = taskMatch[0]
  const idMatch = taskSegment.match(/\bid\s*=\s*["']([^"']+)["']/)

  return {
    entryTaskId: idMatch?.[1] ?? null,
    taskSegment,
  }
}

function extractCtxInputKeys(source: string) {
  const pattern = /ctx\.input\??\.([A-Za-z_$][\w$]*)/g
  const keys: string[] = []
  const seen = new Set<string>()

  for (const match of source.matchAll(pattern)) {
    const key = match[1]
    if (!key || seen.has(key)) {
      continue
    }

    seen.add(key)
    keys.push(key)
  }

  return keys
}

export function getWorkflowLaunchFields(
  workspaceId: string,
  workflowId: string
): WorkflowLaunchFieldsResponse {
  const workflow = getWorkflow(workspaceId, workflowId)
  const { entryTaskId, taskSegment } = extractFirstTaskSegment(workflow.source)

  if (!taskSegment) {
    return {
      workflowId,
      mode: "fallback",
      entryTaskId: null,
      fields: [],
      message: "Unable to determine inputs automatically.",
    }
  }

  const inputKeys = extractCtxInputKeys(taskSegment)
  if (inputKeys.length === 0) {
    return {
      workflowId,
      mode: "fallback",
      entryTaskId,
      fields: [],
      message: "Unable to determine inputs automatically.",
    }
  }

  return {
    workflowId,
    mode: "inferred",
    entryTaskId,
    fields: inputKeys.map((key) => ({
      key,
      label: toFieldLabel(key),
      type: "string",
    })),
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

  const normalizedSource = normalizeAndValidateWorkflowSource(source)

  mkdirSync(workflowDir, { recursive: true })
  writeFileSync(filePath, normalizedSource, "utf8")

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

  const normalizedSource = normalizeAndValidateWorkflowSource(existingSource)
  if (normalizedSource !== existingSource) {
    writeFileSync(filePath, normalizedSource, "utf8")
  }

  return getWorkflow(workspaceId, workflowId)
}

async function runWorkflowAuthoringWithRetries(params: {
  workspaceId: string
  workflowId: string
  workflowName: string
  workspacePath: string
  relativeFilePath: string
  filePath: string
  agentId: string
  initialPrompt: string
  userPrompt: string
  onProgress?: WorkflowAuthoringProgressHandler
  onAgentOutput?: WorkflowAuthoringOutputHandler
  onAgentEvent?: WorkflowAuthoringAgentEventHandler
}) {
  let promptToRun = params.initialPrompt

  for (let attempt = 1; attempt <= MAX_WORKFLOW_AUTHORING_ATTEMPTS; attempt += 1) {
    params.onProgress?.({
      stage: "running-agent",
      message: `Running ${params.agentId} authoring attempt ${attempt}/${MAX_WORKFLOW_AUTHORING_ATTEMPTS}.`,
      attempt,
      totalAttempts: MAX_WORKFLOW_AUTHORING_ATTEMPTS,
    })

    let commandError: unknown = null
    try {
      await runWorkflowGenerationAgent({
        agentId: params.agentId,
        prompt: promptToRun,
        cwd: params.workspacePath,
        systemPrompt: workflowAuthorSystemPrompt,
        onOutput: params.onAgentOutput,
        onEvent: params.onAgentEvent,
      })
    } catch (error) {
      commandError = error
      if (!(params.agentId === "codex" && isNonFatalCodexWarning(error))) {
        throw error
      }

      params.onProgress?.({
        stage: "validating",
        message: "Codex reported non-fatal MCP/network warnings. Continuing with validation.",
        attempt,
        totalAttempts: MAX_WORKFLOW_AUTHORING_ATTEMPTS,
      })
    }

    params.onProgress?.({
      stage: "validating",
      message: `Validating workflow source after attempt ${attempt}.`,
      attempt,
      totalAttempts: MAX_WORKFLOW_AUTHORING_ATTEMPTS,
    })

    try {
      return finalizeWorkflowFile(params.workspaceId, params.workflowId, params.filePath)
    } catch (error) {
      const validationError =
        commandError && params.agentId === "codex" && isNonFatalCodexWarning(commandError)
          ? `${getErrorMessage(commandError)}; ${getErrorMessage(error)}`
          : getErrorMessage(error)

      if (attempt >= MAX_WORKFLOW_AUTHORING_ATTEMPTS) {
        if (commandError && params.agentId === "codex" && isNonFatalCodexWarning(commandError)) {
          throw new HttpError(500, validationError)
        }
        throw error
      }

      params.onProgress?.({
        stage: "retrying",
        message: `Validation failed on attempt ${attempt}: ${validationError}`,
        attempt,
        totalAttempts: MAX_WORKFLOW_AUTHORING_ATTEMPTS,
      })

      promptToRun = buildWorkflowRepairPrompt({
        workflowName: params.workflowName,
        workflowId: params.workflowId,
        userPrompt: params.userPrompt,
        workspacePath: params.workspacePath,
        relativeFilePath: params.relativeFilePath,
        validationError,
      })
    }
  }

  throw new HttpError(500, "Workflow authoring exhausted all retries")
}

export function repairLegacyDefaultWorkflowTemplate(
  workspaceId: string,
  workflowId: string
) {
  const replacementSource = defaultTemplateById.get(workflowId)
  if (!replacementSource) {
    return false
  }

  let filePath: string
  try {
    filePath = getWorkflowFilePath(workspaceId, workflowId)
  } catch {
    return false
  }

  const existingSource = readFileSync(filePath, "utf8")
  if (!isLegacyBareSmithersSource(existingSource)) {
    return false
  }

  const normalizedReplacement = normalizeAndValidateWorkflowSource(replacementSource)
  writeFileSync(filePath, normalizedReplacement, "utf8")
  return true
}

export async function generateWorkflowFromPrompt(params: {
  workspaceId: string
  name: string
  agentId: string
  prompt: string
  onProgress?: WorkflowAuthoringProgressHandler
  onAgentOutput?: WorkflowAuthoringOutputHandler
  onAgentEvent?: WorkflowAuthoringAgentEventHandler
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
  const relativeFilePath = path.join(".mr-burns", "workflows", workflowId, "workflow.tsx")

  mkdirSync(workflowDir, { recursive: true })

  params.onProgress?.({
    stage: "preparing",
    message: `Preparing generation for workflow "${params.name}" (${workflowId}).`,
    totalAttempts: MAX_WORKFLOW_AUTHORING_ATTEMPTS,
  })

  const generationPrompt = buildWorkflowGenerationPrompt({
    workflowName: params.name,
    workflowId,
    userPrompt: params.prompt,
    workspacePath: workspace.path,
  })

  const authoredWorkflow = await runWorkflowAuthoringWithRetries({
    workspaceId: params.workspaceId,
    workflowId,
    workflowName: params.name,
    workspacePath: workspace.path,
    relativeFilePath,
    filePath,
    agentId: params.agentId,
    initialPrompt: generationPrompt,
    userPrompt: params.prompt,
    onProgress: params.onProgress,
    onAgentOutput: params.onAgentOutput,
    onAgentEvent: params.onAgentEvent,
  })

  params.onProgress?.({
    stage: "completed",
    message: `Workflow "${workflowId}" generated successfully.`,
  })

  return authoredWorkflow
}

export async function editWorkflowFromPrompt(params: {
  workspaceId: string
  workflowId: string
  agentId: string
  prompt: string
  onProgress?: WorkflowAuthoringProgressHandler
  onAgentOutput?: WorkflowAuthoringOutputHandler
  onAgentEvent?: WorkflowAuthoringAgentEventHandler
}) {
  const workspace = getWorkspace(params.workspaceId)

  if (!workspace) {
    throw new HttpError(404, `Workspace not found: ${params.workspaceId}`)
  }

  const existingWorkflow = getWorkflow(params.workspaceId, params.workflowId)
  const filePath = getWorkflowFilePath(params.workspaceId, params.workflowId)

  params.onProgress?.({
    stage: "preparing",
    message: `Preparing edit for workflow "${params.workflowId}".`,
    totalAttempts: MAX_WORKFLOW_AUTHORING_ATTEMPTS,
  })

  const editPrompt = buildWorkflowEditPrompt({
    workflowName: existingWorkflow.name,
    workflowId: params.workflowId,
    userPrompt: params.prompt,
    workspacePath: workspace.path,
    relativeFilePath: existingWorkflow.relativePath,
  })

  const editedWorkflow = await runWorkflowAuthoringWithRetries({
    workspaceId: params.workspaceId,
    workflowId: params.workflowId,
    workflowName: existingWorkflow.name,
    workspacePath: workspace.path,
    relativeFilePath: existingWorkflow.relativePath,
    filePath,
    agentId: params.agentId,
    initialPrompt: editPrompt,
    userPrompt: params.prompt,
    onProgress: params.onProgress,
    onAgentOutput: params.onAgentOutput,
    onAgentEvent: params.onAgentEvent,
  })

  params.onProgress?.({
    stage: "completed",
    message: `Workflow "${params.workflowId}" updated successfully.`,
  })

  return editedWorkflow
}
