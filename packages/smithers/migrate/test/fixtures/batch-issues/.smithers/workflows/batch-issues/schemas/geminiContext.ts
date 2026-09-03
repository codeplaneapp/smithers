import { z } from "zod";

export const GeminiContextOutput = z.object({
  architecturalPatterns: z.array(z.string()).describe("Key architectural patterns extracted from specs"),
  recentChanges: z.array(z.object({
    commit: z.string().describe("Commit hash or short ref"),
    summary: z.string().describe("What the commit changed"),
    relevantAreas: z.array(z.string()).describe("Code areas affected"),
  })).describe("Recent commits with their context"),
  specHighlights: z.array(z.object({
    specFile: z.string().describe("Which spec file"),
    keyDecisions: z.array(z.string()).describe("Key decisions from this spec"),
    implementationNotes: z.array(z.string()).describe("Notes relevant to implementation"),
  })).describe("Highlights from each spec file"),
  currentState: z.string().describe("Summary of the current project state based on commit history"),
  blockers: z.array(z.string()).describe("Any blockers or risks identified from specs + history"),
  contextForPlanning: z.string().describe("Synthesized context useful for issue prioritization and implementation"),
});
export type GeminiContextOutput = z.infer<typeof GeminiContextOutput>;
