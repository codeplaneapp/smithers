import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KimiAgent } from "../src/index.js";

/**
 * Coverage for commit 15f735d59 — KimiAgent.ensureKimiCredentialsUsable.
 *
 * The async helper:
 *   1. Reads $KIMI_SHARE_DIR/credentials/*.json.
 *   2. If `expires_at` is within 60s of now, POSTs grant_type=refresh_token
 *      to $KIMI_OAUTH_HOST/api/oauth/token and atomically rewrites the file.
 *   3. Dedupes concurrent refreshes per credential file via an in-process
 *      Map<path, Promise>.
 *   4. Throws AGENT_CONFIG_INVALID (failureRetryable=false) only if BOTH
 *      the credential is unusable AND the refresh attempt fails.
 *
 * We exercise the path through the agent's `buildCommand` because that is the
 * only public entry point. We intercept the network with a global `fetch`
 * mock and use a fake `kimi` binary on PATH so the spawn doesn't actually
 * run anything (we never let buildCommand be invoked when refresh fails;
 * for the success case we reset fetch and expect a normal spawn).
 */

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_OAUTH_HOST = process.env.KIMI_OAUTH_HOST;

/**
 * @param {string} shareDir
 * @param {Record<string, unknown>} creds
 * @param {string} [name]
 */
function writeCreds(shareDir, creds, name = "default.json") {
    const credsDir = join(shareDir, "credentials");
    if (!existsSync(credsDir)) mkdirSync(credsDir, { recursive: true });
    writeFileSync(join(credsDir, name), JSON.stringify(creds), { mode: 0o600 });
}

function expiredCred() {
    return {
        access_token: "expired-access",
        refresh_token: "valid-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) - 3600, // 1h in past
    };
}

function freshCred() {
    return {
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, // 1h in future
    };
}

let shareDir = "";
let tempBinDir = "";
const cleanupDirs = [];

beforeEach(() => {
    shareDir = mkdtempSync(join(tmpdir(), "kimi-share-"));
    tempBinDir = mkdtempSync(join(tmpdir(), "kimi-bin-"));
    cleanupDirs.push(shareDir, tempBinDir);
    // Stub the kimi binary so anything reaching exec just exits 0.
    const stub = join(tempBinDir, "kimi");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(stub, 0o755);
    process.env.KIMI_OAUTH_HOST = "https://stub-auth.example.com";
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_OAUTH_HOST === undefined) {
        delete process.env.KIMI_OAUTH_HOST;
    } else {
        process.env.KIMI_OAUTH_HOST = ORIGINAL_OAUTH_HOST;
    }
    while (cleanupDirs.length) {
        const dir = cleanupDirs.pop();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

/** Make a fetch that captures the call and returns a configurable Response. */
function makeFetch(impl) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url: String(url), init });
        return impl(url, init);
    };
    fn.calls = calls;
    return fn;
}

async function callBuildCommand(agentOpts) {
    const agent = new KimiAgent(agentOpts);
    return agent.buildCommand({
        prompt: "hello",
        cwd: process.cwd(),
        options: {},
    });
}

describe("KimiAgent OAuth refresh — failure paths", () => {
    test("401 invalid_grant from refresh endpoint => AGENT_CONFIG_INVALID, failureRetryable=false", async () => {
        writeCreds(shareDir, expiredCred());
        const fetchMock = makeFetch(async () => new Response(
            JSON.stringify({ error: "invalid_grant", error_description: "refresh expired" }),
            { status: 401, headers: { "content-type": "application/json" } },
        ));
        globalThis.fetch = fetchMock;

        try {
            await callBuildCommand({ env: { KIMI_SHARE_DIR: shareDir }, model: "kimi-k2-instruct" });
            throw new Error("expected buildCommand to throw");
        } catch (err) {
            expect(err.code).toBe("AGENT_CONFIG_INVALID");
            expect(err.details?.failureRetryable).toBe(false);
            expect(String(err.message)).toContain("invalid_grant");
            expect(fetchMock.calls).toHaveLength(1);
            // Verify the request shape mirrors kimi-cli.
            expect(fetchMock.calls[0].url).toContain("/api/oauth/token");
            const body = String(fetchMock.calls[0].init?.body ?? "");
            expect(body).toContain("grant_type=refresh_token");
            expect(body).toContain("client_id=17e5f671-d194-4dfb-9706-5516cb48c098");
            expect(body).toContain("refresh_token=valid-refresh");
        }
    });

    test("500 from refresh endpoint => AGENT_CONFIG_INVALID with http-500 tag", async () => {
        writeCreds(shareDir, expiredCred());
        const fetchMock = makeFetch(async () => new Response("upstream blew up", { status: 500 }));
        globalThis.fetch = fetchMock;
        try {
            await callBuildCommand({ env: { KIMI_SHARE_DIR: shareDir }, model: "kimi-k2-instruct" });
            throw new Error("expected throw");
        } catch (err) {
            expect(err.code).toBe("AGENT_CONFIG_INVALID");
            expect(err.details?.failureRetryable).toBe(false);
            expect(String(err.message)).toContain("http-500");
        }
    });

    test("malformed JSON refresh response => AGENT_CONFIG_INVALID", async () => {
        writeCreds(shareDir, expiredCred());
        const fetchMock = makeFetch(async () => new Response("this is not json{{{", {
            status: 200,
            headers: { "content-type": "application/json" },
        }));
        globalThis.fetch = fetchMock;
        try {
            await callBuildCommand({ env: { KIMI_SHARE_DIR: shareDir }, model: "kimi-k2-instruct" });
            throw new Error("expected throw");
        } catch (err) {
            expect(err.code).toBe("AGENT_CONFIG_INVALID");
            expect(err.details?.failureRetryable).toBe(false);
        }
    });

    test("explicit invalid_grant body in 400 response => AGENT_CONFIG_INVALID", async () => {
        writeCreds(shareDir, expiredCred());
        const fetchMock = makeFetch(async () => new Response(
            JSON.stringify({ error: "invalid_grant" }),
            { status: 400 },
        ));
        globalThis.fetch = fetchMock;
        try {
            await callBuildCommand({ env: { KIMI_SHARE_DIR: shareDir }, model: "kimi-k2-instruct" });
            throw new Error("expected throw");
        } catch (err) {
            expect(err.code).toBe("AGENT_CONFIG_INVALID");
            // For non-401 statuses the helper tags as http-<status>.
            expect(String(err.message)).toMatch(/(invalid_grant|http-400)/);
        }
    });

    test("response missing access_token => AGENT_CONFIG_INVALID (refresh malformed)", async () => {
        writeCreds(shareDir, expiredCred());
        // 200 OK but no access_token field.
        const fetchMock = makeFetch(async () => new Response(
            JSON.stringify({ token_type: "Bearer", expires_in: 3600 }),
            { status: 200 },
        ));
        globalThis.fetch = fetchMock;
        try {
            await callBuildCommand({ env: { KIMI_SHARE_DIR: shareDir }, model: "kimi-k2-instruct" });
            throw new Error("expected throw");
        } catch (err) {
            expect(err.code).toBe("AGENT_CONFIG_INVALID");
            expect(String(err.message)).toContain("missing access_token");
        }
    });

    test("expired creds with no refresh_token at all => AGENT_CONFIG_INVALID, no fetch attempted", async () => {
        const cred = expiredCred();
        delete cred.refresh_token;
        writeCreds(shareDir, cred);
        const fetchMock = makeFetch(async () => {
            throw new Error("network should not be reached");
        });
        globalThis.fetch = fetchMock;
        try {
            await callBuildCommand({ env: { KIMI_SHARE_DIR: shareDir }, model: "kimi-k2-instruct" });
            throw new Error("expected throw");
        } catch (err) {
            expect(err.code).toBe("AGENT_CONFIG_INVALID");
            expect(err.details?.failureRetryable).toBe(false);
            expect(String(err.message)).toContain("no refresh_token is stored");
            expect(fetchMock.calls).toHaveLength(0);
        }
    });
});

describe("KimiAgent OAuth refresh — success paths", () => {
    test("successful refresh rewrites the credential file in place with new tokens", async () => {
        const credsPath = join(shareDir, "credentials", "default.json");
        writeCreds(shareDir, expiredCred());
        let calls = 0;
        const fetchMock = makeFetch(async () => {
            calls += 1;
            return new Response(JSON.stringify({
                access_token: "rotated-access",
                refresh_token: "rotated-refresh",
                token_type: "Bearer",
                expires_in: 7200,
                scope: "read write",
            }), { status: 200, headers: { "content-type": "application/json" } });
        });
        globalThis.fetch = fetchMock;

        // buildCommand goes past refresh and tries to spawn — we don't run it,
        // but we expect it to return cleanly with a command spec.
        const agent = new KimiAgent({ env: { KIMI_SHARE_DIR: shareDir }, model: "kimi-k2-instruct" });
        const spec = await agent.buildCommand({ prompt: "x", cwd: process.cwd(), options: {} });
        expect(spec.command).toBe("kimi");
        if (typeof spec.cleanup === "function") {
            await spec.cleanup();
        }
        expect(calls).toBe(1);
        const written = JSON.parse(readFileSync(credsPath, "utf8"));
        expect(written.access_token).toBe("rotated-access");
        expect(written.refresh_token).toBe("rotated-refresh");
        expect(written.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 7000);
    });

    test("non-expired credential is left alone (no fetch)", async () => {
        writeCreds(shareDir, freshCred());
        const fetchMock = makeFetch(async () => {
            throw new Error("should not refresh a fresh credential");
        });
        globalThis.fetch = fetchMock;
        const agent = new KimiAgent({ env: { KIMI_SHARE_DIR: shareDir }, model: "kimi-k2-instruct" });
        const spec = await agent.buildCommand({ prompt: "x", cwd: process.cwd(), options: {} });
        expect(spec.command).toBe("kimi");
        if (typeof spec.cleanup === "function") await spec.cleanup();
        expect(fetchMock.calls).toHaveLength(0);
    });
});

describe("KimiAgent OAuth refresh — concurrent refresh dedup", () => {
    test("two concurrent buildCommand calls share a single refresh fetch", async () => {
        writeCreds(shareDir, expiredCred());
        let inflight = 0;
        let observedMaxInflight = 0;
        let totalCalls = 0;
        const fetchMock = async () => {
            inflight += 1;
            observedMaxInflight = Math.max(observedMaxInflight, inflight);
            totalCalls += 1;
            // Simulate a slow refresh so both callers overlap.
            await new Promise((r) => setTimeout(r, 50));
            inflight -= 1;
            return new Response(JSON.stringify({
                access_token: "rotated-access",
                refresh_token: "rotated-refresh",
                token_type: "Bearer",
                expires_in: 3600,
            }), { status: 200 });
        };
        globalThis.fetch = fetchMock;

        // Two distinct agent instances pointing at the same KIMI_SHARE_DIR.
        const agentA = new KimiAgent({ env: { KIMI_SHARE_DIR: shareDir }, model: "kimi-k2-instruct" });
        const agentB = new KimiAgent({ env: { KIMI_SHARE_DIR: shareDir }, model: "kimi-k2-instruct" });
        const [specA, specB] = await Promise.all([
            agentA.buildCommand({ prompt: "x", cwd: process.cwd(), options: {} }),
            agentB.buildCommand({ prompt: "x", cwd: process.cwd(), options: {} }),
        ]);
        if (typeof specA.cleanup === "function") await specA.cleanup();
        if (typeof specB.cleanup === "function") await specB.cleanup();

        // The dedup map is keyed by file path → exactly ONE refresh should fire.
        expect(totalCalls).toBe(1);
        // By definition of dedup we should never see two concurrent refreshes.
        expect(observedMaxInflight).toBeLessThanOrEqual(1);
    });
});
