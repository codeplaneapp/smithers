import { z } from "zod/v4";
import { changedFileSchema } from "./changedFileSchema";

export const changesSchema = z.object({
  files: z.array(changedFileSchema).default([]),
  totalFiles: z.number().int().nonnegative().default(0),
  totalInsertions: z.number().int().nonnegative().default(0),
  totalDeletions: z.number().int().nonnegative().default(0),
});

export type Changes = z.infer<typeof changesSchema>;
