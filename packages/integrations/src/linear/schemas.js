import { z } from "zod";

// Zod payload schemas for Linear webhook deliveries and outbound results.
// Core fields are typed; everything else passes through (`z.looseObject`)
// so workflows can read fields we don't model without a schema change.

/** Entity `data` for an Issue webhook (`type: "Issue"`). */
export const linearIssueDataSchema = z.looseObject({
  id: z.string(),
  identifier: z.string().optional(),
  title: z.string().optional(),
  description: z.string().nullish(),
  priority: z.number().optional(),
  url: z.string().optional(),
  team: z.looseObject({ id: z.string(), key: z.string().optional(), name: z.string().optional() }).optional(),
  state: z.looseObject({ id: z.string(), name: z.string().optional(), type: z.string().optional() }).optional(),
});

/** Entity `data` for a Comment webhook (`type: "Comment"`). */
export const linearCommentDataSchema = z.looseObject({
  id: z.string(),
  body: z.string().optional(),
  issueId: z.string().optional(),
  issue: z.looseObject({ id: z.string(), identifier: z.string().optional(), title: z.string().optional() }).optional(),
});

/**
 * Full Linear webhook delivery: `{ action, type, data, updatedFrom?, url?,
 * webhookId?, webhookTimestamp?, organizationId? }`. `updatedFrom` carries
 * the previous values of changed fields on `action: "update"`.
 */
export const linearWebhookPayloadSchema = z.looseObject({
  action: z.string(),
  type: z.string(),
  data: z.looseObject({ id: z.string() }),
  updatedFrom: z.record(z.string(), z.unknown()).optional(),
  url: z.string().optional(),
  webhookId: z.string().optional(),
  webhookTimestamp: z.number().optional(),
  organizationId: z.string().optional(),
});

/** Issue webhook delivery (listener payload for OnIssueUpdate/OnIssueCreated). */
export const linearIssueEventSchema = linearWebhookPayloadSchema.extend({
  data: linearIssueDataSchema,
});

/** Comment webhook delivery (listener payload for OnComment). */
export const linearCommentEventSchema = linearWebhookPayloadSchema.extend({
  data: linearCommentDataSchema,
});

/**
 * Output of the outbound CreateIssue/UpdateIssue components (register as a
 * createSmithers output schema). Exactly the columns the compute task
 * writes.
 */
export const linearIssueOutputSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
});

/** Output of the outbound CommentOnIssue component. */
export const linearCommentOutputSchema = z.object({
  id: z.string(),
  body: z.string(),
  issueId: z.string(),
  issueIdentifier: z.string(),
});
