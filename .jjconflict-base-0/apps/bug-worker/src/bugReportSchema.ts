import { z } from "zod";

/** The one line triage files the report under. */
const headline = z.string().min(1).max(500);

/**
 * Bug intake payload.
 *
 * Deliberately loose past the headline: reports arrive from `smithers bug`, from
 * humans with curl, and storing a
 * slightly odd report beats bouncing one. The worker is deployed once and
 * cannot be upgraded in step with its client.
 *
 * One field stays required in substance: a report with no headline at all is
 * refused, because triage cannot file what it cannot name.
 */
export const bugReportSchema = z
  .object({
    summary: headline,
    version: z.string().nullish(),
    node: z.string().nullish(),
    platform: z.string().nullish(),
    runs: z.array(z.unknown()).nullish(),
    digest: z.unknown().nullish(),
  })
  .loose();
