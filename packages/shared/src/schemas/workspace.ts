import { z } from "zod"

export const workspaceHealthStatusSchema = z.enum([
  "healthy",
  "degraded",
  "disconnected",
  "unknown",
])

export const workspaceSourceTypeSchema = z.enum(["local", "clone", "create"])

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  branch: z.string().optional(),
  repoUrl: z.string().optional(),
  defaultAgent: z.string().optional(),
  healthStatus: workspaceHealthStatusSchema.default("unknown"),
  sourceType: workspaceSourceTypeSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const createWorkspaceInputSchema = z.discriminatedUnion("sourceType", [
  z.object({
    name: z.string().min(1),
    sourceType: z.literal("local"),
    localPath: z.string().min(1),
    defaultAgent: z.string().optional(),
    workflowTemplateIds: z.array(z.string()).optional(),
  }),
  z.object({
    name: z.string().min(1),
    sourceType: z.literal("clone"),
    repoUrl: z.string().min(1),
    targetFolder: z.string().min(1).optional(),
    defaultAgent: z.string().optional(),
    workflowTemplateIds: z.array(z.string()).optional(),
  }),
  z.object({
    name: z.string().min(1),
    sourceType: z.literal("create"),
    targetFolder: z.string().min(1).optional(),
    defaultAgent: z.string().optional(),
    workflowTemplateIds: z.array(z.string()).optional(),
  }),
])

export type Workspace = z.infer<typeof workspaceSchema>
export type WorkspaceHealthStatus = z.infer<typeof workspaceHealthStatusSchema>
export type WorkspaceSourceType = z.infer<typeof workspaceSourceTypeSchema>
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>
