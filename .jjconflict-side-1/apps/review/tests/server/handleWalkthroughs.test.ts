import { describe, expect, test } from "bun:test";
import type { ReviewWorkerEnv } from "../../src/server/env.ts";
import { sha256Hex } from "../../src/server/sha256Hex.ts";
import { createReviewWorker } from "../../src/server/worker.ts";
import { MAX_PUBLISHES_PER_SESSION } from "../../src/server/walkthroughs/handleWalkthroughs.ts";
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

async function seedSession(
  env: ReviewWorkerEnv,
  { token = "srs_testtoken", repo = "octo/widgets", pr = 7 }: { token?: string; repo?: string; pr?: number } = {},
) {
  const hash = await sha256Hex(token);
  const createdAt = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, spent_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(hash, repo, pr, createdAt + 3_600_000, 25, 0, createdAt)
    .run();
  return { token, hash, repo, pr };
}

async function publishWithToken(
  worker: ReturnType<typeof makeWorker>,
  env: ReviewWorkerEnv,
  token: string,
  html: string,
) {
  return worker.fetch(
    new Request("https://worker.test/api/walkthroughs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/html; charset=utf-8",
      },
      body: html,
    }),
    env,
  );
}

describe("walkthrough publish and serve", () => {
  test("publishes HTML to R2 and serves it from the returned /w/id URL", async () => {
    const env = await buildTestEnv({ PUBLIC_BASE_URL: "https://review.example" });
    const worker = makeWorker();
    const html = "<!doctype html><html><body><h1>Walkthrough</h1></body></html>";

    const publish = await worker.fetch(
      new Request("https://worker.test/api/walkthroughs", {
        method: "POST",
        headers: {
          authorization: "Bearer test-publish",
          "content-type": "text/html; charset=utf-8",
        },
        body: html,
      }),
      env,
    );

    expect(publish.status).toBe(201);
    const body = (await publish.json()) as { id: string; url: string };
    // 32-char alphabet (a-z plus 0-5) so byte % 32 is modulo-unbiased.
    expect(body.id).toMatch(/^[a-z0-5]{12}$/);
    expect(body.url).toBe(`https://review.example/w/${body.id}`);

    const served = await worker.fetch(new Request(body.url), env);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(served.headers.get("x-robots-tag")).toBe("noindex");
    expect(served.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(await served.text()).toBe(html);
  });

  test("returns 404 for a missing walkthrough id", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();

    const served = await worker.fetch(new Request("https://review.test/w/abc12345"), env);

    expect(served.status).toBe(404);
    expect(served.headers.get("content-type")).toContain("text/html");
    const html = await served.text();
    expect(html).toContain("Walkthrough not found");
    expect(html).toContain("smithers review");
  });

  test("records session-attributed walkthrough metadata and returns authorized history", async () => {
    const env = await buildTestEnv({ PUBLIC_BASE_URL: "https://review.example" });
    const worker = makeWorker();
    const session = await seedSession(env);
    const html = "<!doctype html><html><body>session publish</body></html>";

    const publish = await publishWithToken(worker, env, session.token, html);

    expect(publish.status).toBe(201);
    const published = (await publish.json()) as { id: string; url: string };

    const row = await env.DB.prepare("SELECT id, repo, pr, bytes, session_hash FROM walkthroughs WHERE id = ?")
      .bind(published.id)
      .first<{ id: string; repo: string; pr: number; bytes: number; session_hash: string | null }>();
    expect(row).toEqual({
      id: published.id,
      repo: "octo/widgets",
      pr: 7,
      bytes: new TextEncoder().encode(html).byteLength,
      session_hash: session.hash,
    });

    const history = await worker.fetch(
      new Request("https://worker.test/api/walkthroughs?repo=octo/widgets", {
        headers: { authorization: `Bearer ${session.token}` },
      }),
      env,
    );
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as {
      walkthroughs: Array<{ id: string; repo: string; pr: number; bytes: number; createdAt: number; url: string }>;
    };
    expect(historyBody.walkthroughs).toHaveLength(1);
    expect(historyBody.walkthroughs[0]).toMatchObject({
      id: published.id,
      repo: "octo/widgets",
      pr: 7,
      bytes: new TextEncoder().encode(html).byteLength,
      url: `https://review.example/w/${published.id}`,
    });
    expect(typeof historyBody.walkthroughs[0].createdAt).toBe("number");

    const wrongRepo = await worker.fetch(
      new Request("https://worker.test/api/walkthroughs?repo=octo/other", {
        headers: { authorization: `Bearer ${session.token}` },
      }),
      env,
    );
    expect(wrongRepo.status).toBe(403);

    const noAuth = await worker.fetch(new Request("https://worker.test/api/walkthroughs?repo=octo/widgets"), env);
    expect(noAuth.status).toBe(401);
  });

  test("deletes a session-authorized walkthrough from R2 and D1", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const session = await seedSession(env);
    const html = "<!doctype html><html><body>delete me</body></html>";

    const publish = await publishWithToken(worker, env, session.token, html);
    expect(publish.status).toBe(201);
    const published = (await publish.json()) as { id: string; url: string };

    const deleted = await worker.fetch(
      new Request(`https://worker.test/api/walkthroughs/${published.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${session.token}` },
      }),
      env,
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });

    const served = await worker.fetch(new Request(published.url), env);
    expect(served.status).toBe(404);
    expect(served.headers.get("content-type")).toContain("text/html");
    const notFound = await served.text();
    expect(notFound).toContain("Walkthrough not found");
    expect(notFound).toContain("smithers review");

    const row = await env.DB.prepare("SELECT id FROM walkthroughs WHERE id = ?")
      .bind(published.id)
      .first<{ id: string }>();
    expect(row).toBeNull();
  });

  test("enforces a per-session publish limit", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const session = await seedSession(env);

    for (let i = 0; i < MAX_PUBLISHES_PER_SESSION; i++) {
      const publish = await publishWithToken(worker, env, session.token, `<!doctype html><p>${i}</p>`);
      expect(publish.status).toBe(201);
    }

    const overLimit = await publishWithToken(worker, env, session.token, "<!doctype html><p>too many</p>");
    expect(overLimit.status).toBe(429);
    expect(await overLimit.json()).toEqual({ error: "publish limit reached for this session" });
  });
});
