import type { ReviewWorkerEnv } from "../env.ts";
import { jsonError } from "../jsonError.ts";
import { monthKey as monthKeyFor } from "../monthKey.ts";
import { repoMonthlyCapUsd } from "../repoMonthlyCapUsd.ts";
import { repoMonthlySpendUsd } from "../repoMonthlySpendUsd.ts";
import { claimReviewSlot } from "./claimReviewSlot.ts";
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

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

type PullRequestResolution = { ok: true; pr: number } | { ok: false; message: string };

function resolveOidcPullRequestNumber(
  claims: { ref?: string; event_name?: string; pull_request?: { number?: number } },
  bodyPr: unknown,
): PullRequestResolution {
  const prFromRef = pullRequestFromOidcRef(claims.ref);
  const prFromClaim = positiveInteger(claims.pull_request?.number);
  const prFromBody = positiveInteger(bodyPr);

  if (prFromRef && prFromClaim && prFromRef !== prFromClaim) {
    return { ok: false, message: "oidc pull request claims do not match" };
  }

  const verifiedPr = prFromRef ?? prFromClaim;
  if (verifiedPr) {
    if (prFromBody && prFromBody !== verifiedPr) {
      return { ok: false, message: "body pull request number does not match oidc claims" };
    }
    return { ok: true, pr: verifiedPr };
  }

  if (claims.event_name === "issue_comment" && prFromBody) {
    return { ok: true, pr: prFromBody };
  }

  return { ok: false, message: "missing pull request number" };
}

/**
 * POST /api/sessions — mint a session from an OIDC token or operator API key.
 *
 * Failure mapping:
 *  - 400 unparseable body / missing auth material
 *  - 401 OIDC fails signature/issuer/audience/expiry, or unknown api key
 *  - 403 repo not registered, api key not authorized for repo, or unscoped api key
 *  - 402 plan quota for this calendar month is spent
 *  - 503 the issuer's JWKS is unreachable, so the token cannot be judged yet
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
    if (!outcome.ok) {
      // A JWKS outage says nothing about the token: answer a retryable 503 so
      // the action can tell an upstream blip from a hard auth failure.
      const status = outcome.reason === "jwks-unavailable" ? 503 : 401;
      return jsonError(status, `oidc: ${outcome.reason}`);
    }
    const claims = outcome.claims;
    if (typeof claims.repository !== "string" || claims.repository.length === 0) {
      return jsonError(401, "oidc: missing repository claim");
    }
    repo = claims.repository;
    const resolvedPr = resolveOidcPullRequestNumber(claims, body.pr);
    if (!resolvedPr.ok) return jsonError(400, resolvedPr.message);
    pr = resolvedPr.pr;
  } else if (typeof body.apiKey === "string" && body.apiKey.length > 0) {
    const record = await lookupApiKey(env.DB, body.apiKey);
    if (!record) return jsonError(401, "unknown api key");
    if (typeof body.repo !== "string" || body.repo.length === 0) {
      return jsonError(400, "missing repo");
    }
    if (typeof body.pr !== "number" || body.pr <= 0) {
      return jsonError(400, "missing pull request number");
    }
    if (record.repos.length === 0) {
      return jsonError(403, "api key is not scoped to any repo; mint a repo-scoped key", { repo: body.repo });
    }
    if (!record.repos.includes(body.repo)) {
      return jsonError(403, "api key not authorized for repo", { repo: body.repo });
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

  // Bound total monthly spend per repo BEFORE claiming a quota slot: the
  // per-session cap resets on every mint, so without this a caller can re-mint
  // sessions for an already-reviewed PR to reset the budget and spend without
  // limit. Rejecting here means a blocked request never consumes a quota slot.
  const monthlyCapUsd = repoMonthlyCapUsd(registration);
  const monthSpendUsd = await repoMonthlySpendUsd(env.DB, repo, now);
  if (monthSpendUsd >= monthlyCapUsd) {
    return jsonError(402, "monthly spend cap exhausted", {
      repo,
      monthlyCapUsd,
      spentUsd: monthSpendUsd,
      month: monthKeyFor(now),
    });
  }

  const quota = await claimReviewSlot(env.DB, repo, pr, registration.prs_per_month, now);
  if (quota.overQuota) {
    return jsonError(402, "monthly PR quota exhausted", {
      repo,
      prsPerMonth: registration.prs_per_month,
      used: quota.used,
      month: quota.monthKey,
    });
  }

  const minted = await mintSession(env.DB, repo, pr, registration.spend_cap_usd, now);

  const used = quota.used;
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
