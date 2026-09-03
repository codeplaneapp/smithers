import { z } from "zod";

export const ValidateOutput = z.object({
  allPassed: z.boolean().describe("Whether all tests and checks passed"),
  failingSummary: z.string().nullable().describe("Summary of what failed and why (null if all passed)"),
  fullOutput: z.string().describe("Full output from test run"),
});
export type ValidateOutput = z.infer<typeof ValidateOutput>;
