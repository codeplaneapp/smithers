import { z } from "zod";

/** The one line triage files the report under. */
const headline = z.string().min(1).max(500);

/**
 * Bug intake payload.
 *
 * Installed 0.x CLIs post `title` and an object platform to the same endpoint
 * as current CLIs, which post `summary` and a string platform. Accept both
 * envelopes without rewriting them; unknown fields stay available to triage.
 *
 * At least one non-blank headline is required: a report with no headline is
 * refused, because triage cannot file what it cannot name.
 */
export const bugReportSchema = z
  .object({
    summary: headline.nullish(),
    title: headline.nullish(),
    version: z.string().nullish(),
    node: z.string().nullish(),
    platform: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish(),
    runs: z.array(z.unknown()).nullish(),
    digest: z.unknown().nullish(),
  })
  .loose()
  .refine((report) => Boolean(report.summary?.trim()) || Boolean(report.title?.trim()), {
    message: "a report needs a non-empty summary or title",
    path: ["summary"],
  });
