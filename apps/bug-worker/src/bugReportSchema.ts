import { z } from "zod";

/**
 * Bug intake payload.
 *
 * Deliberately loose past the headline: reports arrive from `smithers bug`, from
 * every CLI version ever installed, and from humans with curl, and storing a
 * slightly odd report beats bouncing one. The worker is deployed once and
 * cannot be upgraded in step with its clients, so every shape it has ever been
 * sent has to keep working.
 *
 * Two headline spellings, because the CLI changed under it. rc.0
 * (`packages/cli/src/Command.ts`, the `bug` verb) posts `summary`, a `platform`
 * STRING like `darwin-arm64`, `node`, the `runs` array from `Control.list`, and
 * a `digest` only when `--run` names one. 0.x posted `title`, `body`,
 * `smithersVersion`, a `platform` object, and a singular `run`. Requiring
 * `title` is what made this worker answer 400 to every rc.0 report.
 *
 * One field stays required in substance: a report with no headline at all is
 * refused, because triage cannot file what it cannot name.
 */
const headline = z.string().min(1).max(500);

/** rc.0 sends `darwin-arm64`; 0.x sent `{ os, arch, nodeVersion }`. */
const platform = z.union([z.string(), z.record(z.string(), z.unknown())]);

export const bugReportSchema = z
  .object({
    /** 0.x headline. */
    title: headline.nullish(),
    /** rc.0 headline. */
    summary: headline.nullish(),
    body: z.string().nullish(),
    /** 0.x version key. */
    smithersVersion: z.string().nullish(),
    /** rc.0 version key. */
    version: z.string().nullish(),
    node: z.string().nullish(),
    platform: platform.nullish(),
    /** 0.x: one run's digest. */
    run: z.record(z.string(), z.unknown()).nullish(),
    /** rc.0: every run in the project, from `Control.list`. */
    runs: z.array(z.unknown()).nullish(),
    /** rc.0: the `--run` event digest. */
    digest: z.unknown().nullish(),
  })
  .loose()
  .refine(
    (report) => Boolean(report.title?.trim()) || Boolean(report.summary?.trim()),
    { message: "a report needs a title (0.x) or a summary (rc.0)", path: ["summary"] },
  );
