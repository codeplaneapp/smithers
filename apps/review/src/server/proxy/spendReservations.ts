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

// Anthropic documents token counts as estimates that can differ slightly from
// final billed input. Double the preflight count and add a fixed allowance so
// admission remains conservative even when provider-side formatting changes.
const TOKEN_COUNT_SAFETY_MULTIPLIER = 2;
const TOKEN_COUNT_SAFETY_MARGIN = 8_192;

const COUNT_TOKENS_FIELDS = [
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "thinking",
  "cache_control",
  "output_config",
] as const;

export interface SpendEstimate {
  amountUsd: number;
  model: string;
  hasStaticPrice: boolean;
  inputTokenUpperBound: number;
  outputTokenUpperBound: number;
  unsupportedBillingFeature: string | null;
}

export interface SpendReservation extends SpendEstimate {
  id: string;
  expiresAt: number;
}

export interface PreparedMessagesRequest {
  /** Canonical body forwarded to Messages creation. */
  body: ArrayBuffer;
  /** Count-token request when provider-side expansion can exceed JSON bytes. */
  countTokensBody: ArrayBuffer | null;
}

function encodeJson(value: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function parseObjectBody(body: ArrayBuffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Make the two provider defaults that can select premium behavior explicit.
 * Count rich/provider-expanded inputs before admission; plain text remains
 * safely bounded by its UTF-8 byte length because one byte per token is already
 * conservative for caller-supplied text.
 */
export function prepareMessagesRequest(body: ArrayBuffer): PreparedMessagesRequest {
  const parsed = parseObjectBody(body);
  if (!parsed) return { body, countTokensBody: null };

  if (!("service_tier" in parsed)) parsed.service_tier = "standard_only";
  if (!("inference_geo" in parsed)) parsed.inference_geo = "global";

  let needsTokenCount = Array.isArray(parsed.tools) && parsed.tools.length > 0;
  const pending: unknown[] = [parsed.messages, parsed.system, parsed.output_config, parsed.thinking];
  while (pending.length > 0 && !needsTokenCount) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.type === "string" && record.type !== "text") {
      needsTokenCount = true;
      break;
    }
    for (const child of Object.values(record)) pending.push(child);
  }

  const normalizedBody = encodeJson(parsed);
  if (!needsTokenCount) return { body: normalizedBody, countTokensBody: null };

  const countInput: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of COUNT_TOKENS_FIELDS) {
    if (Object.hasOwn(parsed, field)) countInput[field] = parsed[field];
  }
  return { body: normalizedBody, countTokensBody: encodeJson(countInput) };
}

/**
 * Conservatively bound a valid Messages call from data available before
 * dispatch. One UTF-8 request byte is treated as one input token and charged at
 * the model's most expensive prompt-side rate; max_tokens bounds generated
 * tokens. The result explicitly marks an unknown model as unpriced so the
 * caller can reject it; the high-rate fallback is never dispatch authorization.
 */
function unsupportedBillingFeature(parsed: Record<string, unknown>): string | null {
  if ("inference_geo" in parsed && parsed.inference_geo !== "global") {
    return "inference_geo";
  }
  if ("speed" in parsed) return "speed";
  if (
    "service_tier" in parsed
    && parsed.service_tier !== "standard_only"
  ) {
    return "service_tier";
  }
  if (
    Array.isArray(parsed.tools)
    && parsed.tools.some((tool) => (
      typeof tool === "object"
      && tool !== null
      && typeof (tool as { type?: unknown }).type === "string"
    ))
  ) {
    return "server_tool";
  }
  if ("mcp_servers" in parsed) return "mcp_servers";
  if ("container" in parsed) return "container";

  // Cache controls may occur at the top level or inside system/message/tool
  // content. Walk iteratively so a deeply nested but valid JSON request cannot
  // overflow the JavaScript stack while we enforce the billing boundary.
  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    for (const [key, child] of Object.entries(value)) {
      if (
        key === "source"
        && typeof child === "object"
        && child !== null
        && (child as { type?: unknown }).type === "url"
      ) {
        // A mutable remote object can be small during token preflight and much
        // larger during Messages creation, defeating any reservation bound.
        return "url_source";
      }
      if (key === "cache_control" && typeof child === "object" && child !== null) {
        const ttl = (child as { ttl?: unknown }).ttl;
        if (ttl !== undefined && ttl !== "5m") return "cache_control.ttl";
      }
      pending.push(child);
    }
  }
  return null;
}

export function estimateMessagesSpend(
  body: ArrayBuffer,
  atMs = Date.now(),
  countedInputTokens?: number,
): SpendEstimate {
  // Leave malformed input unpriced so the caller rejects it before dispatch
  // rather than guessing whether its eventual price is affordable.
  const parsed = parseObjectBody(body) ?? {};

  const model = typeof parsed.model === "string" && parsed.model.length > 0
    ? parsed.model
    : "unknown-model";
  const requestedMaxTokens = parsed?.max_tokens;
  const outputTokenUpperBound = typeof requestedMaxTokens === "number"
    && Number.isSafeInteger(requestedMaxTokens)
    && requestedMaxTokens > 0
    ? requestedMaxTokens
    : MALFORMED_REQUEST_OUTPUT_TOKENS;
  const countedInputUpperBound = typeof countedInputTokens === "number"
    && Number.isSafeInteger(countedInputTokens)
    && countedInputTokens >= 0
    ? Math.min(
      Number.MAX_SAFE_INTEGER,
      countedInputTokens * TOKEN_COUNT_SAFETY_MULTIPLIER + TOKEN_COUNT_SAFETY_MARGIN,
    )
    : 0;
  const inputTokenUpperBound = Math.max(1, body.byteLength, countedInputUpperBound);
  const price = modelPriceForMetering(model, false, atMs);
  const promptRate = Math.max(price.input, price.cacheWrite, price.cacheRead);
  const amountUsd =
    (inputTokenUpperBound * promptRate + outputTokenUpperBound * price.output) / 1_000_000;

  return {
    amountUsd,
    model,
    hasStaticPrice: isPricedAnthropicRequestModel(model),
    inputTokenUpperBound,
    outputTokenUpperBound,
    unsupportedBillingFeature: unsupportedBillingFeature(parsed),
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
