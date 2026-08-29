import type { D1Database } from "../d1.ts";
import { randomTokenHex } from "../randomTokenHex.ts";
import { sha256Hex } from "../sha256Hex.ts";

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export interface MintedSession {
  token: string;
  hash: string;
  expiresAt: number;
}

/**
 * Issue a session token and record it (hashed) with a fresh spend tally. The
 * quota slot is claimed separately by claimReviewSlot() BEFORE this runs, so a
 * crash between the two charges the quota without a usable session (retryable)
 * rather than leaking inference past the plan.
 */
export async function mintSession(
  db: D1Database,
  repo: string,
  pr: number,
  spendCapUsd: number,
  now: number,
): Promise<MintedSession> {
  const token = `srs_${randomTokenHex(32)}`;
  const hash = await sha256Hex(token);
  const expiresAt = now + SESSION_TTL_MS;
  await db
    .prepare(
      "INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, spent_usd, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(hash, repo, pr, expiresAt, spendCapUsd, now)
    .run();
  return { token, hash, expiresAt };
}
