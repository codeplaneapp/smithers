import type { D1Database } from "../d1.ts";
import { lookupApiKeyByHash } from "./lookupApiKeyByHash.ts";
import { sha256Hex } from "../sha256Hex.ts";

export interface ApiKeyRecord {
  hash: string;
  owner: string;
  repos: string[];
  spendCapUsd: number | null;
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
  return lookupApiKeyByHash(db, hash);
}
