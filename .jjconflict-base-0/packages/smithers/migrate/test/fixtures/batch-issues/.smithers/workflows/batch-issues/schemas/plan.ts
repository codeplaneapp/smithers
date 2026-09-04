import { z } from "zod";

export const PlannedIssue = z.object({
  identifier: z.string().describe("Linear issue identifier (e.g. JJH-123)"),
  title: z.string().describe("Issue title"),
  priority: z.number().describe("Assigned processing priority (1 = first)"),
  reasoning: z.string().describe("Why this issue is at this priority"),
  estimatedComplexity: z.enum(["trivial", "small", "medium", "large", "epic"]).describe("Estimated implementation complexity"),
  skip: z.boolean().describe("Whether to skip this issue (blocked by 3rd party, etc.)"),
  skipReason: z.string().nullable().describe("Why the issue should be skipped"),
});
export type PlannedIssue = z.infer<typeof PlannedIssue>;

export const PlanOutput = z.object({
  orderedIssues: z.array(PlannedIssue).describe("Issues ordered by processing priority"),
  totalToProcess: z.number().describe("Number of issues that will be processed (non-skipped)"),
  totalSkipped: z.number().describe("Number of issues skipped"),
  reasoning: z.string().describe("Overall planning rationale"),
});
export type PlanOutput = z.infer<typeof PlanOutput>;
