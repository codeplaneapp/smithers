import type { D1Database } from "../d1.ts";
import type { ApiKeyRecord } from "./lookupApiKey.ts";

interface ApiKeyRow {
  hash: string;
  owner: string;
  repos_json: string;
  spendCapUsd?: number | null;
  created_at: number;
  revoked_at: number | null;
}

/** Resolve a persisted issuing key; unknown and revoked keys both return null. */
export async function lookupApiKeyByHash(db: D1Database, hash: string): Promise<ApiKeyRecord | null> {
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
