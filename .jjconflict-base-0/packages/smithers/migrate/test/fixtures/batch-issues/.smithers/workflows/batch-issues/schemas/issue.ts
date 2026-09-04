import { z } from "zod";

export const LinearIssue = z.object({
  id: z.string().describe("Linear issue UUID"),
  identifier: z.string().describe("Linear issue identifier (e.g. JJH-123)"),
  title: z.string().describe("Issue title"),
  description: z.string().nullable().describe("Issue description in markdown"),
  priority: z.number().describe("Priority (0=none, 1=urgent, 2=high, 3=medium, 4=low)"),
  priorityLabel: z.string().describe("Priority label (e.g. Urgent, High, Medium, Low)"),
  state: z.string().nullable().describe("Current state name (e.g. Backlog, Todo)"),
  labels: z.array(z.string()).describe("Label names"),
});
export type LinearIssue = z.infer<typeof LinearIssue>;

export const FetchIssuesOutput = z.object({
  issues: z.array(LinearIssue).describe("All backlog issues fetched from Linear"),
  count: z.number().describe("Total number of issues fetched"),
});
export type FetchIssuesOutput = z.infer<typeof FetchIssuesOutput>;
