import { z } from "zod";

export const MergeOutput = z.object({
  issueIdentifier: z.string().describe("Linear issue identifier that was merged"),
  success: z.boolean().describe("Whether the merge succeeded"),
  changeId: z.string().nullable().describe("jj change ID that was squashed to main"),
  conflictsEncountered: z.boolean().describe("Whether merge conflicts were encountered"),
  conflictDetails: z.string().nullable().describe("Details of conflicts if any"),
  commitMessages: z.array(z.string()).describe("Commit messages from the merge"),
});
export type MergeOutput = z.infer<typeof MergeOutput>;
