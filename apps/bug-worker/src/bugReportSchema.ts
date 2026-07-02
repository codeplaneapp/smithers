import { z } from "zod";

/**
 * Bug intake payload. Deliberately loose beyond the title: reports come from
 * `smithers bug` and from humans, and we would rather store a slightly odd
 * report than bounce one.
 */
export const bugReportSchema = z
  .object({
    title: z.string().min(1).max(500),
    body: z.string().optional(),
    smithersVersion: z.string().optional(),
    platform: z.record(z.string(), z.unknown()).optional(),
    run: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();
