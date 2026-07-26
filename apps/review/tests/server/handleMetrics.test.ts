import { describe, expect, test } from "bun:test";
import { createReviewWorker } from "../../src/server/worker.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";

const REPO = "octo/widgets";

function makeWorker() {
  return createReviewWorker({
    jwksUrl: "http://unused",
    anthropicBaseUrl: "http://unused",
    fetchUpstream: fetch,
    now: () => Date.now(),
    waitUntil: () => undefined,
  });
}

describe("GET /metrics", () => {
  test("401 without the metrics bearer", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const res = await worker.fetch(new Request("https://review.test/metrics"), env);
    expect(res.status).toBe(401);
  });

  test("emits Prometheus series for tokens, spend, prs, and quota", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    // Seed: one registered repo, one reviewed PR this month, one usage row.
    await env.DB.prepare(
      "INSERT INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(REPO, "auto", 5, 25, Date.now())
      .run();
    const monthKey = new Date().toISOString().slice(0, 7);
    await env.DB.prepare("INSERT INTO reviewed_prs (repo, pr, month, first_seen_at) VALUES (?, ?, ?, ?)")
      .bind(REPO, 1, monthKey, Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("e1", REPO, 1, "claude-sonnet-4-6", 100, 50, 200, 4000, 0.001, "messages", Date.now())
      .run();
    const res = await worker.fetch(
      new Request("https://review.test/metrics", { headers: { authorization: "Bearer test-metrics" } }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('review_tokens_total{repo="octo/widgets",model="claude-sonnet-4-6",kind="input"} 100');
    expect(body).toContain('review_tokens_total{repo="octo/widgets",model="claude-sonnet-4-6",kind="output"} 50');
    // Cache tokens dominate cache-heavy agent workloads; they must be visible too.
    expect(body).toContain('review_tokens_total{repo="octo/widgets",model="claude-sonnet-4-6",kind="cache_write"} 200');
    expect(body).toContain('review_tokens_total{repo="octo/widgets",model="claude-sonnet-4-6",kind="cache_read"} 4000');
    expect(body).toContain('review_spend_usd_total{repo="octo/widgets",model="claude-sonnet-4-6"}');
    expect(body).toContain('review_prs_reviewed_total{repo="octo/widgets"} 1');
    expect(body).toContain('review_quota_remaining{repo="octo/widgets"} 4');
    // Never-emitted series were removed; stale HELP/TYPE headers must not linger.
    expect(body).not.toContain("review_proxy_errors_total");
    expect(body).not.toContain("review_sessions_total");
  });
});
