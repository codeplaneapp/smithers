import { describe, expect, test } from "bun:test";
import { createReviewWorker } from "../../src/server/worker.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";

function makeWorker() {
  return createReviewWorker({
    jwksUrl: "http://unused",
    anthropicBaseUrl: "http://unused",
    fetchUpstream: fetch,
    now: () => Date.now(),
    waitUntil: () => undefined,
  });
}

describe("admin endpoints", () => {
  test("repo upsert + list round trip", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const upsert = await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ repo: "octo/widgets", mode: "auto", prsPerMonth: 10, spendCapUsd: 25 }),
      }),
      env,
    );
    expect(upsert.status).toBe(200);
    const list = await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        headers: { authorization: "Bearer test-admin" },
      }),
      env,
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { repos: Array<{ repo: string; mode: string; prsPerMonth: number }> };
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0]).toMatchObject({ repo: "octo/widgets", mode: "auto", quiz: "auto", prsPerMonth: 10 });
  });

  test("repo upsert accepts an explicit quiz mode and rejects invalid values", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const upsert = await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ repo: "octo/widgets", mode: "auto", quiz: "on", prsPerMonth: 10, spendCapUsd: 25 }),
      }),
      env,
    );
    expect(upsert.status).toBe(200);
    expect(((await upsert.json()) as { quiz: string }).quiz).toBe("on");
    const bad = await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({
          repo: "octo/widgets",
          mode: "auto",
          quiz: "sometimes",
          prsPerMonth: 10,
          spendCapUsd: 25,
        }),
      }),
      env,
    );
    expect(bad.status).toBe(400);
  });

  test("mints an api key and the key authenticates a session", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ repo: "octo/widgets", mode: "comment", prsPerMonth: 5, spendCapUsd: 25 }),
      }),
      env,
    );
    const mint = await worker.fetch(
      new Request("https://review.test/api/admin/keys", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ owner: "octo", repos: ["octo/widgets"] }),
      }),
      env,
    );
    expect(mint.status).toBe(201);
    const minted = (await mint.json()) as { key: string };
    expect(minted.key.startsWith("srk_")).toBe(true);

    const session = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: minted.key, repo: "octo/widgets", pr: 17 }),
      }),
      env,
    );
    expect(session.status).toBe(200);
    const body = (await session.json()) as { token: string; mode: string };
    expect(body.token.startsWith("srs_")).toBe(true);
    expect(body.mode).toBe("comment");
  });

  test("mints an api key with spendCapUsd and rejects non-positive values", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const mint = await worker.fetch(
      new Request("https://review.test/api/admin/keys", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ owner: "octo", repos: ["octo/widgets"], spendCapUsd: 3.25 }),
      }),
      env,
    );
    expect(mint.status).toBe(201);
    const body = (await mint.json()) as { key: string; spendCapUsd: number };
    expect(body.key.startsWith("srk_")).toBe(true);
    expect(body.spendCapUsd).toBe(3.25);

    const bad = await worker.fetch(
      new Request("https://review.test/api/admin/keys", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ owner: "octo", repos: ["octo/widgets"], spendCapUsd: 0 }),
      }),
      env,
    );
    expect(bad.status).toBe(400);
  });

  test("rejects an unscoped (empty-repos) api key on session mint", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const upsert = await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ repo: "octo/widgets", mode: "comment", prsPerMonth: 5, spendCapUsd: 25 }),
      }),
      env,
    );
    expect(upsert.status).toBe(200);

    const mint = await worker.fetch(
      new Request("https://review.test/api/admin/keys", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ owner: "octo", repos: [] }),
      }),
      env,
    );
    expect(mint.status).toBe(201);
    const minted = (await mint.json()) as { key: string };
    expect(minted.key.startsWith("srk_")).toBe(true);

    const session = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: minted.key, repo: "octo/widgets", pr: 17 }),
      }),
      env,
    );
    expect(session.status).toBe(403);
    const body = (await session.json()) as { error: string };
    expect((body.error as string).includes("not scoped")).toBe(true);

    const sessions = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    const reviewed = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviewed_prs WHERE repo = ?")
      .bind("octo/widgets")
      .first<{ n: number }>();
    expect(reviewed?.n).toBe(0);
  });

  test("rejects unauthorized callers", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const res = await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        method: "POST",
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
