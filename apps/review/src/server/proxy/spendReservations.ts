import type { D1Database } from "../d1.ts";
import { randomTokenHex } from "../randomTokenHex.ts";
import { isPricedAnthropicRequestModel } from "./modelPrices.ts";
import { modelPriceForMetering } from "./recordUsage.ts";

/**
 * A reservation outlives the normal provider request window but cannot strand
 * budget forever if a Worker dies before settlement. Active requests longer
 * than this remain metered, but no longer hold admission capacity.
 */
export const SPEND_RESERVATION_TTL_MS = 2 * 60 * 60 * 1_000;

// Anthropic requires max_tokens. This defensive value keeps a statically priced
// but otherwise malformed request's preflight estimate finite; upstream should
// still reject the malformed body.
const MALFORMED_REQUEST_OUTPUT_TOKENS = 8_192;

export interface SpendEstimate {
  amountUsd: number;
  model: string;
  hasStaticPrice: boolean;
  inputTokenUpperBound: number;
  outputTokenUpperBound: number;
}

export interface SpendReservation extends SpendEstimate {
  id: string;
  expiresAt: number;
}

/**
 * Conservatively bound a valid Messages call from data available before
 * dispatch. One UTF-8 request byte is treated as one input token and charged at
 * the model's most expensive prompt-side rate; max_tokens bounds generated
 * tokens. The result explicitly marks an unknown model as unpriced so the
 * caller can reject it; the high-rate fallback is never dispatch authorization.
 */
export function estimateMessagesSpend(body: ArrayBuffer): SpendEstimate {
  let parsed: { model?: unknown; max_tokens?: unknown } = {};
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as typeof parsed;
  } catch {
    // Leave the model unpriced so the caller rejects malformed JSON before
    // dispatch rather than guessing whether its eventual price is affordable.
  }

  const model = typeof parsed?.model === "string" && parsed.model.length > 0
    ? parsed.model
    : "unknown-model";
  const requestedMaxTokens = parsed?.max_tokens;
  const outputTokenUpperBound = typeof requestedMaxTokens === "number"
    && Number.isSafeInteger(requestedMaxTokens)
    && requestedMaxTokens > 0
    ? requestedMaxTokens
    : MALFORMED_REQUEST_OUTPUT_TOKENS;
  const inputTokenUpperBound = Math.max(1, body.byteLength);
  const price = modelPriceForMetering(model, false);
  const promptRate = Math.max(price.input, price.cacheWrite, price.cacheRead);
  const amountUsd =
    (inputTokenUpperBound * promptRate + outputTokenUpperBound * price.output) / 1_000_000;

  return {
    amountUsd,
    model,
    hasStaticPrice: isPricedAnthropicRequestModel(model),
    inputTokenUpperBound,
    outputTokenUpperBound,
  };
}

/**
 * Atomically admit one upstream call against both budgets. D1 serializes this
 * single conditional INSERT, so concurrent Workers cannot all observe the same
 * unreserved capacity. Expired leases are ignored by the predicate and pruned
 * opportunistically to bound table growth.
 */
export async function reserveSpend(
  db: D1Database,
  options: {
    sessionHash: string | null;
    repo: string;
    repoCapUsd: number;
    estimate: SpendEstimate;
    now: number;
  },
): Promise<SpendReservation | null> {
  if (
    !Number.isFinite(options.repoCapUsd)
    || options.repoCapUsd <= 0
    || !Number.isFinite(options.estimate.amountUsd)
    || options.estimate.amountUsd <= 0
  ) {
    return null;
  }

  await db
    .prepare("DELETE FROM spend_reservations WHERE expires_at <= ?")
    .bind(options.now)
    .run();

  const id = randomTokenHex(16);
  const d = new Date(options.now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const expiresAt = options.now + SPEND_RESERVATION_TTL_MS;
  const result = await db
    .prepare(
      `INSERT INTO spend_reservations
        (id, session_hash, repo, amount_usd, expires_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE
         (
           ? IS NULL
           OR EXISTS (
             SELECT 1
             FROM sessions AS s
             WHERE s.hash = ?
               AND s.spent_usd
                 + COALESCE((
                   SELECT SUM(r.amount_usd)
                   FROM spend_reservations AS r
                   WHERE r.session_hash = ? AND r.expires_at > ?
                 ), 0)
                 + ? <= s.spend_cap_usd
           )
         )
         AND COALESCE((
           SELECT SUM(u.cost_usd)
           FROM usage_events AS u
           WHERE u.repo = ? AND u.created_at >= ?
         ), 0)
           + COALESCE((
             SELECT SUM(r.amount_usd)
             FROM spend_reservations AS r
             WHERE r.repo = ? AND r.expires_at > ?
           ), 0)
           + ? <= ?`,
    )
    .bind(
      id,
      options.sessionHash,
      options.repo,
      options.estimate.amountUsd,
      expiresAt,
      options.now,
      options.sessionHash,
      options.sessionHash,
      options.sessionHash,
      options.now,
      options.estimate.amountUsd,
      options.repo,
      monthStart,
      options.repo,
      options.now,
      options.estimate.amountUsd,
      options.repoCapUsd,
    )
    .run();

  let inserted = result.meta.changes === 1;
  if (result.meta.changes == null) {
    inserted = Boolean(
      await db.prepare("SELECT id FROM spend_reservations WHERE id = ?").bind(id).first(),
    );
  }
  if (!inserted) return null;
  return { id, expiresAt, ...options.estimate };
}

export async function releaseSpendReservation(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM spend_reservations WHERE id = ?").bind(id).run();
}
