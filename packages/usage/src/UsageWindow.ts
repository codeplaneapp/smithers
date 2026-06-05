/**
 * One quota window for an account: a 5-hour session, a weekly cap, a per-minute
 * request bucket, and so on.
 *
 * The `unit` decides which fields are meaningful:
 * - `percent`   — subscription utilization; read `usedPercent` (0–100).
 * - `count`     — API-key buckets; read `limit`, `remaining`, `used`.
 * - `estimated` — locally estimated; read `usedPercent`/`used`/`limit`, treat as
 *                 a lower bound, never as authoritative.
 */
export type UsageWindow = {
  /** Stable id, e.g. "5h" | "weekly" | "requests-per-min" | "tokens-per-min". */
  id: string;
  /** Human label, e.g. "5-hour session". */
  label: string;
  /** Which fields below are meaningful. */
  unit: "percent" | "count" | "estimated";
  /** 0–100. Set for `percent` and `estimated`. */
  usedPercent?: number;
  /** Absolute amount consumed. Set for `count` and `estimated`. */
  used?: number;
  /** Absolute cap. Set for `count` and `estimated`. */
  limit?: number;
  /** `limit - used`. Set for `count`. */
  remaining?: number;
  /** ISO-8601 timestamp when this window rolls over. */
  resetsAt?: string;
};
