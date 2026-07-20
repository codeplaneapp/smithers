import { reviewCommentSeveritySchema } from "./openCodeReview";
import { z } from "zod/v4";

// index defaults to -1 so a verdict missing its index is ignored instead of
// silently targeting finding 0.
export const verifyVerdictsSchema = z.object({
  verdicts: z
    .array(
      z.object({
        index: z.number().int().default(-1),
        verdict: z.enum(["keep", "drop", "demote"]).default("keep"),
        severity: reviewCommentSeveritySchema.optional(),
        reason: z.string().default(""),
      }),
    )
    .default([]),
});

export type VerifyVerdicts = z.infer<typeof verifyVerdictsSchema>;
export type FindingVerdict = VerifyVerdicts["verdicts"][number];
