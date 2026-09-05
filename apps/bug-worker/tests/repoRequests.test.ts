import { describe, expect, test } from "bun:test";
import { createBugWorker } from "../src/worker.ts";
import { repoName } from "../src/repoRequests.ts";
import { memoryKv } from "./helpers/memoryKv.ts";
import type { BugWorkerEnv } from "../src/env.ts";

function fixture() {
  const env: BugWorkerEnv = { BUGS: memoryKv(), BUG_ADMIN_TOKEN: "test-admin", RESEND_API_KEY: "test-key", NOTIFICATION_FROM: "Smithers <test@example.com>" };
  const calls: { url: string; init?: RequestInit }[] = [];
  let emailStatus = 200;
  let github: unknown = { private: false, license: { spdx_id: "MIT" } };
  const worker = createBugWorker({ now: () => 1788500000000, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return Response.json(url.includes("api.github.com") ? github : { id: "email-1" }, { status: url.includes("resend") ? emailStatus : 200 });
  }) as typeof fetch });
  const call = (body?: unknown, route = "", admin = false) => worker.fetch(new Request(`https://bug.smithers.sh/api/repo-requests${route}`, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(admin ? { "x-bug-admin": "test-admin" } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const complete = () => call({ repo: "owner/repo", appUrl: "https://app.smithers.sh/repos/owner/repo" }, "/complete", true);
  return { env, worker, calls, call, complete, emailStatus: (value: number) => { emailStatus = value; }, github: (value: unknown) => { github = value; } };
}

describe("public repository requests", () => {
  test("normalizes roots and rejects foreign hosts, paths, credentials, and invalid names", () => {
    expect(repoName(" https://github.com/Owner/Repo.git/ ")).toBe("owner/repo");
    for (const value of ["https://evil.com/owner/repo", "https://github.com/owner/repo/tree/main", "https://github.com@evil.com/a/b", "owner/..", "owner/repo?x=1", null]) expect(repoName(value)).toBeNull();
  });
  test("persists smithering, deduplicates repo and emails, and keeps email private", async () => {
    const f = fixture();
    const response = await f.call({ repo: "https://github.com/Owner/Repo", email: "Me@example.com" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ repo: { name: "owner/repo", status: "smithering", appUrl: null }, subscribed: true });
    await f.call({ repo: "owner/repo.git", email: "me@example.com" });
    expect(f.calls.length).toBe(1);
    const listing = await (await f.call()).text();
    expect(listing).toContain('"smithering"');
    expect(listing).not.toContain("example.com");
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(1);
  });
  test("validates email before creating requests and rejects private or unlicensed repos", async () => {
    const f = fixture();
    expect((await f.call({ repo: "owner/repo", email: "oops" })).status).toBe(400);
    expect(f.calls).toHaveLength(0);
    for (const github of [{ private: true, license: { spdx_id: "MIT" } }, { private: false }, { private: false, license: { spdx_id: "NOASSERTION" } }]) {
      f.github(github);
      expect((await f.call({ repo: "owner/repo" })).status).toBe(400);
    }
    expect((await f.env.BUGS.list!({ prefix: "repo-request:" })).keys).toHaveLength(0);
  });
  test("completion requires authentication and an allowed public app URL", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo" });
    expect((await f.call({ repo: "owner/repo" }, "/complete")).status).toBe(401);
    for (const appUrl of ["javascript:alert(1)", "https://evil.com", "https://user@app.smithers.sh", "http://app.smithers.sh"]) {
      expect((await f.call({ repo: "owner/repo", appUrl }, "/complete", true)).status).toBe(400);
    }
    expect((await f.complete()).status).toBe(200);
    expect(await (await f.call()).json()).toMatchObject({ repos: [{ status: "ready", appUrl: "https://app.smithers.sh/repos/owner/repo" }] });
    expect(await (await f.call({ repo: "owner/repo", email: "later@example.com" })).json()).toMatchObject({ repo: { status: "ready" }, subscribed: false });
  });
  test("notifies all subscribers once and retries failures without rolling back readiness", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "one@example.com" });
    await f.call({ repo: "owner/repo", email: "two@example.com" });
    f.emailStatus(500);
    const result = await (await f.complete()).json();
    expect(result).toMatchObject({ repo: { status: "ready" }, notifications: { failed: 2, pending: true } });
    f.emailStatus(200);
    await f.worker.scheduled({}, f.env);
    const emails = f.calls.filter((call) => call.url.includes("resend"));
    expect(emails).toHaveLength(4);
    expect(emails[0]!.init!.headers).toEqual(emails[2]!.init!.headers);
    await f.complete();
    expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(4);
  });
  test("missing email configuration leaves delivery pending and succeeds after configuration", async () => {
    const f = fixture();
    delete f.env.RESEND_API_KEY;
    await f.call({ repo: "owner/repo", email: "one@example.com" });
    expect(await (await f.complete()).json()).toMatchObject({ notifications: { pending: true, reason: "email_not_configured" } });
    f.env.RESEND_API_KEY = "test-key";
    await f.worker.scheduled({}, f.env);
    expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(1);
  });
  test("scheduled sweep picks up signups arriving after completion", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo" });
    await f.complete();
    await f.env.BUGS.put("repo-subscriber:owner/repo:late-signup", "late@example.com");
    await f.worker.scheduled({}, f.env);
    expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(1);
  });
  test("public listing paginates without exposing subscribers", async () => {
    const f = fixture();
    for (let i = 0; i < 51; i++) await f.env.BUGS.put(`repo-request:owner/r${i}`, JSON.stringify({ name: `owner/r${i}`, url: `https://github.com/owner/r${i}` }));
    const page = await (await f.call()).json();
    expect(page.repos).toHaveLength(50);
    expect((await (await f.call(undefined, `?cursor=${page.cursor}`)).json()).repos).toHaveLength(1);
  });
  test("limits payloads, throttles submissions, and reports storage failures", async () => {
    const f = fixture();
    expect((await f.call({ repo: "x".repeat(5000) })).status).toBe(413);
    for (let i = 0; i < 19; i++) await f.call({ repo: "owner/repo" });
    expect((await f.call({ repo: "owner/repo" })).status).toBe(429);
    f.env.BUGS.list = async () => { throw new Error("offline"); };
    expect((await f.call()).status).toBe(503);
  });
});
