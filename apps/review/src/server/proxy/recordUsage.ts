import type { D1Database } from "../d1.ts";
import { randomTokenHex } from "../randomTokenHex.ts";
import { isPricedAnthropicRequestModel, modelPrices } from "./modelPrices.ts";
import type { UsageSummary } from "./parseUsage.ts";

// Unknown upstream model IDs must never become a free-metering bypass. These
// deliberately exceed the highest standard rates in the supported table, so a
// newly accepted alias is charged conservatively until its exact price is added.
const UNKNOWN_MODEL_PRICE = {
  input: 15,
  output: 75,
  cacheWrite: 18.75,
  cacheRead: 1.5,
} as const;

export function modelPriceForMetering(model: string, logUnknown = true, atMs = Date.now()) {
  const price = modelPrices(model, atMs);
  if (isPricedAnthropicRequestModel(model)) return price;
  if (logUnknown) {
    console.error("smithers-review: unknown model priced at conservative metering fallback", { model });
  }
  return UNKNOWN_MODEL_PRICE;
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export interface RecordedUsage {
  costUsd: number;
  recorded: boolean;
}

/**
 * Append a usage_events row and increment the session's spent_usd. Cost comes
 * from the static modelPrices table. Unknown models use deliberately high
 * fallback rates so a newly accepted upstream ID cannot bypass spend caps
 * while its exact price is being added.
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
    /** Reservation to remove only after actual usage is durably recorded. */
    reservationId?: string;
    /** Fail-closed charge used when a response stream is incomplete. */
    minimumCostUsd?: number;
  },
): Promise<RecordedUsage> {
  const price = modelPriceForMetering(options.summary.model, true, options.now);
  const measuredCostUsd =
    (nonNegativeFinite(options.summary.inputTokens) * price.input) / 1_000_000 +
    (nonNegativeFinite(options.summary.outputTokens) * price.output) / 1_000_000 +
    (nonNegativeFinite(options.summary.cacheCreationTokens) * price.cacheWrite) / 1_000_000 +
    (nonNegativeFinite(options.summary.cacheReadTokens) * price.cacheRead) / 1_000_000;
  const minimumCostUsd = nonNegativeFinite(options.minimumCostUsd ?? 0);
  const costUsd = Math.max(measuredCostUsd, minimumCostUsd);
  const statements = [];
  if (options.sessionHash) {
    // This request was already forwarded to Anthropic and its response streamed
    // to the client — the cost is real money spent. Record it UNCONDITIONALLY.
    // The cap is enforced pre-flight (handleAnthropic 402s the NEXT request once
    // spent >= cap); it cannot un-spend an in-flight call. The previous
    // conditional `... WHERE spent_usd + ? <= spend_cap_usd` dropped any call that
    // crossed the cap from BOTH the spend tally and the usage_events audit log,
    // systematically undercounting real Anthropic spend on every capped session.
    statements.push(
      db
        .prepare("UPDATE sessions SET spent_usd = spent_usd + ? WHERE hash = ?")
        .bind(costUsd, options.sessionHash),
    );
  }
  statements.push(
    db
      .prepare(
        "INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        randomTokenHex(8),
        options.repo,
        options.pr,
        options.summary.model,
        options.summary.inputTokens,
        options.summary.outputTokens,
        options.summary.cacheCreationTokens,
        options.summary.cacheReadTokens,
        costUsd,
        options.kind,
        options.now,
      ),
  );
  if (options.reservationId) {
    statements.push(
      db
        .prepare("DELETE FROM spend_reservations WHERE id = ?")
        .bind(options.reservationId),
    );
  }
  // D1 batches are transactions: session spend, the repo ledger, and lease
  // deletion either all commit or all roll back. A failed batch therefore
  // leaves the reservation active and cannot create a permanent split tally.
  const results = await db.batch(statements);
  if (results.some((result) => !result.success)) {
    throw new Error("D1 usage settlement batch failed");
  }
  return { costUsd, recorded: true };
}
