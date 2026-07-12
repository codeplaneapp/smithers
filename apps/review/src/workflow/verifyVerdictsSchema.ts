import { reviewCommentSeveritySchema } from "./openCodeReview";
import { z } from "zod/v4";

// index defaults to -1 so a verdict missing its index is ignored instead of
// silently targeting finding 0.
export const verifyVerdictsSchema = z.object({
  verdicts: z
    .array(
      z.object({
        index: z.number().int().min(-1).max(1_000).default(-1),
        verdict: z.enum(["keep", "drop", "demote"]).default("keep"),
        // Strict structured-output schemas require every property. Null keeps
        // the semantic "no explicit severity" case representable.
        severity: reviewCommentSeveritySchema.nullable().optional(),
        reason: z.string().max(2_000).default(""),
      }),
    )
    .max(100)
    .default([]),
});

export type VerifyVerdicts = z.infer<typeof verifyVerdictsSchema>;
export type FindingVerdict = VerifyVerdicts["verdicts"][number];
