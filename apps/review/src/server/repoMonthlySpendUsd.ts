import type { D1Database } from "./d1.ts";

/**
 * Month-to-date Anthropic spend for a repo, summed from usage_events since UTC
 * month start. The per-session spend cap resets on every mint, so this
 * cross-session total is the only figure that bounds a repo's real spend. The
 * usage_events(repo, created_at) index keeps the scan cheap.
 */
export async function repoMonthlySpendUsd(db: D1Database, repo: string, now: number): Promise<number> {
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const row = await db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM usage_events WHERE repo = ? AND created_at >= ?")
    .bind(repo, monthStart)
    .first<{ spend: number }>();
  return row?.spend ?? 0;
}
