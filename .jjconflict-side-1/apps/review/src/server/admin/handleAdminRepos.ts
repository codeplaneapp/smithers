import type { ReviewWorkerEnv } from "../env.ts";
import { jsonError } from "../jsonError.ts";
import { monthKey } from "../monthKey.ts";
import { timingSafeStringEqual } from "../timingSafeStringEqual.ts";

interface UpsertBody {
  repo?: unknown;
  mode?: unknown;
  quiz?: unknown;
  prsPerMonth?: unknown;
  spendCapUsd?: unknown;
}

interface RepoListRow {
  repo: string;
  mode: string;
  quiz: string;
  prs_per_month: number;
  spend_cap_usd: number;
  created_at: number;
}

interface UsageRow {
  repo: string;
  cost_usd: number;
}

interface MonthPrsRow {
  repo: string;
  c: number;
}

/**
 * POST /api/admin/repos    upsert a registration
 * GET  /api/admin/repos    list registrations with month-to-date usage
 */
export async function handleAdminRepos(request: Request, env: ReviewWorkerEnv, now: number): Promise<Response> {
  const expected = `Bearer ${env.ADMIN_TOKEN ?? ""}`;
  const got = request.headers.get("authorization") ?? "";
  if (!env.ADMIN_TOKEN || !timingSafeStringEqual(got, expected)) {
    return jsonError(401, "unauthorized");
  }
  if (request.method === "POST") {
    let body: UpsertBody;
    try {
      body = (await request.json()) as UpsertBody;
    } catch {
      return jsonError(400, "invalid JSON body");
    }
    if (typeof body.repo !== "string" || body.repo.length === 0) return jsonError(400, "repo required");
    if (body.mode !== "auto" && body.mode !== "comment") return jsonError(400, "mode must be auto|comment");
    const quiz = body.quiz === undefined ? "auto" : body.quiz;
    if (quiz !== "off" && quiz !== "auto" && quiz !== "on") return jsonError(400, "quiz must be off|auto|on");
    if (typeof body.prsPerMonth !== "number" || body.prsPerMonth <= 0) return jsonError(400, "prsPerMonth must be > 0");
    if (typeof body.spendCapUsd !== "number" || body.spendCapUsd <= 0) return jsonError(400, "spendCapUsd must be > 0");
    await env.DB.prepare(
      `INSERT INTO repos (repo, mode, quiz, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo) DO UPDATE SET mode = excluded.mode, quiz = excluded.quiz, prs_per_month = excluded.prs_per_month, spend_cap_usd = excluded.spend_cap_usd`,
    )
      .bind(body.repo, body.mode, quiz, body.prsPerMonth, body.spendCapUsd, now)
      .run();
    return Response.json(
      { repo: body.repo, mode: body.mode, quiz, prsPerMonth: body.prsPerMonth, spendCapUsd: body.spendCapUsd },
      { status: 200 },
    );
  }
  if (request.method === "GET") {
    const month = monthKey(now);
    const repos = await env.DB.prepare(
      "SELECT repo, mode, quiz, prs_per_month, spend_cap_usd, created_at FROM repos ORDER BY repo",
    ).all<RepoListRow>();
    const usage = await env.DB.prepare(
      "SELECT repo, SUM(cost_usd) AS cost_usd FROM usage_events WHERE created_at >= ? GROUP BY repo",
    )
      .bind(new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)).getTime())
      .all<UsageRow>();
    const prsThisMonth = await env.DB.prepare(
      "SELECT repo, COUNT(*) AS c FROM reviewed_prs WHERE month = ? GROUP BY repo",
    )
      .bind(month)
      .all<MonthPrsRow>();
    const usageByRepo = new Map(usage.results.map((r) => [r.repo, r.cost_usd ?? 0]));
    const prsByRepo = new Map(prsThisMonth.results.map((r) => [r.repo, r.c]));
    return Response.json({
      month,
      repos: repos.results.map((r) => ({
        repo: r.repo,
        mode: r.mode,
        quiz: r.quiz,
        prsPerMonth: r.prs_per_month,
        spendCapUsd: r.spend_cap_usd,
        createdAt: r.created_at,
        usage: {
          spendUsd: usageByRepo.get(r.repo) ?? 0,
          prsThisMonth: prsByRepo.get(r.repo) ?? 0,
        },
      })),
    });
  }
  return jsonError(405, "method not allowed");
}
