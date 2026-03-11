import {
  type AgentCli,
  agentCliSchema,
  type Approval,
  type ApprovalDecisionInput,
  approvalSchema,
  type CancelRunInput,
  type CreateWorkspaceInput,
  type EditWorkflowInput,
  type GenerateWorkflowInput,
  type Run,
  type RunEvent,
  runEventSchema,
  runSchema,
  type ResumeRunInput,
  type Settings,
  type StartRunInput,
  settingsSchema,
  type UpdateWorkflowInput,
  type Workflow,
  type WorkflowDocument,
  workflowDocumentSchema,
  workflowSchema,
  type Workspace,
  workspaceSchema,
} from "@mr-burns/shared"
import { z } from "zod"

const workspaceListSchema = z.array(workspaceSchema)
const workflowListSchema = z.array(workflowSchema)
const workflowDocumentListSchema = workflowDocumentSchema
const agentCliListSchema = z.array(agentCliSchema)
const runListSchema = z.array(runSchema)
const runEventListSchema = z.array(runEventSchema)
const approvalListSchema = z.array(approvalSchema)
const nativeFolderPickerResponseSchema = z.object({
  path: z.string().nullable(),
})
const validateSmithersUrlResponseSchema = z.object({
  ok: z.boolean(),
  status: z.number().nullable(),
  message: z.string(),
})

export class BurnsClient {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  getBaseUrl() {
    return this.baseUrl
  }

  async getHealth() {
    return this.request<{ ok: true; service: string }>("/api/health")
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const data = await this.request<unknown>("/api/workspaces")
    return workspaceListSchema.parse(data)
  }

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}`)
    return workspaceSchema.parse(data)
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    const data = await this.request<unknown>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify(input),
    })

    return workspaceSchema.parse(data)
  }

  async getSettings(): Promise<Settings> {
    const data = await this.request<unknown>("/api/settings")
    return settingsSchema.parse(data)
  }

  async openNativeFolderPicker(): Promise<string | null> {
    const data = await this.request<unknown>("/api/system/folder-picker", {
      method: "POST",
    })

    return nativeFolderPickerResponseSchema.parse(data).path
  }

  async validateSmithersUrl(baseUrl: string): Promise<{
    ok: boolean
    status: number | null
    message: string
  }> {
    const data = await this.request<unknown>("/api/system/validate-smithers-url", {
      method: "POST",
      body: JSON.stringify({ baseUrl }),
    })

    return validateSmithersUrlResponseSchema.parse(data)
  }

  async listAgentClis(): Promise<AgentCli[]> {
    const data = await this.request<unknown>("/api/agents/clis")
    return agentCliListSchema.parse(data)
  }

  async listWorkflows(workspaceId: string): Promise<Workflow[]> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/workflows`)
    return workflowListSchema.parse(data)
  }

  async getWorkflow(workspaceId: string, workflowId: string): Promise<WorkflowDocument> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/workflows/${workflowId}`)
    return workflowDocumentListSchema.parse(data)
  }

  async saveWorkflow(
    workspaceId: string,
    workflowId: string,
    source: UpdateWorkflowInput["source"]
  ): Promise<WorkflowDocument> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/workflows/${workflowId}`, {
      method: "PUT",
      body: JSON.stringify({ source }),
    })

    return workflowDocumentListSchema.parse(data)
  }

  async generateWorkflow(
    workspaceId: string,
    input: GenerateWorkflowInput
  ): Promise<WorkflowDocument> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/workflows/generate`, {
      method: "POST",
      body: JSON.stringify(input),
    })

    return workflowDocumentListSchema.parse(data)
  }

  async editWorkflow(
    workspaceId: string,
    workflowId: string,
    input: EditWorkflowInput
  ): Promise<WorkflowDocument> {
    const data = await this.request<unknown>(
      `/api/workspaces/${workspaceId}/workflows/${workflowId}/edit`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    )

    return workflowDocumentListSchema.parse(data)
  }

  async deleteWorkflow(workspaceId: string, workflowId: string): Promise<void> {
    await this.request(`/api/workspaces/${workspaceId}/workflows/${workflowId}`, {
      method: "DELETE",
    })
  }

  async listRuns(workspaceId: string): Promise<Run[]> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/runs`)
    return runListSchema.parse(data)
  }

  async getRun(workspaceId: string, runId: string): Promise<Run> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/runs/${runId}`)
    return runSchema.parse(data)
  }

  async startRun(workspaceId: string, input: StartRunInput): Promise<Run> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/runs`, {
      method: "POST",
      body: JSON.stringify(input),
    })

    return runSchema.parse(data)
  }

  async resumeRun(
    workspaceId: string,
    runId: string,
    input: ResumeRunInput = {}
  ): Promise<Run> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/runs/${runId}/resume`, {
      method: "POST",
      body: JSON.stringify(input),
    })

    return runSchema.parse(data)
  }

  async cancelRun(
    workspaceId: string,
    runId: string,
    input: CancelRunInput = {}
  ): Promise<Run> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/runs/${runId}/cancel`, {
      method: "POST",
      body: JSON.stringify(input),
    })

    return runSchema.parse(data)
  }

  async listRunEvents(workspaceId: string, runId: string, afterSeq?: number): Promise<RunEvent[]> {
    const search = new URLSearchParams()
    if (afterSeq !== undefined) {
      search.set("afterSeq", String(afterSeq))
    }

    const suffix = search.size > 0 ? `?${search.toString()}` : ""
    const data = await this.request<unknown>(
      `/api/workspaces/${workspaceId}/runs/${runId}/events${suffix}`
    )

    return runEventListSchema.parse(data)
  }

  getRunEventStreamUrl(workspaceId: string, runId: string, afterSeq?: number) {
    const url = new URL(`/api/workspaces/${workspaceId}/runs/${runId}/events/stream`, this.baseUrl)
    if (afterSeq !== undefined) {
      url.searchParams.set("afterSeq", String(afterSeq))
    }

    return url
  }

  async listApprovals(workspaceId: string): Promise<Approval[]> {
    const data = await this.request<unknown>(`/api/workspaces/${workspaceId}/approvals`)
    return approvalListSchema.parse(data)
  }

  async approveNode(
    workspaceId: string,
    runId: string,
    nodeId: string,
    input: ApprovalDecisionInput
  ): Promise<Approval> {
    const data = await this.request<unknown>(
      `/api/workspaces/${workspaceId}/runs/${runId}/nodes/${nodeId}/approve`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    )

    return approvalSchema.parse(data)
  }

  async denyNode(
    workspaceId: string,
    runId: string,
    nodeId: string,
    input: ApprovalDecisionInput
  ): Promise<Approval> {
    const data = await this.request<unknown>(
      `/api/workspaces/${workspaceId}/runs/${runId}/nodes/${nodeId}/deny`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    )

    return approvalSchema.parse(data)
  }

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const response = await fetch(new URL(pathname, this.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    })

    if (!response.ok) {
      let message = `Burns API request failed: ${response.status}`

      try {
        const errorBody = (await response.json()) as { error?: string }
        if (errorBody.error) {
          message = errorBody.error
        }
      } catch {
        // Ignore invalid JSON error bodies.
      }

      throw new Error(message)
    }

    if (response.status === 204) {
      return undefined as T
    }

    return (await response.json()) as T
  }
}
