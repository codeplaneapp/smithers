import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    anthropicHeaderUsage,
    claudeOauthUsage,
    codexWhamUsage,
    formatUsageReports,
    getUsageForAccounts,
    googleUsage,
    humanizeDurationShort,
    openaiHeaderUsage,
    parseCodexUsage,
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
            claudeAiOauth: { accessToken: "claude-token", expiresAt: 123 },
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

    test("readClaudeCredentials falls back to macOS Keychain credentials", async () => {
        const spawnSync = mock((command, args) => {
            expect(command).toBe("security");
            expect(args).toEqual(["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
            return {
                status: 0,
                stdout: Buffer.from(JSON.stringify({
                    claudeAiOauth: { accessToken: "keychain-token", expiresAt: 789 },
                })),
            };
        });
        mock.module("node:child_process", () => ({ spawnSync }));
        const { readClaudeCredentials: readWithKeychain } = await import(
            `../src/readClaudeCredentials.js?keychain-success=${Date.now()}`
        );

        expect(readWithKeychain({}, "darwin")).toEqual({ accessToken: "keychain-token", expiresAt: 789 });
        expect(spawnSync).toHaveBeenCalledTimes(1);
    });

    test("readClaudeCredentials returns null when macOS Keychain has no credential", async () => {
        const spawnSync = mock(() => ({ status: 44, stdout: Buffer.from("") }));
        mock.module("node:child_process", () => ({ spawnSync }));
        const { readClaudeCredentials: readWithKeychainMiss } = await import(
            `../src/readClaudeCredentials.js?keychain-miss=${Date.now()}`
        );

        expect(readWithKeychainMiss({}, "darwin")).toBeNull();
        expect(spawnSync).toHaveBeenCalledTimes(1);
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
                provider: "gemini",
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
});

describe("getUsageForAccounts cache decisions", () => {
    test("--fresh bypasses the soft cache for non-floored providers", async () => {
        const env = { SMITHERS_HOME: tempDir() };
        writeUsageCache({
            version: 1,
            entries: {
                k: {
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
});
