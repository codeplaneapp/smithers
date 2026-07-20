import { z } from "zod/v4";

export const changedFileSchema = z.object({
  path: z.string(),
  status: z.string().default("modified"),
  insertions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  diff: z.string().default(""),
  reviewed: z.boolean().default(false),
  excludeReason: z.string().default(""),
});

export type ChangedFile = z.infer<typeof changedFileSchema>;
