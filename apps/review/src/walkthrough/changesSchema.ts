import { z } from "zod/v4";
import { changedFileSchema } from "./changedFileSchema";

export const changesSchema = z.object({
  files: z.array(changedFileSchema).max(3_000).default([]),
  totalFiles: z.number().int().nonnegative().max(3_000).default(0),
  totalInsertions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  totalDeletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
});

export type Changes = z.infer<typeof changesSchema>;
