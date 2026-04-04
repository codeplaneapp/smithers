import { z } from "zod"

export const approvalStatusSchema = z.enum(["pending", "approved", "denied"])

export const approvalSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  label: z.string(),
  status: approvalStatusSchema,
  waitMinutes: z.number().int().nonnegative(),
  note: z.string().optional(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
})

export const approvalDecisionInputSchema = z.object({
  decidedBy: z.string().min(1),
  note: z.string().optional(),
})

export const approvalInboxItemSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  iteration: z.number().int().nonnegative(),
  workflowName: z.string(),
  runStatus: z.string().nullable().optional(),
  runFound: z.boolean(),
  nodeLabel: z.string(),
  requestTitle: z.string(),
  requestSummary: z.string().nullable().optional(),
  requestedAt: z.string(),
  requestedAtMs: z.number().int().nonnegative(),
  waitingMs: z.number().int().nonnegative(),
  waitingMinutes: z.number().int().nonnegative(),
  note: z.string().optional(),
})

export const approvalInboxResponseSchema = z.object({
  approvals: z.array(approvalInboxItemSchema),
})

export type Approval = z.infer<typeof approvalSchema>
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionInputSchema>
export type ApprovalInboxItem = z.infer<typeof approvalInboxItemSchema>
export type ApprovalInboxResponse = z.infer<typeof approvalInboxResponseSchema>
