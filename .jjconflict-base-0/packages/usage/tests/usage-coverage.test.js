import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    anthropicHeaderUsage,
    claudeOauthUsage,
    codexWhamUsage,
    decodeJwtClaims,
    formatUsageReports,
    getAccountUsage,
    getUsageForAccounts,
    googleUsage,
    humanizeDurationShort,
    openaiHeaderUsage,
    parseAnthropicRateLimitHeaders,
    parseCodexUsage,
    parseDurationSeconds,
    parseOpenAiRateLimitHeaders,
    readUsageCache,
    readClaudeCredentials,
    readCodexCredentials,
    writeUsageCache,
} from "../src/index.js";

/** @type {string[]} */
const tempDirs = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
    while (tempDirs.length) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

function tempDir() {
    const dir = mkdtempSync(join(tmpdir(), "smithers-usage-coverage-"));
    tempDirs.push(dir);
    return dir;
}

function jsonResponse(status, payload, headers = {}) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });
}

function jwtWithClaims(claims) {
    return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
}

describe("network usage probes", () => {
    test("anthropicHeaderUsage posts the token-count fixture and maps 429 headers", async () => {
        const fetchMock = mock(async (_url, init) => {
            expect(init.method).toBe("POST");
            expect(init.headers["x-api-key"]).toBe("anthropic-key");
            expect(JSON.parse(init.body)).toMatchObject({ messages: [{ role: "user", content: "hi" }] });
            return jsonResponse(429, {}, {
                "anthropic-ratelimit-requests-limit": "100",
                "anthropic-ratelimit-requests-remaining": "0",
                "anthropic-ratelimit-requests-reset": "2026-06-03T00:01:00.000Z",
                "retry-after": "12",
            });
        });
        globalThis.fetch = fetchMock;

        const usage = await anthropicHeaderUsage({ apiKey: "anthropic-key" });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(usage.source).toBe("headers");
        expect(usage.error).toContain("retry after 12s");
        expect(usage.windows[0]).toMatchObject({ id: "requests-per-min", used: 100, remaining: 0 });
    });

    test("openaiHeaderUsage handles auth rejection and header fixtures", async () => {
        globalThis.fetch = mock(async () => jsonResponse(401, {}));
        await expect(openaiHeaderUsage({ apiKey: "bad" })).resolves.toMatchObject({
            source: "none",
            error: "OPENAI_API_KEY rejected (401)",
        });

        globalThis.fetch = mock(async (_url, init) => {
            expect(init.headers.Authorization).toBe("Bearer openai-key");
            return jsonResponse(200, {}, {
                "x-ratelimit-limit-requests": "50",
                "x-ratelimit-remaining-requests": "49",
                "x-ratelimit-reset-requests": "1s",
            });
        });

        const usage = await openaiHeaderUsage({ apiKey: "openai-key" });

        expect(usage).toMatchObject({ source: "headers" });
        expect(usage.windows[0]).toMatchObject({ id: "requests-per-min", limit: 50, remaining: 49, used: 1 });
    });

    test("claudeOauthUsage reads credentials and parses OAuth usage fixtures", async () => {
        const configDir = tempDir();
        writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({
            claudeAiOauth: { accessToken: "claude-token", expiresAt: 99999999999999 },
        }));
        globalThis.fetch = mock(async (_url, init) => {
            expect(init.headers.Authorization).toBe("Bearer claude-token");
            expect(init.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
            return jsonResponse(200, {
                five_hour: { utilization: 76, resets_at: "2026-06-03T05:00:00.000Z" },
                seven_day: { utilization: 12, resets_at: "2026-06-10T00:00:00.000Z" },
            });
        });

        const usage = await claudeOauthUsage({ configDir });

        expect(usage.source).toBe("oauth");
        expect(usage.windows.map((w) => w.id)).toEqual(["5h", "weekly"]);
        expect(usage.windows[0].usedPercent).toBe(76);
    });

    test("codexWhamUsage sends ChatGPT account id and parses WHAM fixtures", async () => {
        const configDir = tempDir();
        writeFileSync(join(configDir, "auth.json"), JSON.stringify({
            tokens: { access_token: "codex-token", account_id: "acct-direct" },
        }));
        globalThis.fetch = mock(async (_url, init) => {
            expect(init.headers.Authorization).toBe("Bearer codex-token");
            expect(init.headers["ChatGPT-Account-Id"]).toBe("acct-direct");
            return jsonResponse(200, {
                plan_type: "plus",
                rate_limits: {
                    primary: { used_percent: 22, window_minutes: 300, reset_at: 1780459200 },
                    secondary: { used_percent: 44, window_minutes: 10080 },
                },
                credits: { has_credits: true, unlimited: true },
            });
        });

        const usage = await codexWhamUsage({ configDir });

        expect(usage).toMatchObject({ source: "oauth", planType: "plus" });
        expect(usage.windows.map((w) => w.id)).toEqual(["5h", "weekly"]);
        expect(usage.credits).toEqual({ hasCredits: true, unlimited: true, balance: undefined });
    });

    test("googleUsage reports that live usage is unsupported", async () => {
        await expect(googleUsage({ provider: "gemini-api" })).resolves.toMatchObject({
            source: "none",
            error: expect.stringContaining("Google exposes no live usage endpoint"),
        });
    });
});

describe("credential readers", () => {
    test("readClaudeCredentials reads configDir credentials and ignores malformed files", () => {
        const configDir = tempDir();
        writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({
            claudeAiOauth: { accessToken: "claude-token", expiresAt: 456 },
        }));

        expect(readClaudeCredentials({ configDir }, "linux")).toEqual({ accessToken: "claude-token", expiresAt: 456 });

        const badDir = tempDir();
        writeFileSync(join(badDir, ".credentials.json"), "{");
        expect(readClaudeCredentials({ configDir: badDir }, "linux")).toBeNull();
    });

    test("readClaudeCredentials falls back to macOS Keychain credentials", () => {
        // Inject spawnSync rather than mock.module + `?query` re-import: the
        // re-imported module is a distinct instance whose coverage bun discards,
        // and it also becomes the "reported" instance, masking the real one.
        const spawn = mock((command, args) => {
            expect(command).toBe("security");
            expect(args).toEqual(["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
            return {
                status: 0,
                stdout: Buffer.from(JSON.stringify({
                    claudeAiOauth: { accessToken: "keychain-token", expiresAt: 789 },
                })),
            };
        });

        expect(readClaudeCredentials({}, "darwin", spawn)).toEqual({ accessToken: "keychain-token", expiresAt: 789 });
        expect(spawn).toHaveBeenCalledTimes(1);
    });

    test("readClaudeCredentials handles Keychain hit with no stdout buffer", () => {
        // status 0 but stdout undefined exercises the `?? ""` fallback on line 34.
        const spawn = mock(() => ({ status: 0, stdout: undefined }));
        expect(readClaudeCredentials({}, "darwin", spawn)).toBeNull();
        expect(spawn).toHaveBeenCalledTimes(1);
    });

    test("readClaudeCredentials returns null when macOS Keychain has no credential", () => {
        const spawn = mock(() => ({ status: 44, stdout: Buffer.from("") }));
        expect(readClaudeCredentials({}, "darwin", spawn)).toBeNull();
        expect(spawn).toHaveBeenCalledTimes(1);
    });

    test("readClaudeCredentials degrades when the credentials file cannot be read or lacks a token", () => {
        // existsSync true but readFileSync throws (path is a directory) -> readFileSafe catch.
        const dir = tempDir();
        mkdirSync(join(dir, ".credentials.json"));
        expect(readClaudeCredentials({ configDir: dir }, "linux")).toBeNull();

        // credentials present but no accessToken -> parseCredentials returns null.
        const noToken = tempDir();
        writeFileSync(join(noToken, ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }));
        expect(readClaudeCredentials({ configDir: noToken }, "linux")).toBeNull();

        // valid token with a non-numeric expiresAt -> expiresAt omitted.
        const noExpiry = tempDir();
        writeFileSync(join(noExpiry, ".credentials.json"), JSON.stringify({
            claudeAiOauth: { accessToken: "tok", expiresAt: "later" },
        }));
        expect(readClaudeCredentials({ configDir: noExpiry }, "linux")).toEqual({ accessToken: "tok" });
    });

    test("readCodexCredentials degrades on missing dir, malformed json, and absent token", () => {
        expect(readCodexCredentials({})).toBeNull();

        const bad = tempDir();
        writeFileSync(join(bad, "auth.json"), "{not json");
        expect(readCodexCredentials({ configDir: bad })).toBeNull();

        const noToken = tempDir();
        writeFileSync(join(noToken, "auth.json"), JSON.stringify({ tokens: {} }));
        expect(readCodexCredentials({ configDir: noToken })).toBeNull();
    });

    test("readCodexCredentials falls back to the account id inside the id_token JWT", () => {
        const configDir = tempDir();
        writeFileSync(join(configDir, "auth.json"), JSON.stringify({
            tokens: {
                access_token: "codex-token",
                id_token: jwtWithClaims({
                    "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-jwt" },
                }),
            },
        }));

        expect(readCodexCredentials({ configDir })).toEqual({
            accessToken: "codex-token",
            accountId: "acct-from-jwt",
        });
    });
});

describe("parser and formatter branches", () => {
    test("humanizeDurationShort treats non-finite input as now", () => {
        expect(humanizeDurationShort(Number.NaN)).toBe("now");
        expect(humanizeDurationShort(Infinity)).toBe("now");
    });

    test("formatUsageReports renders estimated and count window variants", () => {
        const out = formatUsageReports([
            {
                accountLabel: "estimate",
                provider: "gemini-api",
                authMode: "subscription",
                source: "estimate",
                stale: false,
                estimate: true,
                fetchedAt: "2026-06-03T00:00:00.000Z",
                windows: [
                    { id: "day", label: "daily", unit: "estimated", used: 8, limit: 10 },
                    { id: "month", label: "monthly", unit: "estimated" },
                ],
            },
            {
                accountLabel: "count",
                provider: "openai-api",
                authMode: "api-key",
                source: "headers",
                stale: false,
                estimate: false,
                fetchedAt: "2026-06-03T00:00:00.000Z",
                windows: [
                    { id: "remaining", label: "remaining", unit: "count", remaining: 7 },
                    { id: "used", label: "used", unit: "count", used: 3, limit: 10 },
                ],
            },
        ], Date.parse("2026-06-03T00:00:00.000Z"));

        expect(out).toContain("~8/10 (est)");
        expect(out).toContain("~? (est)");
        expect(out).toContain("7 left");
        expect(out).toContain("3/10");
    });

    test("parseCodexUsage labels hourly, fallback, monthly, and invalid windows", () => {
        expect(parseCodexUsage(null)).toEqual({ windows: [] });
        const { windows, planType, credits } = parseCodexUsage({
            primary: { used_percent: 5, window_minutes: 45 },
            secondary: { used_percent: 9, window_minutes: 43200 },
            plan_type: 12,
            credits: { has_credits: 1, unlimited: 0, balance: 123 },
        });

        expect(windows.map((w) => [w.id, w.label])).toEqual([
            ["hourly", "45-minute"],
            ["monthly", "monthly"],
        ]);
        expect(planType).toBeUndefined();
        expect(credits).toEqual({ hasCredits: true, unlimited: false, balance: undefined });

        expect(parseCodexUsage({ primary: { used_percent: "5" } }).windows).toEqual([]);
        expect(parseCodexUsage({ primary: { used_percent: 1 } }).windows[0]).toMatchObject({
            id: "primary",
            label: "primary",
        });
    });

    test("rate-limit header parsers handle partial and inverted count windows", () => {
        const fixedNow = Date.parse("2026-06-03T00:00:00.000Z");
        const openai = parseOpenAiRateLimitHeaders((name) => ({
            "x-ratelimit-limit-requests": "10",
            "x-ratelimit-remaining-requests": "15",
            "x-ratelimit-reset-requests": "2m0s",
            "x-ratelimit-remaining-tokens": "42",
            "x-ratelimit-reset-tokens": "bad-duration",
        })[name] ?? null, fixedNow);

        expect(openai).toHaveLength(2);
        expect(openai[0]).toMatchObject({
            id: "requests-per-min",
            limit: 10,
            remaining: 15,
            used: 0,
            resetsAt: "2026-06-03T00:02:00.000Z",
        });
        expect(openai[1]).toMatchObject({
            id: "tokens-per-min",
            limit: undefined,
            remaining: 42,
            used: undefined,
            resetsAt: undefined,
        });

        const anthropic = parseAnthropicRateLimitHeaders((name) => ({
            "anthropic-ratelimit-requests-remaining": "5",
            "anthropic-ratelimit-output-tokens-limit": "100",
            "anthropic-ratelimit-output-tokens-remaining": "90",
            "anthropic-ratelimit-output-tokens-reset": "2026-06-03T00:03:00.000Z",
        })[name] ?? null);

        expect(anthropic.map((window) => window.id)).toEqual([
            "requests-per-min",
            "output-tokens-per-min",
        ]);
        expect(anthropic[0]).toMatchObject({ limit: undefined, remaining: 5, used: undefined });
        expect(anthropic[1]).toMatchObject({ limit: 100, remaining: 90, used: 10 });
    });

    test("usage cache rejects malformed versions and array entries as cold cache", () => {
        const root = tempDir();
        const env = { SMITHERS_HOME: root };

        writeFileSync(join(root, "usage-cache.json"), JSON.stringify({ version: 2, entries: {} }));
        expect(readUsageCache(env)).toEqual({ version: 1, entries: {} });

        writeFileSync(join(root, "usage-cache.json"), JSON.stringify({ version: 1, entries: [] }));
        expect(readUsageCache(env)).toEqual({ version: 1, entries: {} });
    });
});

describe("getUsageForAccounts cache decisions", () => {
    test("--fresh bypasses the soft cache for non-floored providers", async () => {
        const env = { SMITHERS_HOME: tempDir() };
        writeUsageCache({
            version: 1,
            entries: {
                k: {
                    identity: { provider: "kimi", configDir: "/x" },
                    report: {
                        accountLabel: "k",
                        provider: "kimi",
                        authMode: "subscription",
                        source: "none",
                        stale: false,
                        estimate: false,
                        fetchedAt: "2026-06-03T00:00:00.000Z",
                        windows: [],
                        error: "cached",
                    },
                },
            },
        }, env);

        const reports = await getUsageForAccounts(
            [{ label: "k", provider: "kimi", configDir: "/x" }],
            { env, fresh: true, nowMs: Date.parse("2026-06-03T00:00:01.000Z") },
        );

        expect(reports[0].stale).toBe(false);
        expect(reports[0].error).toBe("Kimi exposes no usage endpoint yet");
    });

    test("claude-code respects the hard 180s floor even with --fresh", async () => {
        const env = { SMITHERS_HOME: tempDir() };
        writeUsageCache({
            version: 1,
            entries: {
                claude: {
                    identity: { provider: "claude-code", configDir: "/x" },
                    report: {
                        accountLabel: "claude",
                        provider: "claude-code",
                        authMode: "subscription",
                        source: "oauth",
                        stale: false,
                        estimate: false,
                        fetchedAt: "2026-06-03T00:00:00.000Z",
                        windows: [],
                        error: "cached-floor",
                    },
                },
            },
        }, env);

        const reports = await getUsageForAccounts(
            [{ label: "claude", provider: "claude-code", configDir: "/x" }],
            { env, fresh: true, nowMs: Date.parse("2026-06-03T00:02:59.000Z") },
        );

        expect(reports[0]).toMatchObject({ stale: true, error: "cached-floor" });
    });

    test("cache write failures do not fail usage collection", async () => {
        const rootFile = join(tempDir(), "not-a-dir");
        writeFileSync(rootFile, "already a file");

        await expect(getUsageForAccounts(
            [{ label: "k", provider: "kimi", configDir: "/x" }],
            { env: { SMITHERS_HOME: rootFile }, nowMs: Date.parse("2026-06-03T00:00:00.000Z") },
        )).resolves.toMatchObject([{ accountLabel: "k", source: "none" }]);
    });

    test("codex uses the 60s soft interval and claude-code re-probes past its 180s floor", async () => {
        const env = { SMITHERS_HOME: tempDir() };
        const claudeConfig = tempDir();
        writeFileSync(join(claudeConfig, ".credentials.json"), JSON.stringify({
            claudeAiOauth: { accessToken: "claude-token", expiresAt: 99999999999999 },
        }));
        writeUsageCache({
            version: 1,
            entries: {
                cx: {
                    identity: { provider: "codex", configDir: "/x" },
                    report: {
                        accountLabel: "cx", provider: "codex", authMode: "subscription",
                        source: "oauth", stale: false, estimate: false,
                        fetchedAt: "2026-06-03T00:03:00.000Z", windows: [], error: "codex-cached",
                    },
                },
                cl: {
                    identity: { provider: "claude-code", configDir: claudeConfig },
                    report: {
                        accountLabel: "cl", provider: "claude-code", authMode: "subscription",
                        source: "oauth", stale: false, estimate: false,
                        fetchedAt: "2026-06-03T00:00:00.000Z", windows: [], error: "claude-cached",
                    },
                },
                km: {
                    identity: { provider: "kimi", configDir: "/x" },
                    report: {
                        accountLabel: "km", provider: "kimi", authMode: "subscription",
                        source: "none", stale: false, estimate: false,
                        fetchedAt: "2026-06-03T00:03:20.000Z", windows: [], error: "kimi-cached",
                    },
                },
            },
        }, env);
        globalThis.fetch = mock(async () => jsonResponse(200, {
            five_hour: { utilization: 10, resets_at: "2026-06-03T05:00:00.000Z" },
        }));

        const reports = await getUsageForAccounts(
            [
                { label: "cx", provider: "codex", configDir: "/x" },
                { label: "cl", provider: "claude-code", configDir: claudeConfig },
                { label: "km", provider: "kimi", configDir: "/x" },
            ],
            // codex age 30s (< 60s soft interval -> cached); kimi age 10s (< 30s
            // default interval -> cached); claude age > 180s floor -> re-probed.
            { env, nowMs: Date.parse("2026-06-03T00:03:30.000Z") },
        );

        const cx = reports.find((r) => r.accountLabel === "cx");
        const cl = reports.find((r) => r.accountLabel === "cl");
        const km = reports.find((r) => r.accountLabel === "km");
        expect(cx).toMatchObject({ stale: true, error: "codex-cached" });
        expect(km).toMatchObject({ stale: true, error: "kimi-cached" });
        expect(cl?.stale).toBe(false);
        expect(cl?.source).toBe("oauth");
    });
});

describe("network probe error and success branches", () => {
    test("anthropicHeaderUsage covers missing key, 401, success, and thrown error", async () => {
        await expect(anthropicHeaderUsage({})).resolves.toEqual({
            source: "none",
            error: "Account has no API key set",
        });

        globalThis.fetch = mock(async () => jsonResponse(401, {}));
        await expect(anthropicHeaderUsage({ apiKey: "bad" })).resolves.toEqual({
            source: "none",
            error: "ANTHROPIC_API_KEY rejected (401)",
        });

        globalThis.fetch = mock(async () => jsonResponse(200, {}, {
            "anthropic-ratelimit-requests-limit": "100",
            "anthropic-ratelimit-requests-remaining": "40",
            "anthropic-ratelimit-requests-reset": "2026-06-03T00:01:00.000Z",
        }));
        const ok = await anthropicHeaderUsage({ apiKey: "good" });
        expect(ok).toMatchObject({ source: "headers" });
        expect(ok.error).toBeUndefined();
        expect(ok.windows[0]).toMatchObject({ id: "requests-per-min", remaining: 40 });

        globalThis.fetch = mock(async () => jsonResponse(400, {}));
        await expect(anthropicHeaderUsage({ apiKey: "bad-model" })).resolves.toEqual({
            source: "none",
            error: "Anthropic returned 400 with no rate-limit headers",
        });

        globalThis.fetch = mock(async () => { throw new Error("boom"); });
        await expect(anthropicHeaderUsage({ apiKey: "x" })).resolves.toMatchObject({
            source: "none",
            error: expect.stringContaining("Anthropic header probe failed: boom"),
        });
    });

    test("openaiHeaderUsage covers missing key, 429, error status without headers, and thrown error", async () => {
        await expect(openaiHeaderUsage({})).resolves.toEqual({
            source: "none",
            error: "Account has no API key set",
        });

        globalThis.fetch = mock(async () => jsonResponse(429, {}, {
            "x-ratelimit-limit-requests": "50",
            "x-ratelimit-remaining-requests": "0",
            "x-ratelimit-reset-requests": "30s",
            "retry-after": "9",
        }));
        const limited = await openaiHeaderUsage({ apiKey: "k" });
        expect(limited).toMatchObject({ source: "headers" });
        expect(limited.error).toContain("retry after 9s");

        globalThis.fetch = mock(async () => jsonResponse(500, {}));
        await expect(openaiHeaderUsage({ apiKey: "k" })).resolves.toEqual({
            source: "none",
            error: "OpenAI returned 500 with no rate-limit headers",
        });

        globalThis.fetch = mock(async () => { throw new Error("neterr"); });
        await expect(openaiHeaderUsage({ apiKey: "k" })).resolves.toMatchObject({
            source: "none",
            error: expect.stringContaining("OpenAI header probe failed: neterr"),
        });
    });

    test("claudeOauthUsage covers no creds, 401, 429, non-ok, and thrown error", async () => {
        // Inject a null-returning reader: an empty configDir would otherwise fall
        // back to the host Keychain, which is non-deterministic across machines.
        await expect(claudeOauthUsage({ configDir: tempDir() }, () => null)).resolves.toEqual({
            source: "none",
            error: "No Claude OAuth credentials in configDir or Keychain",
        });

        const configDir = tempDir();
        writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({
            claudeAiOauth: { accessToken: "claude-token", expiresAt: 99999999999999 },
        }));

        globalThis.fetch = mock(async () => jsonResponse(401, {}));
        await expect(claudeOauthUsage({ configDir })).resolves.toMatchObject({
            source: "none",
            error: expect.stringContaining("rejected (401)"),
        });

        globalThis.fetch = mock(async () => jsonResponse(429, {}));
        await expect(claudeOauthUsage({ configDir })).resolves.toMatchObject({
            source: "none",
            error: expect.stringContaining("rate limited (429)"),
        });

        globalThis.fetch = mock(async () => jsonResponse(503, {}));
        await expect(claudeOauthUsage({ configDir })).resolves.toEqual({
            source: "none",
            error: "Claude usage endpoint returned 503",
        });

        globalThis.fetch = mock(async () => { throw new Error("down"); });
        await expect(claudeOauthUsage({ configDir })).resolves.toMatchObject({
            source: "none",
            error: expect.stringContaining("Claude usage probe failed: down"),
        });
    });

    test("claudeOauthUsage reports an expired token", () => {
        const configDir = tempDir();
        writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({
            claudeAiOauth: { accessToken: "claude-token", expiresAt: 1 },
        }));
        return expect(claudeOauthUsage({ configDir })).resolves.toEqual({
            source: "none",
            error: "Claude OAuth token expired; run `claude` to refresh",
        });
    });

    test("codexWhamUsage covers no creds, 401, non-ok, and thrown error", async () => {
        await expect(codexWhamUsage({ configDir: tempDir() })).resolves.toEqual({
            source: "none",
            error: "No Codex ChatGPT credentials in configDir/auth.json",
        });

        const configDir = tempDir();
        writeFileSync(join(configDir, "auth.json"), JSON.stringify({
            tokens: { access_token: "codex-token", account_id: "acct" },
        }));

        globalThis.fetch = mock(async () => jsonResponse(401, {}));
        await expect(codexWhamUsage({ configDir })).resolves.toMatchObject({
            source: "none",
            error: expect.stringContaining("rejected (401)"),
        });

        globalThis.fetch = mock(async () => jsonResponse(502, {}));
        await expect(codexWhamUsage({ configDir })).resolves.toEqual({
            source: "none",
            error: "Codex usage endpoint returned 502",
        });

        globalThis.fetch = mock(async () => { throw new Error("kaput"); });
        await expect(codexWhamUsage({ configDir })).resolves.toMatchObject({
            source: "none",
            error: expect.stringContaining("Codex usage probe failed: kaput"),
        });
    });
});

describe("getAccountUsage provider routing", () => {
    test("routes every supported provider through its adapter", async () => {
        globalThis.fetch = mock(async () => jsonResponse(200, {}, {
            "anthropic-ratelimit-requests-limit": "100",
            "anthropic-ratelimit-requests-remaining": "99",
            "x-ratelimit-limit-requests": "50",
            "x-ratelimit-remaining-requests": "49",
        }));

        const claudeDir = tempDir();
        writeFileSync(join(claudeDir, ".credentials.json"), JSON.stringify({
            claudeAiOauth: { accessToken: "claude-token", expiresAt: 99999999999999 },
        }));
        const codexDir = tempDir();
        writeFileSync(join(codexDir, "auth.json"), JSON.stringify({
            tokens: { access_token: "codex-token", account_id: "acct" },
        }));

        const claude = await getAccountUsage({ label: "c", provider: "claude-code", configDir: claudeDir });
        expect(claude).toMatchObject({ provider: "claude-code", source: "oauth" });

        const codex = await getAccountUsage({ label: "x", provider: "codex", configDir: codexDir });
        expect(codex).toMatchObject({ provider: "codex", source: "oauth" });

        const anthropic = await getAccountUsage({ label: "a", provider: "anthropic-api", apiKey: "key" });
        expect(anthropic).toMatchObject({ provider: "anthropic-api", source: "headers" });

        const openai = await getAccountUsage({ label: "o", provider: "openai-api", apiKey: "key" });
        expect(openai).toMatchObject({ provider: "openai-api", source: "headers" });

        const antigravity = await getAccountUsage({ label: "g1", provider: "antigravity", configDir: "/x" });
        expect(antigravity).toMatchObject({ provider: "antigravity", source: "none" });

        const gemini = await getAccountUsage({ label: "g2", provider: "gemini-api", apiKey: "key" });
        expect(gemini).toMatchObject({ provider: "gemini-api", source: "none" });

        const unknown = await getAccountUsage({ label: "u", provider: "mystery", configDir: "/x" });
        expect(unknown).toMatchObject({ source: "none" });
        expect(unknown.error).toContain('Usage not supported for provider "mystery"');
    });
});

describe("pure helper branches", () => {
    test("decodeJwtClaims returns {} for an undecodable payload segment", () => {
        // A middle segment that base64-decodes to invalid JSON -> JSON.parse throws.
        expect(decodeJwtClaims("header.@@@@.sig")).toEqual({});
    });

    test("parseDurationSeconds handles microsecond units", () => {
        expect(parseDurationSeconds("500us")).toBeCloseTo(0.0005, 9);
        expect(parseDurationSeconds("500µs")).toBeCloseTo(0.0005, 9);
        expect(parseDurationSeconds("1s500us")).toBeCloseTo(1.0005, 9);
    });

    test("formatUsageReports renders the empty-windows note row for both error and none sources", () => {
        const out = formatUsageReports([
            {
                accountLabel: "erred", provider: "openai-api", authMode: "api-key",
                source: "none", stale: false, estimate: false,
                fetchedAt: "2026-06-03T00:00:00.000Z", windows: [], error: "boom happened",
            },
            {
                accountLabel: "silent", provider: "kimi", authMode: "subscription",
                source: "none", stale: false, estimate: false,
                fetchedAt: "2026-06-03T00:00:00.000Z", windows: [],
            },
        ], Date.parse("2026-06-03T00:00:00.000Z"));

        expect(out).toContain("boom happened");
        expect(out).toContain("not supported");
    });
});
