/** Max concurrency for parallel issue processing within a batch. */
export const CONCURRENCY = parseInt(process.env.BATCH_CONCURRENCY ?? "8", 10);

/** Number of issues to process in each batch. */
export const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? "10", 10);

/** Maximum review-fix rounds before the validation loop gives up. */
export const MAX_REVIEW_ROUNDS = 3;

/** Linear team key for Smithers (resolved to UUID at runtime). */
export const SMITHERS_TEAM_KEY = process.env.SMITHERS_LINEAR_TEAM_KEY ?? "JJH";

/** Blocked issue labels/tags that indicate 3rd-party dependency blockers. */
export const BLOCKED_LABELS = ["blocked", "blocked-by-sdk", "waiting-on-upstream"];

/** SDK bug issues that block other work — skip these during batch processing. */
export const BLOCKED_ISSUE_IDS = [
  "JJH-357", // Binary file roundtrip broken (double base64)
  "JJH-358", // watchFiles() relative URL bug
  "JJH-359", // Empty file creation silently fails
  "JJH-360", // readTextFile through symlink fails
];
