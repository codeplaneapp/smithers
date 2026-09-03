import { z } from "zod";

export const RelevantPoc = z.object({
  pocDir: z.string().describe("POC directory name (e.g. 'microsandbox-vm')"),
  relevance: z.string().describe("Why this POC is relevant to the issue"),
  keyFiles: z.array(z.string()).describe("Key files in the POC to reference"),
  reusablePatterns: z.string().describe("Patterns or code from this POC that can be adapted"),
});
export type RelevantPoc = z.infer<typeof RelevantPoc>;

export const ResearchOutput = z.object({
  issueIdentifier: z.string().describe("Linear issue identifier"),
  relevantSpecs: z.array(z.string()).describe("Spec files that are relevant to this issue"),
  specSummary: z.string().describe("Summary of relevant spec sections"),
  existingCode: z.array(z.string()).describe("Existing code files relevant to this issue"),
  relevantPocs: z.array(RelevantPoc).describe("POCs in poc/ that contain relevant prototypes or patterns"),
  architectureNotes: z.string().describe("Notes about how this issue fits the architecture"),
  implementationHints: z.string().describe("Suggested implementation approach based on specs and POCs"),
});
export type ResearchOutput = z.infer<typeof ResearchOutput>;
