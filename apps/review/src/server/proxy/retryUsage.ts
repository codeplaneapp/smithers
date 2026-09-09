import type { D1Database } from "../d1.ts";
import { recordUsage } from "./recordUsage.ts";

/** Retry durable settlements before admitting more spend for this repository. */
export async function retryUsage(db: D1Database, repo: string): Promise<void> {
  const pending = await db
    .prepare("SELECT settlement_json FROM usage_reservations WHERE repo = ? AND settlement_json IS NOT NULL LIMIT 4")
    .bind(repo)
    .all<{ settlement_json: string }>();
  for (const row of pending.results) {
    await recordUsage(db, JSON.parse(row.settlement_json) as Parameters<typeof recordUsage>[1]);
  }
}
