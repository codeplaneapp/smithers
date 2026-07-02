import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { jwksCache } from "../../src/server/sessions/jwksCache.ts";
import { createReviewWorker } from "../../src/server/worker.ts";
import type { ReviewWorkerEnv } from "../../src/server/env.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";
import { rsaKeypair, type RsaTestKeypair } from "./helpers/rsaKeypair.ts";
import { serveJwks, type ServedJwks } from "./helpers/serveJwks.ts";
import { signTestJwt } from "./helpers/signTestJwt.ts";

const REPO = "octo/widgets";
const SECOND_REPO = "octo/wrenches";

function baseClaims(repo: string, pr: number, exp: number) {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: "smithers-review",
    exp,
    iat: Math.floor(Date.now() / 1000),
    repository: repo,
    repository_owner: repo.split("/")[0],
    ref: `refs/pull/${pr}/merge`,
  };
}

let keypair: RsaTestKeypair;
let jwks: ServedJwks;

beforeAll(async () => {
  keypair = await rsaKeypair("test-kid-1");
  jwks = serveJwks([keypair.publicJwk]);
});

afterAll(() => {
  jwks.stop();
});

beforeEach(() => {
  jwksCache.clear();
});

async function registerRepo(env: ReviewWorkerEnv, repo: string, prsPerMonth = 3) {
  await env.DB
    .prepare(
      "INSERT INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(repo, "auto", prsPerMonth, 10, Date.now())
    .run();
}

function makeWorker(jwksUrl: string) {
  return createReviewWorker({
    jwksUrl,
    fetchUpstream: fetch,
    now: () => Date.now(),
    anthropicBaseUrl: "http://unused",
    waitUntil: () => undefined,
  });
}

describe("POST /api/sessions (OIDC)", () => {
  test("verifies a valid token and mints a session", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await env.DB
      .prepare(
        "INSERT INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(REPO, "comment", 5, 25, Date.now())
      .run();
    const token = await signTestJwt(keypair, baseClaims(REPO, 42, Math.floor(Date.now() / 1000) + 600));
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oidcToken: token }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.token).toBe("string");
    expect((body.token as string).startsWith("srs_")).toBe(true);
    expect(body.mode).toBe("comment");
    expect(body.plan).toEqual({ prsPerMonth: 5, used: 1 });
    expect(body.quiz).toBe("auto");
    const quota = body.quota as { limit: number; remaining: number; resetsAt: string };
    expect(quota.limit).toBe(5);
    expect(quota.remaining).toBe(4);
    expect(new Date(quota.resetsAt).getTime()).toBeGreaterThan(Date.now());
    expect(body.anthropicBaseUrl).toBe("https://review.test/anthropic");
    expect(body.publishUrl).toBe("https://review.test");
  });

  test("returns the repo's registered quiz mode", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await env.DB
      .prepare(
        "INSERT INTO repos (repo, mode, quiz, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(REPO, "auto", "on", 5, 25, Date.now())
      .run();
    const token = await signTestJwt(keypair, baseClaims(REPO, 42, Math.floor(Date.now() / 1000) + 600));
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oidcToken: token }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.quiz).toBe("on");
  });

  test("rejects a token signed with the wrong key", async () => {
    const env = await buildTestEnv();
    await registerRepo(env, REPO);
    const wrong = await rsaKeypair("attacker-kid");
    const worker = makeWorker(jwks.url);
    const token = await signTestJwt(wrong, baseClaims(REPO, 7, Math.floor(Date.now() / 1000) + 600));
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: token }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  test("rejects a token with the wrong audience", async () => {
    const env = await buildTestEnv();
    await registerRepo(env, REPO);
    const worker = makeWorker(jwks.url);
    const claims = baseClaims(REPO, 7, Math.floor(Date.now() / 1000) + 600);
    claims.aud = "elsewhere";
    const token = await signTestJwt(keypair, claims);
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: token }),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("wrong-audience");
  });

  test("rejects an expired token", async () => {
    const env = await buildTestEnv();
    await registerRepo(env, REPO);
    const worker = makeWorker(jwks.url);
    const token = await signTestJwt(keypair, baseClaims(REPO, 7, Math.floor(Date.now() / 1000) - 60));
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: token }),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("expired");
  });

  test("returns 403 with a registration hint for unknown repos", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    const token = await signTestJwt(keypair, baseClaims("not/registered", 9, Math.floor(Date.now() / 1000) + 600));
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: token }),
      }),
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.hint).toContain("/api/admin/repos");
  });

  test("returns 402 when the monthly quota is spent", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await registerRepo(env, REPO, 2);
    const sign = async (pr: number) =>
      signTestJwt(keypair, baseClaims(REPO, pr, Math.floor(Date.now() / 1000) + 600));
    expect(
      (
        await worker.fetch(
          new Request("https://review.test/api/sessions", {
            method: "POST",
            body: JSON.stringify({ oidcToken: await sign(1) }),
          }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await worker.fetch(
          new Request("https://review.test/api/sessions", {
            method: "POST",
            body: JSON.stringify({ oidcToken: await sign(2) }),
          }),
          env,
        )
      ).status,
    ).toBe(200);
    const blocked = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: await sign(3) }),
      }),
      env,
    );
    expect(blocked.status).toBe(402);
  });

  test("re-reviewing a PR already counted this month does not consume quota", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await registerRepo(env, SECOND_REPO, 1);
    const sign = async (pr: number) =>
      signTestJwt(keypair, baseClaims(SECOND_REPO, pr, Math.floor(Date.now() / 1000) + 600));
    expect(
      (
        await worker.fetch(
          new Request("https://review.test/api/sessions", {
            method: "POST",
            body: JSON.stringify({ oidcToken: await sign(11) }),
          }),
          env,
        )
      ).status,
    ).toBe(200);
    // Same PR — quota stays at 1/1.
    const again = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: await sign(11) }),
      }),
      env,
    );
    expect(again.status).toBe(200);
    const body = (await again.json()) as { plan: { used: number } };
    expect(body.plan.used).toBe(1);
  });

  test("ignores body.pr when the claims are not from a PR context", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await registerRepo(env, REPO, 1);
    // First: legitimate PR review consumes the whole quota.
    const prToken = await signTestJwt(keypair, {
      ...baseClaims(REPO, 42, Math.floor(Date.now() / 1000) + 600),
      event_name: "pull_request",
    });
    const first = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: prToken }),
      }),
      env,
    );
    expect(first.status).toBe(200);
    // Then: a push-triggered token claims the already-reviewed PR via the
    // body. If body.pr were trusted, alreadyReviewed would grant a free
    // session forever; instead the PR number is rejected outright.
    const pushToken = await signTestJwt(keypair, {
      ...baseClaims(REPO, 0, Math.floor(Date.now() / 1000) + 600),
      ref: "refs/heads/main",
      event_name: "push",
    });
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: pushToken, pr: 42 }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("pull request");
  });

  test("accepts body.pr when the claims prove an issue_comment context", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await registerRepo(env, REPO, 3);
    // issue_comment workflows run on the default branch ref: no PR in the
    // ref or pull_request claim, so the body is the only source.
    const token = await signTestJwt(keypair, {
      ...baseClaims(REPO, 0, Math.floor(Date.now() / 1000) + 600),
      ref: "refs/heads/main",
      event_name: "issue_comment",
    });
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: token, pr: 7 }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT pr FROM sessions").first<{ pr: number }>();
    expect(row?.pr).toBe(7);
  });
});
