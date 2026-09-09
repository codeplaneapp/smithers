import { describe, expect, test } from "bun:test";
import { createBugWorker } from "../src/worker.ts";
import { repoName } from "../src/repoRequests.ts";
import { memoryKv } from "./helpers/memoryKv.ts";
import { memoryRepoCompletions } from "./helpers/memoryRepoCompletions.ts";
import type { BugWorkerEnv } from "../src/env.ts";

function fixture() {
  const env: BugWorkerEnv = { BUGS: memoryKv(), BUG_ADMIN_TOKEN: "test-admin", RESEND_API_KEY: "test-key", NOTIFICATION_FROM: "Smithers <test@example.com>" };
  env.REPO_COMPLETIONS = memoryRepoCompletions(env);
  const calls: { url: string; init?: RequestInit }[] = [];
  let emailStatus = 200;
  let github: unknown = { private: false, license: { spdx_id: "MIT" } };
  let githubStatus = 200;
  const worker = createBugWorker({ now: () => 1788500000000, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("api.github.com")) return Response.json(github, { status: githubStatus });
    return Response.json({ id: "email-1" }, { status: url.includes("resend") ? emailStatus : 200 });
  }) as typeof fetch });
  const call = (body?: unknown, route = "", admin = false, ip = "203.0.113.1") => worker.fetch(new Request(`https://bug.smithers.sh/api/repo-requests${route}`, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(admin ? { "x-bug-admin": "test-admin" } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const complete = () => call({ repo: "owner/repo", appUrl: "https://app.smithers.sh/repos/owner/repo" }, "/complete", true);
  return { env, worker, calls, call, complete, emailStatus: (value: number) => { emailStatus = value; }, github: (value: unknown, status = 200) => { github = value; githubStatus = status; } };
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
  test("checks GitHub with a manual redirect and refuses a moved repository like a missing one", async () => {
    // workerd rejects redirect: "error" before sending, so the check must ask for "manual"
    // and read a 3xx answer itself; "follow" would land on the renamed repository instead.
    const f = fixture();
    f.github({ message: "Moved Permanently" }, 301);
    const moved = await f.call({ repo: "owner/moved" });
    expect(moved.status).toBe(400);
    expect(await moved.json()).toEqual({ error: "That repository was not found. Please use a public GitHub repository." });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://api.github.com/repos/owner/moved");
    expect(f.calls[0]!.init?.redirect).toBe("manual");
    f.github({ message: "Not Found" }, 404);
    const missing = await f.call({ repo: "owner/missing" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "That repository was not found. Please use a public GitHub repository." });
    expect((await f.env.BUGS.list!({ prefix: "repo-request:" })).keys).toHaveLength(0);
    expect((await f.env.BUGS.list!({ prefix: "repo-nominations:" })).keys).toHaveLength(0);
    f.github({ private: false, license: { spdx_id: "MIT" } }, 200);
    expect((await f.call({ repo: "owner/repo" })).status).toBe(200);
    expect((await f.env.BUGS.list!({ prefix: "repo-request:" })).keys).toHaveLength(1);
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
  test("concurrent conflicting completions publish and notify only the winning URL", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "one@example.com" });
    const get = f.env.BUGS.get.bind(f.env.BUGS);
    let arrivals = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    // Hold both null readiness reads so neither request can publish first.
    f.env.BUGS.get = async (key) => {
      const value = await get(key);
      if (key === "repo-ready:owner/repo" && arrivals < 2) {
        if (++arrivals === 2) release();
        await both;
      }
      return value;
    };
    const responses = await Promise.all(["first", "second"].map((path) =>
      f.call({ repo: "owner/repo", appUrl: `https://app.smithers.sh/${path}` }, "/complete", true)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = await responses.find((response) => response.status === 200)!.json();
    const ready = JSON.parse((await get("repo-ready:owner/repo"))!);
    expect(ready.appUrl).toBe(winner.repo.appUrl);
    const emails = f.calls.filter((call) => call.url.includes("resend"));
    expect(emails).toHaveLength(1);
    expect(JSON.parse(String(emails[0]!.init!.body)).text).toContain(winner.repo.appUrl);
    expect((await f.call({ repo: "owner/repo", appUrl: winner.repo.appUrl }, "/complete", true)).status).toBe(200);
    expect(JSON.parse((await get("repo-ready:owner/repo"))!)).toEqual(ready);
  });
  test("completion preserves URLs published before the durable coordinator was introduced", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo" });
    const ready = { appUrl: "https://app.smithers.sh/legacy", completedAt: "2026-01-01T00:00:00.000Z" };
    await f.env.BUGS.put("repo-ready:owner/repo", JSON.stringify(ready));
    expect((await f.complete()).status).toBe(409);
    expect((await f.call({ repo: "owner/repo", appUrl: ready.appUrl }, "/complete", true)).status).toBe(200);
    expect(JSON.parse((await f.env.BUGS.get("repo-ready:owner/repo"))!)).toEqual(ready);
  });
  test("a failed readiness mirror cannot let a retry publish a different URL", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "one@example.com" });
    const put = f.env.BUGS.put.bind(f.env.BUGS);
    f.env.BUGS.put = async (key, value, options) => {
      if (key.startsWith("repo-ready:")) throw new Error("KV unavailable");
      return put(key, value, options);
    };
    expect((await f.complete()).status).toBe(503);
    expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(0);
    f.env.BUGS.put = put;
    expect((await f.call({ repo: "owner/repo", appUrl: "https://app.smithers.sh/other" }, "/complete", true)).status).toBe(409);
    expect((await f.complete()).status).toBe(200);
    expect(JSON.parse((await f.env.BUGS.get("repo-ready:owner/repo"))!).appUrl).toBe("https://app.smithers.sh/repos/owner/repo");
    expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(1);
  });
  test("stale KV readiness cannot overwrite the durable publication", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo" });
    expect((await f.complete()).status).toBe(200);
    const get = f.env.BUGS.get.bind(f.env.BUGS);
    const original = await get("repo-ready:owner/repo");
    f.env.BUGS.get = (key) => key === "repo-ready:owner/repo" ? Promise.resolve(null) : get(key);
    expect((await f.call({ repo: "OWNER/REPO", appUrl: "https://app.smithers.sh/other" }, "/complete", true)).status).toBe(409);
    expect((await f.complete()).status).toBe(200);
    expect(await get("repo-ready:owner/repo")).toBe(original);
    await f.call({ repo: "owner/another" });
    expect((await f.call({ repo: "owner/another", appUrl: "https://app.smithers.sh/another" }, "/complete", true)).status).toBe(200);
  });
  test("completion fails closed without the durable binding", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "one@example.com" });
    delete f.env.REPO_COMPLETIONS;
    expect((await f.complete()).status).toBe(503);
    expect(await f.env.BUGS.get("repo-ready:owner/repo")).toBeNull();
    expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(0);
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
  test("a repeated nomination of the same repo increments its count", async () => {
    const f = fixture();
    expect(await (await f.call({ repo: "owner/repo" })).json()).toMatchObject({ repo: { name: "owner/repo", nominations: 1 } });
    expect(await (await f.call({ repo: "https://github.com/Owner/Repo.git", email: "me@example.com" })).json()).toMatchObject({ repo: { nominations: 2 } });
    expect(await (await f.call(undefined, "?repo=OWNER/repo")).json()).toMatchObject({ repo: { name: "owner/repo", status: "smithering", nominations: 2 } });
    expect((await f.call(undefined, "?repo=owner/never")).status).toBe(404);
    expect((await f.call(undefined, "?repo=https://evil.com/owner/repo")).status).toBe(400);
  });
  test("rejected nominations do not count", async () => {
    const f = fixture();
    expect((await f.call({ repo: "owner/repo", email: "oops" })).status).toBe(400);
    f.github({ private: true, license: { spdx_id: "MIT" } });
    expect((await f.call({ repo: "owner/private" })).status).toBe(400);
    expect((await f.env.BUGS.list!({ prefix: "repo-nominations:" })).keys).toHaveLength(0);
  });
  test("counts are independent per repo and the public list ranks by count, capped at 20", async () => {
    const f = fixture();
    // Records beyond any fixed scan window: the leaderboard must still rank a late-sorting name first.
    for (let i = 0; i < 250; i++) await f.env.BUGS.put(`repo-request:owner/r${String(i).padStart(3, "0")}`, JSON.stringify({ name: `owner/r${i}`, url: `https://github.com/owner/r${i}` }));
    for (let i = 0; i < 22; i++) await f.call({ repo: `owner/r${i}` }, "", false, `10.0.0.${i}`);
    await f.call({ repo: "owner/second" }, "", false, "10.0.1.1");
    await f.call({ repo: "owner/zzz" }, "", false, "10.0.1.2");
    await f.call({ repo: "owner/zzz" }, "", false, "10.0.1.3");
    await f.call({ repo: "owner/second" }, "", false, "10.0.1.4");
    await f.call({ repo: "owner/zzz" }, "", false, "10.0.1.5");
    const response = await f.call();
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const { repos } = await response.json();
    expect(repos).toHaveLength(20);
    expect(repos.slice(0, 3)).toMatchObject([
      { name: "owner/zzz", url: "https://github.com/owner/zzz", status: "smithering", nominations: 3 },
      { name: "owner/second", nominations: 2 },
      { name: "owner/r0", nominations: 1 },
    ]);
    expect(repos.slice(2).every((repo: { nominations: number }) => repo.nominations === 1)).toBe(true);
    expect(JSON.stringify(repos)).not.toContain("example.com");
    // Listing reads the leaderboard and each entry's readiness only, never the whole catalog.
    let reads = 0;
    const get = f.env.BUGS.get.bind(f.env.BUGS);
    f.env.BUGS.get = async (key: string) => { reads++; return get(key); };
    f.env.BUGS.list = async () => { throw new Error("list must not be used"); };
    expect((await f.call()).status).toBe(200);
    expect(reads).toBe(21);
  });
  test("limits payloads, throttles submissions, and reports storage failures", async () => {
    const f = fixture();
    expect((await f.call({ repo: "x".repeat(5000) })).status).toBe(413);
    for (let i = 0; i < 19; i++) await f.call({ repo: "owner/repo" });
    expect((await f.call({ repo: "owner/repo" })).status).toBe(429);
    f.env.BUGS.get = async () => { throw new Error("offline"); };
    expect((await f.call()).status).toBe(503);
  });
});
