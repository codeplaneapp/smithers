import type { D1Database } from "../d1.ts";

export interface RepoRecord {
  repo: string;
  mode: "auto" | "comment";
  quiz: "off" | "auto" | "on";
  prs_per_month: number;
  spend_cap_usd: number;
  created_at: number;
}

export async function lookupRepo(db: D1Database, repo: string): Promise<RepoRecord | null> {
  const row = await db
    .prepare("SELECT repo, mode, quiz, prs_per_month, spend_cap_usd, created_at FROM repos WHERE repo = ?")
    .bind(repo)
    .first<RepoRecord>();
  return row ?? null;
}
