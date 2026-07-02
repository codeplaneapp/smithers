import { openCodeReviewInputSchema } from "smithers-workflows/lib/open-code-review";
import { z } from "zod/v4";

export const reviewInputSchema = openCodeReviewInputSchema.extend({
  out: z.string().default(""),
  narrate: z.boolean().default(true),
  title: z.string().default(""),
  split: z.boolean().default(false),
  quiz: z.enum(["off", "auto", "on"]).default("auto"),
  verify: z.boolean().default(true),
});

export type ReviewInput = z.infer<typeof reviewInputSchema>;
