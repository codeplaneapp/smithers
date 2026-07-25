export type RewindAuditResult =
  | "success"
  | "failed"
  | "partial"
  | "in_progress"
  /** Refused before any mutation (Busy/RateLimited); never counts against the quota. */
  | "rejected";
