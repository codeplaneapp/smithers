import type { D1Database } from "../d1.ts";
import { randomTokenHex } from "../randomTokenHex.ts";
import { modelPrices } from "./modelPrices.ts";
import type { UsageSummary } from "./parseUsage.ts";

export interface RecordedUsage {
  costUsd: number;
  recorded: boolean;
}

/**
 * Append a usage_events row and increment the session's spent_usd. Cost comes
 * from the static modelPrices table; unknown models still record token counts
 * with cost 0 so dashboards see them and we can backfill later.
 */
export async function recordUsage(
  db: D1Database,
  options: {
    sessionHash: string | null;
    repo: string;
    pr: number;
    summary: UsageSummary;
    kind: "messages" | "messages_stream" | "other";
    now: number;
  },
): Promise<RecordedUsage> {
  const price = modelPrices(options.summary.model);
  const costUsd =
    (options.summary.inputTokens * price.input) / 1_000_000 +
    (options.summary.outputTokens * price.output) / 1_000_000;
  if (options.sessionHash) {
    const reservation = await db
      .prepare(
        "UPDATE sessions SET spent_usd = spent_usd + ? WHERE hash = ? AND spent_usd + ? <= spend_cap_usd",
      )
      .bind(costUsd, options.sessionHash, costUsd)
      .run();
    if ((reservation.meta.changes ?? 0) !== 1) return { costUsd, recorded: false };
  }
  await db
    .prepare(
      "INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      randomTokenHex(8),
      options.repo,
      options.pr,
      options.summary.model,
      options.summary.inputTokens,
      options.summary.outputTokens,
      costUsd,
      options.kind,
      options.now,
    )
    .run();
  return { costUsd, recorded: true };
}
