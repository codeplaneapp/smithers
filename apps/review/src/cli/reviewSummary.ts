import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  lstatSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const MAX_SUMMARY_BYTES = 4 * 1024;
const COUNT_LIMIT = 1_000_000;

const RUN_STATUSES = new Set(["finished", "failed", "cancelled"] as const);
const REVIEW_STATUSES = new Set([
  "success",
  "skipped",
  "completed_with_warnings",
  "completed_with_errors",
  "failed",
] as const);
const IMPACT_LEVELS = new Set(["low", "moderate", "high", "critical"] as const);
const SEVERITIES = ["critical", "major", "minor", "info"] as const;

type RunStatus = "finished" | "failed" | "cancelled" | "unknown";
type ReviewStatus = "success" | "skipped" | "completed_with_warnings" | "completed_with_errors" | "failed" | "unknown";
type ImpactLevel = "low" | "moderate" | "high" | "critical" | "unknown";

export interface CanonicalReviewSummary {
  schemaVersion: 1;
  status: RunStatus;
  reviewStatus: ReviewStatus;
  files: number;
  findings: number;
  inline: number;
  severity: Record<(typeof SEVERITIES)[number], number>;
  walkthroughReady: boolean;
  publishSucceeded: boolean;
  publishFailed: boolean;
  failedFileReviews: number;
  impact: ImpactLevel;
  questions: number;
}

interface ReviewSummaryInput {
  status: unknown;
  reviewStatus: unknown;
  files: unknown;
  findings: unknown;
  inline: unknown;
  severity: unknown;
  walkthroughReady: unknown;
  publishSucceeded: unknown;
  publishFailed: unknown;
  failedFileReviews: unknown;
  impact: unknown;
  questions: unknown;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedCount(value: unknown): number {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(count) && count >= 0 && count <= COUNT_LIMIT ? count : 0;
}

function runStatus(value: unknown): RunStatus {
  return typeof value === "string" && RUN_STATUSES.has(value as never) ? value as RunStatus : "unknown";
}

function reviewStatus(value: unknown): ReviewStatus {
  return typeof value === "string" && REVIEW_STATUSES.has(value as never) ? value as ReviewStatus : "unknown";
}

function impactLevel(value: unknown): ImpactLevel {
  return typeof value === "string" && IMPACT_LEVELS.has(value as never) ? value as ImpactLevel : "unknown";
}

function severityCounts(value: unknown): CanonicalReviewSummary["severity"] {
  const record = obj(value);
  return {
    critical: boundedCount(record?.critical),
    major: boundedCount(record?.major),
    minor: boundedCount(record?.minor),
    info: boundedCount(record?.info),
  };
}

/** Rebuild a machine summary from a fixed, non-sensitive scalar allowlist. */
export function buildCanonicalReviewSummary(input: ReviewSummaryInput): CanonicalReviewSummary {
  return {
    schemaVersion: 1,
    status: runStatus(input.status),
    reviewStatus: reviewStatus(input.reviewStatus),
    files: boundedCount(input.files),
    findings: boundedCount(input.findings),
    inline: boundedCount(input.inline),
    severity: severityCounts(input.severity),
    walkthroughReady: input.walkthroughReady === true,
    publishSucceeded: input.publishSucceeded === true,
    publishFailed: input.publishFailed === true,
    failedFileReviews: boundedCount(input.failedFileReviews),
    impact: impactLevel(input.impact),
    questions: boundedCount(input.questions),
  };
}

/** Parse only summaries emitted by buildCanonicalReviewSummary. */
export function parseCanonicalReviewSummary(value: unknown): CanonicalReviewSummary {
  const record = obj(value);
  const allowed = new Set([
    "schemaVersion",
    "status",
    "reviewStatus",
    "files",
    "findings",
    "inline",
    "severity",
    "walkthroughReady",
    "publishSucceeded",
    "publishFailed",
    "failedFileReviews",
    "impact",
    "questions",
  ]);
  if (
    !record || record.schemaVersion !== 1
    || Object.keys(record).length !== allowed.size
    || Object.keys(record).some((key) => !allowed.has(key))
  ) throw new Error("review summary has an invalid schema");
  const canonical = buildCanonicalReviewSummary(record as unknown as ReviewSummaryInput);
  const severity = obj(record.severity);
  const scalarKeys = [
    "schemaVersion",
    "status",
    "reviewStatus",
    "files",
    "findings",
    "inline",
    "walkthroughReady",
    "publishSucceeded",
    "publishFailed",
    "failedFileReviews",
    "impact",
    "questions",
  ] as const;
  if (
    scalarKeys.some((key) => canonical[key] !== record[key])
    || !severity || Object.keys(severity).length !== SEVERITIES.length
    || SEVERITIES.some((key) => canonical.severity[key] !== severity[key])
  ) {
    throw new Error("review summary contains a non-canonical value");
  }
  return canonical;
}

/** Atomically publish a private summary, safely replacing an existing regular file. */
export function writeReviewSummary(path: string, summary: CanonicalReviewSummary): void {
  const canonical = parseCanonicalReviewSummary(summary);
  const json = JSON.stringify(canonical);
  if (Buffer.byteLength(json) > MAX_SUMMARY_BYTES) throw new Error("review summary exceeds 4 KB");
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let closed = false;
  let published = false;
  try {
    if (!fstatSync(fd).isFile()) throw new Error("review summary destination is not a regular file");
    fchmodSync(fd, 0o600);
    writeFileSync(fd, json);
    fsyncSync(fd);
    closeSync(fd);
    closed = true;
    try {
      const existing = lstatSync(path);
      if (!existing.isFile()) throw new Error("review summary destination is not a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(temporaryPath, path);
    published = true;
  } finally {
    if (!closed) closeSync(fd);
    if (!published) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the primary validation/write failure.
      }
    }
  }
}
