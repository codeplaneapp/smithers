import type { D1Database } from "../d1.ts";
import { monthKey as monthKeyFor } from "../monthKey.ts";

export interface ReviewSlot {
  monthKey: string;
  used: number;
  alreadyReviewed: boolean;
  overQuota: boolean;
}

/**
 * Atomically claim a review slot for `pr` against the calendar-month plan.
 *
 * The claim is a single conditional INSERT: the reviewed_prs row is written
 * only when the PR is not already recorded AND the month is still under the
 * plan limit. SQLite/D1 serialize writes, so two concurrent requests for two
 * new PRs racing for the last remaining slot cannot both win — exactly one
 * INSERT changes a row. The prior check-then-insert split let both pass the
 * read and overspend the plan.
 *
 * overQuota is true only when no slot exists for this PR after the attempt (a
 * new PR on a full month). An already-reviewed PR always re-claims for free.
 */
export async function claimReviewSlot(
  db: D1Database,
  repo: string,
  pr: number,
  prsPerMonth: number,
  now: number,
): Promise<ReviewSlot> {
  const monthKey = monthKeyFor(now);
  const claim = await db
    .prepare(
      `INSERT INTO reviewed_prs (repo, pr, month, first_seen_at)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM reviewed_prs WHERE repo = ? AND pr = ? AND month = ?)
         AND (SELECT COUNT(*) FROM reviewed_prs WHERE repo = ? AND month = ?) < ?`,
    )
    .bind(repo, pr, monthKey, now, repo, pr, monthKey, repo, monthKey, prsPerMonth)
    .run();
  const inserted = (claim.meta.changes ?? 0) > 0;
  const existing =
    inserted ||
    (await db
      .prepare("SELECT 1 AS ok FROM reviewed_prs WHERE repo = ? AND pr = ? AND month = ?")
      .bind(repo, pr, monthKey)
      .first<{ ok: number }>()) != null;
  const usedRow = await db
    .prepare("SELECT COUNT(*) AS c FROM reviewed_prs WHERE repo = ? AND month = ?")
    .bind(repo, monthKey)
    .first<{ c: number }>();
  const used = usedRow?.c ?? 0;
  return {
    monthKey,
    used,
    alreadyReviewed: !inserted && existing,
    overQuota: !existing,
  };
}
