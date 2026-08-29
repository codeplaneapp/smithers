import type { ReviewWorkerEnv } from "../env.ts";
import { jsonError } from "../jsonError.ts";
import { authenticateProxyRequest, type ProxyAuth } from "../proxy/authenticateProxyRequest.ts";
import { timingSafeStringEqual } from "../timingSafeStringEqual.ts";

const MAX_WALKTHROUGH_BYTES = 25 * 1024 * 1024;
export const MAX_PUBLISHES_PER_SESSION = 50;

// 32 chars: 256 % 32 === 0, so byte % 32 is unbiased (base-36 was not).
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz012345";

function newWalkthroughId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ID_ALPHABET[b % 32]).join("");
}

interface WalkthroughRow {
  id: string;
  repo: string;
  pr: number;
  bytes: number;
  created_at: number;
}

interface WalkthroughRepoRow {
  repo: string;
}

interface CountRow {
  count: number;
}

interface PublishAttribution {
  repo: string;
  pr: number;
  sessionHash: string | null;
}

/**
 * /api/walkthroughs — store and manage hosted HTML walkthroughs.
 *
 * Publish accepts three credentials in order of preference:
 *  1. Bearer REVIEW_PUBLISH_TOKEN (legacy, unchanged).
 *  2. A valid session token (action-issued, via x-api-key or Bearer).
 *  3. A valid srk_ API key (operator-issued, via x-api-key or Bearer).
 */
export async function handleWalkthroughs(
  request: Request,
  env: ReviewWorkerEnv,
  url: URL,
  now: number,
): Promise<Response> {
  if (request.method === "POST" && url.pathname === "/api/walkthroughs") {
    return handlePublish(request, env, url, now);
  }
  if (request.method === "GET" && url.pathname === "/api/walkthroughs") {
    return handleHistory(request, env, url, now);
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/walkthroughs/")) {
    return handleDelete(request, env, url, now);
  }
  return jsonError(404, "not found");
}

async function handlePublish(request: Request, env: ReviewWorkerEnv, url: URL, now: number): Promise<Response> {
  const legacyOk = isLegacyPublishToken(request, env);
  let credential: ProxyAuth | null = null;
  if (!legacyOk) {
    credential = await authenticateProxyRequest(request, env, now);
    if (!credential) return jsonError(401, "unauthorized");
  }

  const html = await request.arrayBuffer();
  if (html.byteLength === 0) return jsonError(400, "empty body");
  if (html.byteLength > MAX_WALKTHROUGH_BYTES) return jsonError(413, "walkthrough exceeds 25MB");

  const attribution = publishAttribution(legacyOk ? null : credential);
  if (attribution.sessionHash) {
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM walkthroughs WHERE session_hash = ?")
      .bind(attribution.sessionHash)
      .first<CountRow>();
    const count = Number(countRow?.count ?? 0);
    if (count >= MAX_PUBLISHES_PER_SESSION) {
      return jsonError(429, "publish limit reached for this session");
    }
  }

  const id = newWalkthroughId();
  await env.WALKTHROUGHS.put(`walkthroughs/${id}.html`, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  await env.DB.prepare(
    "INSERT INTO walkthroughs (id, repo, pr, bytes, session_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, attribution.repo, attribution.pr, html.byteLength, attribution.sessionHash, now)
    .run();
  const base = walkthroughBase(env, url);
  return Response.json({ id, url: `${base}/w/${id}` }, { status: 201 });
}

async function handleHistory(request: Request, env: ReviewWorkerEnv, url: URL, now: number): Promise<Response> {
  const credential = await authenticateProxyRequest(request, env, now);
  if (!credential) return jsonError(401, "unauthorized");

  const repo = url.searchParams.get("repo");
  if (!repo) return jsonError(400, "repo query parameter is required");
  if (!canAccessRepo(credential, repo)) return jsonError(403, "forbidden");

  const rows = await env.DB.prepare(
    "SELECT id, repo, pr, bytes, created_at FROM walkthroughs WHERE repo = ? ORDER BY created_at DESC LIMIT 50",
  )
    .bind(repo)
    .all<WalkthroughRow>();
  const base = walkthroughBase(env, url);
  return Response.json({
    walkthroughs: rows.results.map((row) => ({
      id: row.id,
      repo: row.repo,
      pr: row.pr,
      bytes: row.bytes,
      createdAt: row.created_at,
      url: `${base}/w/${row.id}`,
    })),
  });
}

async function handleDelete(request: Request, env: ReviewWorkerEnv, url: URL, now: number): Promise<Response> {
  const id = url.pathname.slice("/api/walkthroughs/".length);
  if (!/^[a-z0-9]{8,32}$/.test(id)) return jsonError(400, "invalid walkthrough id");

  const legacyOk = isLegacyPublishToken(request, env);
  let credential: ProxyAuth | null = null;
  if (!legacyOk) {
    credential = await authenticateProxyRequest(request, env, now);
    if (!credential) return jsonError(401, "unauthorized");
  }

  const row = await env.DB.prepare("SELECT repo FROM walkthroughs WHERE id = ?").bind(id).first<WalkthroughRepoRow>();
  if (!row) return jsonError(404, "not found");
  if (!legacyOk && (!credential || !canAccessRepo(credential, row.repo))) {
    return jsonError(403, "forbidden");
  }

  await env.WALKTHROUGHS.delete(`walkthroughs/${id}.html`);
  await env.DB.prepare("DELETE FROM walkthroughs WHERE id = ?").bind(id).run();
  return Response.json({ deleted: true });
}

function publishAttribution(credential: ProxyAuth | null): PublishAttribution {
  if (!credential) return { repo: "", pr: 0, sessionHash: null };
  if (credential.kind === "session") {
    return { repo: credential.repo, pr: credential.pr, sessionHash: credential.hash };
  }
  return { repo: credential.repos[0] ?? "", pr: 0, sessionHash: null };
}

function canAccessRepo(credential: ProxyAuth, repo: string): boolean {
  if (credential.kind === "session") return credential.repo === repo;
  return credential.repos.includes(repo);
}

function isLegacyPublishToken(request: Request, env: ReviewWorkerEnv): boolean {
  const publishToken = env.REVIEW_PUBLISH_TOKEN ?? "";
  const auth = request.headers.get("authorization") ?? "";
  return Boolean(publishToken && timingSafeStringEqual(auth, `Bearer ${publishToken}`));
}

function walkthroughBase(env: ReviewWorkerEnv, url: URL): string {
  return (env.PUBLIC_BASE_URL ?? url.origin).replace(/\/$/, "");
}
