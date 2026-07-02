import type { D1Database } from "../d1.ts";
import type { ReviewWorkerEnv } from "../env.ts";
import { sha256Hex } from "../sha256Hex.ts";
import { lookupApiKey } from "../sessions/lookupApiKey.ts";

export interface AuthedSession {
  kind: "session";
  hash: string;
  repo: string;
  pr: number;
  expiresAt: number;
  spendCapUsd: number;
  spentUsd: number;
}

export interface AuthedApiKey {
  kind: "api-key";
  owner: string;
  repos: string[];
}

export type ProxyAuth = AuthedSession | AuthedApiKey;

interface SessionRow {
  hash: string;
  repo: string;
  pr: number;
  expires_at: number;
  spend_cap_usd: number;
  spent_usd: number;
}

/**
 * Resolve the inbound credential to either a session row or an api-key row.
 *
 * Order matters: we try the session table first (the hot path; every action
 * run holds a session) and fall back to api-key lookup. Either way a missing
 * record returns null and the caller answers 401 without leaking which axis
 * failed.
 */
export async function authenticateProxyRequest(
  request: Request,
  env: ReviewWorkerEnv,
  now: number,
): Promise<ProxyAuth | null> {
  const headerKey = request.headers.get("x-api-key") ?? "";
  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const credential = headerKey || bearer;
  if (!credential) return null;

  const hash = await sha256Hex(credential);
  const session = await env.DB
    .prepare(
      "SELECT hash, repo, pr, expires_at, spend_cap_usd, spent_usd FROM sessions WHERE hash = ?",
    )
    .bind(hash)
    .first<SessionRow>();
  if (session) {
    if (session.expires_at <= now) return null;
    return {
      kind: "session",
      hash: session.hash,
      repo: session.repo,
      pr: session.pr,
      expiresAt: session.expires_at,
      spendCapUsd: session.spend_cap_usd,
      spentUsd: session.spent_usd,
    };
  }
  if (credential.startsWith("srk_")) {
    const apiKey = await lookupApiKey(env.DB as D1Database, credential);
    if (!apiKey) return null;
    return { kind: "api-key", owner: apiKey.owner, repos: apiKey.repos };
  }
  return null;
}
