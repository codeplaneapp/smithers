import { describe, expect, test } from "bun:test";
import type { BugWorkerEnv } from "../src/worker.ts";
import { createBugWorker } from "../src/worker.ts";
import { memoryKv } from "./helpers/memoryKv.ts";

const ADMIN = "test-admin-secret";

function makeEnv(now?: () => number): BugWorkerEnv & { BUGS: ReturnType<typeof memoryKv> } {
  return {
    BUGS: memoryKv(now),
    BUG_ADMIN_TOKEN: ADMIN,
    PUBLIC_BASE_URL: "https://bug.smithers.sh",
  };
}

function postBug(body: unknown, ip = "203.0.113.7"): Request {
  return new Request("https://bug.smithers.sh/api/bugs", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("bug worker", () => {
  test("healthz", async () => {
    const worker = createBugWorker();
    const res = await worker.fetch(new Request("https://bug.smithers.sh/healthz"), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("valid post returns id + url and stores the report in KV", async () => {
    const worker = createBugWorker();
    const env = makeEnv();
    const res = await worker.fetch(
      postBug({
        summary: "engine crashed on resume",
        version: "1.0.0-rc.0",
        platform: "darwin-arm64",
        digest: { runId: "r-123", status: "failed" },
        extraLooseField: true,
      }),
      env,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const { id, url } = (await res.json()) as { id: string; url: string };
    expect(id.length).toBeGreaterThan(10);
    expect(url).toBe(`https://bug.smithers.sh/api/bugs/${id}`);

    const stored = await env.BUGS.get(`bug:${id}`);
    expect(stored).not.toBeNull();
    const record = JSON.parse(stored!);
    expect(record.report.summary).toBe("engine crashed on resume");
    expect(record.report.digest.runId).toBe("r-123");
    expect(record.report.extraLooseField).toBe(true);
  });

  test("null optional fields are accepted", async () => {
    const worker = createBugWorker();
    const env = makeEnv();
    const res = await worker.fetch(
      postBug({ summary: "report without a run", version: null, platform: null, digest: null }),
      env,
    );
    expect(res.status).toBe(201);
  });

  test("invalid payload (missing summary) rejected 400", async () => {
    const worker = createBugWorker();
    const res = await worker.fetch(postBug({ version: "1.0.0-rc.0" }), makeEnv());
    expect(res.status).toBe(400);
  });

  test("non-JSON body rejected 400", async () => {
    const worker = createBugWorker();
    const res = await worker.fetch(postBug("not json {{{"), makeEnv());
    expect(res.status).toBe(400);
  });

  test("oversized payload rejected 413", async () => {
    const worker = createBugWorker();
    const res = await worker.fetch(postBug({ summary: "big", detail: "x".repeat(256 * 1024 + 1) }), makeEnv());
    expect(res.status).toBe(413);
  });

  test("declared content-length over the cap is rejected 413 before the body is read", async () => {
    const worker = createBugWorker();
    const request = new Request("https://bug.smithers.sh/api/bugs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.99",
        "content-length": String(256 * 1024 + 1),
      },
      body: JSON.stringify({ summary: "big" }),
    });
    const res = await worker.fetch(request, makeEnv());
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload too large", maxBytes: 256 * 1024 });
  });

  test("oversized streamed body with no content-length is rejected 413 by the stream counter", async () => {
    const worker = createBugWorker();
    const oversized = new TextEncoder().encode(JSON.stringify({ summary: "big", detail: "x".repeat(256 * 1024 + 1) }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Emit in chunks so the running byte count crosses the cap mid-stream.
        for (let offset = 0; offset < oversized.byteLength; offset += 64 * 1024) {
          controller.enqueue(oversized.subarray(offset, offset + 64 * 1024));
        }
        controller.close();
      },
    });
    const request = new Request("https://bug.smithers.sh/api/bugs", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.42" },
      body: stream,
      // No content-length header: the size gate must come from stream-counting.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.headers.get("content-length")).toBeNull();

    const res = await worker.fetch(request, makeEnv());
    expect(res.status).toBe(413);
  });

  test('post with an empty (null) body reads as "" and is rejected 400 as non-JSON', async () => {
    const worker = createBugWorker();
    const request = new Request("https://bug.smithers.sh/api/bugs", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.55" },
    });
    expect(request.body).toBeNull();
    const res = await worker.fetch(request, makeEnv());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body must be JSON" });
  });

  test("rate limit trips at 21 posts from one IP within the hour", async () => {
    let clock = Date.parse("2026-07-02T10:00:00Z");
    const worker = createBugWorker({ now: () => clock });
    const env = makeEnv(() => clock);
    for (let i = 0; i < 20; i++) {
      const res = await worker.fetch(postBug({ summary: `bug ${i}` }), env);
      expect(res.status).toBe(201);
    }
    const blocked = await worker.fetch(postBug({ summary: "bug 21" }), env);
    expect(blocked.status).toBe(429);

    // Different IP is unaffected.
    const otherIp = await worker.fetch(postBug({ summary: "other" }, "198.51.100.9"), env);
    expect(otherIp.status).toBe(201);

    // Next hour bucket resets the counter.
    clock += 61 * 60 * 1000;
    const nextHour = await worker.fetch(postBug({ summary: "next hour" }), env);
    expect(nextHour.status).toBe(201);
  });

  test("admin GET requires x-bug-admin and returns the stored record", async () => {
    const worker = createBugWorker();
    const env = makeEnv();
    const posted = await worker.fetch(postBug({ summary: "gated" }), env);
    const { id } = (await posted.json()) as { id: string };

    const noHeader = await worker.fetch(new Request(`https://bug.smithers.sh/api/bugs/${id}`), env);
    expect(noHeader.status).toBe(401);

    const wrong = await worker.fetch(
      new Request(`https://bug.smithers.sh/api/bugs/${id}`, { headers: { "x-bug-admin": "nope" } }),
      env,
    );
    expect(wrong.status).toBe(401);

    const ok = await worker.fetch(
      new Request(`https://bug.smithers.sh/api/bugs/${id}`, { headers: { "x-bug-admin": ADMIN } }),
      env,
    );
    expect(ok.status).toBe(200);
    const record = (await ok.json()) as { id: string; report: { summary: string } };
    expect(record.id).toBe(id);
    expect(record.report.summary).toBe("gated");
  });

  test("admin GET 404s for an unknown id", async () => {
    const worker = createBugWorker();
    const res = await worker.fetch(
      new Request("https://bug.smithers.sh/api/bugs/doesnotexist", { headers: { "x-bug-admin": ADMIN } }),
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });

  test("unmatched route falls through to 404", async () => {
    const worker = createBugWorker();
    const res = await worker.fetch(new Request("https://bug.smithers.sh/nope", { method: "DELETE" }), makeEnv());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("OPTIONS preflight allows POST from anywhere", async () => {
    const worker = createBugWorker();
    const res = await worker.fetch(new Request("https://bug.smithers.sh/api/bugs", { method: "OPTIONS" }), makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
