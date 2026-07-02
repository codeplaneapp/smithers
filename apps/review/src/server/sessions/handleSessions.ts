import type { ReviewWorkerEnv } from "../env.ts";
import { jsonError } from "../jsonError.ts";
import { checkQuota } from "./checkQuota.ts";
import { lookupApiKey } from "./lookupApiKey.ts";
import { lookupRepo } from "./lookupRepo.ts";
import { mintSession } from "./mintSession.ts";
import { verifyOidc } from "./verifyOidc.ts";

export interface HandleSessionsDeps {
  jwksUrl: string;
  fetchUpstream: typeof fetch;
  now: () => number;
}

interface SessionRequestBody {
  oidcToken?: unknown;
  apiKey?: unknown;
  repo?: unknown;
  pr?: unknown;
}

function pullRequestFromOidcRef(ref?: string): number | null {
  if (!ref) return null;
  const m = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(ref);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * POST /api/sessions — mint a session from an OIDC token or operator API key.
 *
 * Failure mapping:
 *  - 400 unparseable body / missing auth material
 *  - 401 OIDC fails signature/issuer/audience/expiry, or unknown api key
 *  - 403 repo not registered, or api key not authorized for repo
 *  - 402 plan quota for this calendar month is spent
 */
export async function handleSessions(
  request: Request,
  env: ReviewWorkerEnv,
  deps: HandleSessionsDeps,
  origin: string,
): Promise<Response> {
  let body: SessionRequestBody;
  try {
    body = (await request.json()) as SessionRequestBody;
  } catch {
    return jsonError(400, "invalid JSON body");
  }
  const now = deps.now();

  let repo: string;
  let pr: number;

  if (typeof body.oidcToken === "string" && body.oidcToken.length > 0) {
    const outcome = await verifyOidc(body.oidcToken, deps.jwksUrl, now, deps.fetchUpstream);
    if (!outcome.ok) return jsonError(401, `oidc: ${outcome.reason}`);
    const claims = outcome.claims;
    if (typeof claims.repository !== "string" || claims.repository.length === 0) {
      return jsonError(401, "oidc: missing repository claim");
    }
    repo = claims.repository;
    const prFromRef = pullRequestFromOidcRef(claims.ref);
    const prFromClaim = typeof claims.pull_request?.number === "number" ? claims.pull_request.number : null;
    // The body is caller-controlled; only accept its PR number when the
    // verified claims prove a PR context. Otherwise a push-triggered token
    // could claim an already-reviewed PR and dodge the monthly quota.
    const prContextEvents = new Set(["pull_request", "pull_request_target", "issue_comment"]);
    const prFromBody =
      prContextEvents.has(claims.event_name ?? "") && typeof body.pr === "number" ? body.pr : null;
    pr = prFromRef ?? prFromClaim ?? prFromBody ?? 0;
    if (!pr || pr <= 0) return jsonError(400, "missing pull request number");
  } else if (typeof body.apiKey === "string" && body.apiKey.length > 0) {
    const record = await lookupApiKey(env.DB, body.apiKey);
    if (!record) return jsonError(401, "unknown api key");
    if (typeof body.repo !== "string" || body.repo.length === 0) {
      return jsonError(400, "missing repo");
    }
    if (typeof body.pr !== "number" || body.pr <= 0) {
      return jsonError(400, "missing pull request number");
    }
    if (record.repos.length > 0 && !record.repos.includes(body.repo)) {
      return jsonError(403, "api key not authorized for repo");
    }
    repo = body.repo;
    pr = body.pr;
  } else {
    return jsonError(400, "expected oidcToken or apiKey");
  }

  const registration = await lookupRepo(env.DB, repo);
  if (!registration) {
    return jsonError(403, "repo not registered", {
      hint: "operator must POST /api/admin/repos to register this repo",
      repo,
    });
  }

  const quota = await checkQuota(env.DB, repo, pr, registration.prs_per_month, now);
  if (quota.overQuota) {
    return jsonError(402, "monthly PR quota exhausted", {
      repo,
      prsPerMonth: registration.prs_per_month,
      used: quota.used,
      month: quota.monthKey,
    });
  }

  const minted = await mintSession(
    env.DB,
    repo,
    pr,
    registration.spend_cap_usd,
    quota.monthKey,
    quota.alreadyReviewed,
    now,
  );

  const used = quota.alreadyReviewed ? quota.used : quota.used + 1;
  const nowDate = new Date(now);
  const resetsAt = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1)).toISOString();
  return Response.json({
    token: minted.token,
    expiresAt: minted.expiresAt,
    mode: registration.mode,
    quiz: registration.quiz,
    plan: {
      prsPerMonth: registration.prs_per_month,
      used,
    },
    // Quota detail the action surfaces in its PR status comment.
    quota: {
      limit: registration.prs_per_month,
      remaining: Math.max(0, registration.prs_per_month - used),
      resetsAt,
    },
    anthropicBaseUrl: `${origin}/anthropic`,
    publishUrl: origin,
  });
}
