import { z } from "zod";

export const ReportOutput = z.object({
  issueIdentifier: z.string().describe("Linear issue identifier"),
  issueTitle: z.string().describe("Title of the issue"),
  status: z.enum(["completed", "partial", "failed"]).describe("Final status"),
  summary: z.string().describe("Concise summary of what was implemented"),
  filesChanged: z.number().describe("Number of files changed"),
  testsAdded: z.number().describe("Number of tests added"),
  reviewRounds: z.number().describe("How many review rounds it took"),
  struggles: z.array(z.string()).nullable().describe("Any struggles or issues encountered"),
  lessonsLearned: z.array(z.string()).nullable().describe("Lessons for future issues"),
});
export type ReportOutput = z.infer<typeof ReportOutput>;
