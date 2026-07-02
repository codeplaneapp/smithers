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
    (options.summary.outputTokens * price.output) / 1_000_000 +
    (options.summary.cacheCreationTokens * price.cacheWrite) / 1_000_000 +
    (options.summary.cacheReadTokens * price.cacheRead) / 1_000_000;
  if (options.sessionHash) {
    // This request was already forwarded to Anthropic and its response streamed
    // to the client — the cost is real money spent. Record it UNCONDITIONALLY.
    // The cap is enforced pre-flight (handleAnthropic 402s the NEXT request once
    // spent >= cap); it cannot un-spend an in-flight call. The previous
    // conditional `... WHERE spent_usd + ? <= spend_cap_usd` dropped any call that
    // crossed the cap from BOTH the spend tally and the usage_events audit log,
    // systematically undercounting real Anthropic spend on every capped session.
    await db
      .prepare("UPDATE sessions SET spent_usd = spent_usd + ? WHERE hash = ?")
      .bind(costUsd, options.sessionHash)
      .run();
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
