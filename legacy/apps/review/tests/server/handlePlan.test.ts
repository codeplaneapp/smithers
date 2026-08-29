import { describe, expect, test } from "bun:test";
import type { ReviewWorkerEnv } from "../../src/server/env.ts";
import { monthKey } from "../../src/server/monthKey.ts";
import { sha256Hex } from "../../src/server/sha256Hex.ts";
import { createReviewWorker } from "../../src/server/worker.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";

const NOW = Date.UTC(2026, 6, 8, 12, 0, 0);

function makeWorker(now = NOW) {
  return createReviewWorker({
    jwksUrl: "http://unused",
    anthropicBaseUrl: "http://unused",
    fetchUpstream: fetch,
    now: () => now,
    waitUntil: () => undefined,
  });
}

async function seedSession(
  env: ReviewWorkerEnv,
  {
    token = "srs_testtoken",
    repo = "octo/widgets",
    pr = 7,
    now = NOW,
  }: { token?: string; repo?: string; pr?: number; now?: number } = {},
) {
  const hash = await sha256Hex(token);
  await env.DB.prepare(
    "INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, spent_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(hash, repo, pr, now + 3_600_000, 25, 0, now)
    .run();
  return { token, hash, repo, pr };
}

describe("/api/plan", () => {
  test("returns plan and month-to-date quota for a registered session repo", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const session = await seedSession(env);
    const month = monthKey(NOW);
    const monthStart = Date.UTC(2026, 6, 1);

    await env.DB.prepare(
      "INSERT INTO repos (repo, mode, quiz, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("octo/widgets", "comment", "on", 12, 3.5, NOW)
      .run();
    await env.DB.prepare("INSERT INTO reviewed_prs (repo, pr, month, first_seen_at) VALUES (?, ?, ?, ?)")
      .bind("octo/widgets", 1, month, NOW - 1_000)
      .run();
    await env.DB.prepare("INSERT INTO reviewed_prs (repo, pr, month, first_seen_at) VALUES (?, ?, ?, ?)")
      .bind("octo/widgets", 2, month, NOW)
      .run();
    await env.DB.prepare("INSERT INTO reviewed_prs (repo, pr, month, first_seen_at) VALUES (?, ?, ?, ?)")
      .bind("octo/widgets", 3, "2026-06", NOW)
      .run();
    await env.DB.prepare("INSERT INTO reviewed_prs (repo, pr, month, first_seen_at) VALUES (?, ?, ?, ?)")
      .bind("octo/other", 1, month, NOW)
      .run();
    await env.DB.prepare(
      "INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("usage-1", "octo/widgets", 1, "claude-sonnet-4-6", 1000, 200, 1.25, "review", monthStart + 1_000)
      .run();
    await env.DB.prepare(
      "INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("usage-2", "octo/widgets", 2, "claude-sonnet-4-6", 2000, 300, 0.75, "review", NOW)
      .run();
    await env.DB.prepare(
      "INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("usage-old", "octo/widgets", 3, "claude-sonnet-4-6", 1000, 200, 9, "review", monthStart - 1)
      .run();

    const res = await worker.fetch(
      new Request("https://review.test/api/plan", {
        headers: { authorization: `Bearer ${session.token}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repo: "octo/widgets",
      plan: {
        mode: "comment",
        quiz: "on",
        prsPerMonth: 12,
        spendCapUsd: 3.5,
      },
      quota: {
        month,
        prsUsed: 2,
        prsPerMonth: 12,
        monthlyCapUsd: 42,
        monthlySpendUsd: 2,
      },
    });
  });

  test("returns 401 without a credential", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();

    const res = await worker.fetch(new Request("https://review.test/api/plan"), env);

    expect(res.status).toBe(401);
  });

  test("returns 404 when a session repo is not registered", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const session = await seedSession(env);

    const res = await worker.fetch(
      new Request("https://review.test/api/plan", {
        headers: { authorization: `Bearer ${session.token}` },
      }),
      env,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "repo not registered" });
  });

  test("returns 403 when an api key requests a repo it does not own", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const apiKey = "srk_testkey";
    const hash = await sha256Hex(apiKey);

    await env.DB.prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(hash, "octo", JSON.stringify(["octo/widgets"]), NOW)
      .run();

    const res = await worker.fetch(
      new Request("https://review.test/api/plan?repo=octo/other", {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
      env,
    );

    expect(res.status).toBe(403);
  });
});
