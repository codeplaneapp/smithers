import type { D1Database } from "../d1.ts";
import { sha256Hex } from "../sha256Hex.ts";

export interface ApiKeyRecord {
  hash: string;
  owner: string;
  repos: string[];
  spendCapUsd: number | null;
  created_at: number;
  revoked_at: number | null;
}

interface ApiKeyRow {
  hash: string;
  owner: string;
  repos_json: string;
  spendCapUsd?: number | null;
  created_at: number;
  revoked_at: number | null;
}

/**
 * Resolve an operator-minted `srk_` key to its stored record. Returns null if
 * the key is unknown OR revoked — callers should treat both identically so we
 * never leak which keys exist.
 */
export async function lookupApiKey(db: D1Database, key: string): Promise<ApiKeyRecord | null> {
  const hash = await sha256Hex(key);
  const row = await db
    .prepare(
      "SELECT hash, owner, repos_json, spend_cap_usd AS spendCapUsd, created_at, revoked_at FROM api_keys WHERE hash = ? AND revoked_at IS NULL",
    )
    .bind(hash)
    .first<ApiKeyRow>();
  if (!row) return null;
  let repos: string[] = [];
  try {
    const parsed = JSON.parse(row.repos_json);
    if (Array.isArray(parsed)) repos = parsed.filter((r): r is string => typeof r === "string");
  } catch {
    repos = [];
  }
  return {
    hash: row.hash,
    owner: row.owner,
    repos,
    spendCapUsd: row.spendCapUsd ?? null,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}
