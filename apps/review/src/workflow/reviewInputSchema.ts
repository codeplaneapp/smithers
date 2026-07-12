import { openCodeReviewInputSchema } from "./openCodeReview";
import { z } from "zod/v4";

export const reviewInputSchema = openCodeReviewInputSchema.extend({
  out: z.string().max(4_096).default(""),
  narrate: z.boolean().default(true),
  title: z.string().max(20_000).default(""),
  split: z.boolean().default(false),
  quiz: z.enum(["off", "auto", "on"]).default("auto"),
  verify: z.boolean().default(true),
});

export type ReviewInput = z.infer<typeof reviewInputSchema>;
