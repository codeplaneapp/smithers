import type { D1Database } from "./d1.ts";
import { jsonError } from "./jsonError.ts";
import { monthKey } from "./monthKey.ts";
import { repoMonthlyCapUsd } from "./repoMonthlyCapUsd.ts";
import { repoMonthlySpendUsd } from "./repoMonthlySpendUsd.ts";
import type { RepoRecord } from "./sessions/lookupRepo.ts";

/** Shared diagnostic guard; proxy reservations atomically enforce remaining headroom. */
export async function assertRepoUnderMonthlyCap(
  db: D1Database,
  registration: RepoRecord,
  repo: string,
  now: number,
): Promise<{ monthlyCapUsd: number; monthSpendUsd: number } | Response> {
  const monthlyCapUsd = repoMonthlyCapUsd(registration);
  const monthSpendUsd = await repoMonthlySpendUsd(db, repo, now);
  if (monthSpendUsd >= monthlyCapUsd) {
    return jsonError(402, "repo monthly spend cap exhausted", {
      repo,
      month: monthKey(now),
      monthlyCapUsd,
      spentUsd: monthSpendUsd,
    });
  }
  return { monthlyCapUsd, monthSpendUsd };
}
