import { z } from "zod/v4";

export const changedFileSchema = z.object({
  path: z.string().max(1_024),
  status: z.string().max(32).default("modified"),
  insertions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  deletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  diff: z.string().max(8 * 1024 * 1024).default(""),
  reviewed: z.boolean().default(false),
  excludeReason: z.string().max(100).default(""),
});

export type ChangedFile = z.infer<typeof changedFileSchema>;
