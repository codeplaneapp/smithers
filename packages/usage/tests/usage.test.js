import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    buildUsageReport,
    decodeJwtClaims,
    formatRelativeReset,
    formatUsageReports,
    getAccountUsage,
    getUsageForAccounts,
    humanizeDurationShort,
    parseAnthropicRateLimitHeaders,
    parseClaudeOauthUsage,
    parseCodexUsage,
    parseDurationSeconds,
    parseOpenAiRateLimitHeaders,
    publishedCapForTier,
    readUsageCache,
} from "../src/index.js";

/** @type {string[]} */
const tempDirs = [];
afterEach(() => {
    while (tempDirs.length) {
        const dir = tempDirs.pop();
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
});
function newSmithersHome() {
    const dir = mkdtempSync(join(tmpdir(), "smithers-usage-"));
    tempDirs.push(dir);
    return { SMITHERS_HOME: dir };
}

// fixed clock for deterministic relative-time assertions
const NOW = Date.parse("2026-06-03T00:00:00.000Z");
function isoIn(seconds) {
    return new Date(NOW + seconds * 1000).toISOString();
}
/** @param {Record<string, string>} map */
function getter(map) {
    return (name) => (name in map ? map[name] : null);
}

describe("parseDurationSeconds", () => {
    test("plain seconds and Go durations", () => {
        expect(parseDurationSeconds("30")).toBe(30);
        expect(parseDurationSeconds("1s")).toBe(1);
        expect(parseDurationSeconds("6m0s")).toBe(360);
        expect(parseDurationSeconds("1h2m3s")).toBe(3723);
        expect(parseDurationSeconds("800ms")).toBeCloseTo(0.8, 5);
    });
    test("bad input returns undefined", () => {
        expect(parseDurationSeconds(null)).toBeUndefined();
        expect(parseDurationSeconds("")).toBeUndefined();
        expect(parseDurationSeconds("nope")).toBeUndefined();
    });
});

describe("humanizeDurationShort", () => {
    test("scales units", () => {
        expect(humanizeDurationShort(-5)).toBe("now");
        expect(humanizeDurationShort(42)).toBe("42s");
        expect(humanizeDurationShort(3 * 60 + 5)).toBe("3m 5s");
        expect(humanizeDurationShort(2 * 3600 + 41 * 60)).toBe("2h 41m");
        expect(humanizeDurationShort(5 * 86400 + 3 * 3600)).toBe("5d 3h");
    });
});

describe("formatRelativeReset", () => {
    test("relative to a fixed now", () => {
        expect(formatRelativeReset(isoIn(2 * 3600), NOW)).toBe("2h 0m");
        expect(formatRelativeReset(undefined, NOW)).toBe("");
        expect(formatRelativeReset("garbage", NOW)).toBe("");
        expect(formatRelativeReset(isoIn(-100), NOW)).toBe("now");
    });
});

describe("parseClaudeOauthUsage", () => {
    test("extracts 5h, weekly, and per-model windows", () => {
        const windows = parseClaudeOauthUsage({
            five_hour: { utilization: 33, resets_at: isoIn(3600) },
            seven_day: { utilization: 13, resets_at: isoIn(86400) },
            seven_day_opus: { utilization: 5, resets_at: isoIn(86400) },
            seven_day_sonnet: null,
        });
        expect(windows.map((w) => w.id)).toEqual(["5h", "weekly", "weekly-opus"]);
        expect(windows[0]).toMatchObject({ unit: "percent", usedPercent: 33 });
    });
    test("tolerates junk", () => {
        expect(parseClaudeOauthUsage(null)).toEqual([]);
        expect(parseClaudeOauthUsage({ five_hour: { utilization: "x" } })).toEqual([]);
    });
});

describe("parseCodexUsage", () => {
    test("maps primary/secondary windows by duration", () => {
        const { windows, planType, credits } = parseCodexUsage({
            plan_type: "pro",
            rate_limits: {
                primary: { used_percent: 12.5, window_minutes: 300, reset_at: Math.floor(NOW / 1000) + 3600 },
                secondary: { used_percent: 40, window_minutes: 10080, reset_at: Math.floor(NOW / 1000) + 86400 },
            },
            credits: { has_credits: true, unlimited: false, balance: "12.34" },
        });
        expect(planType).toBe("pro");
        expect(windows.map((w) => w.id)).toEqual(["5h", "weekly"]);
        expect(windows[0].usedPercent).toBe(12.5);
        expect(windows[0].resetsAt).toBe(isoIn(3600));
        expect(credits).toEqual({ hasCredits: true, unlimited: false, balance: "12.34" });
    });
    test("accepts top-level rate-limit shape", () => {
        const { windows } = parseCodexUsage({
            primary: { used_percent: 1, window_minutes: 300 },
        });
        expect(windows).toHaveLength(1);
    });
});

describe("rate-limit header parsers", () => {
    test("anthropic headers -> count windows with used", () => {
        const windows = parseAnthropicRateLimitHeaders(getter({
            "anthropic-ratelimit-requests-limit": "1000",
            "anthropic-ratelimit-requests-remaining": "820",
            "anthropic-ratelimit-requests-reset": isoIn(60),
        }));
        expect(windows[0]).toMatchObject({ id: "requests-per-min", limit: 1000, remaining: 820, used: 180 });
    });
    test("openai headers -> reset computed from duration", () => {
        const windows = parseOpenAiRateLimitHeaders(getter({
            "x-ratelimit-limit-requests": "100",
            "x-ratelimit-remaining-requests": "99",
            "x-ratelimit-reset-requests": "6m0s",
        }), NOW);
        expect(windows[0]).toMatchObject({ id: "requests-per-min", remaining: 99, used: 1 });
        expect(windows[0].resetsAt).toBe(isoIn(360));
    });
    test("no headers -> no windows", () => {
        expect(parseAnthropicRateLimitHeaders(getter({}))).toEqual([]);
        expect(parseOpenAiRateLimitHeaders(getter({}), NOW)).toEqual([]);
    });
});

describe("decodeJwtClaims", () => {
    test("decodes the payload segment", () => {
        const payload = Buffer.from(JSON.stringify({ a: 1 })).toString("base64url");
        expect(decodeJwtClaims(`h.${payload}.sig`)).toEqual({ a: 1 });
    });
    test("junk -> empty", () => {
        expect(decodeJwtClaims(null)).toEqual({});
        expect(decodeJwtClaims("nope")).toEqual({});
    });
});

describe("publishedCapForTier", () => {
    test("known and unknown tiers", () => {
        expect(publishedCapForTier("code-assist-free")).toMatchObject({ requestsPerDay: 1000 });
        expect(publishedCapForTier("nope")).toBeUndefined();
        expect(publishedCapForTier(undefined)).toBeUndefined();
    });
});

describe("buildUsageReport", () => {
    test("api-key vs subscription authMode", () => {
        const api = buildUsageReport(
            { label: "o", provider: "openai-api", apiKey: "x" },
            { source: "headers", windows: [] },
            { nowIso: "2026-06-03T00:00:00.000Z" },
        );
        expect(api).toMatchObject({ authMode: "api-key", source: "headers", stale: false });
        const sub = buildUsageReport(
            { label: "c", provider: "claude-code", configDir: "/x" },
            { source: "oauth", windows: [], planType: "max" },
            { nowIso: "2026-06-03T00:00:00.000Z" },
        );
        expect(sub).toMatchObject({ authMode: "subscription", planType: "max" });
    });
});

describe("formatUsageReports", () => {
    test("renders a table with percent and count rows", () => {
        const out = formatUsageReports([
            {
                accountLabel: "claude-work", provider: "claude-code", authMode: "subscription",
                source: "oauth", planType: "max", stale: false, estimate: false,
                fetchedAt: isoIn(0),
                windows: [{ id: "5h", label: "5-hour session", unit: "percent", usedPercent: 33, resetsAt: isoIn(2 * 3600) }],
            },
            {
                accountLabel: "kimi-main", provider: "kimi", authMode: "subscription",
                source: "none", stale: false, estimate: false, fetchedAt: isoIn(0),
                windows: [], error: "Kimi exposes no usage endpoint yet",
            },
        ], NOW);
        expect(out).toContain("ACCOUNT");
        expect(out).toContain("claude-work");
        expect(out).toContain("33%");
        expect(out).toContain("2h 0m");
        expect(out).toContain("Kimi exposes no usage endpoint yet");
    });
    test("empty -> hint", () => {
        expect(formatUsageReports([], NOW)).toContain("No accounts registered");
    });
});

describe("getAccountUsage (no network for unsupported providers)", () => {
    test("kimi degrades to none", async () => {
        const report = await getAccountUsage({ label: "k", provider: "kimi", configDir: "/x" });
        expect(report).toMatchObject({ source: "none", windows: [] });
        expect(report.error).toContain("Kimi");
    });
});

describe("getUsageForAccounts caching", () => {
    test("writes on first read, serves stale within the floor", async () => {
        const env = newSmithersHome();
        const accounts = [{ label: "k", provider: "kimi", configDir: "/x" }];
        const first = await getUsageForAccounts(accounts, { env, nowMs: NOW });
        expect(first[0].stale).toBe(false);
        const cached = readUsageCache(env);
        expect(cached.entries.k).toBeDefined();
        // second read at the same instant is inside the 30s floor -> stale cache hit
        const second = await getUsageForAccounts(accounts, { env, nowMs: NOW + 1000 });
        expect(second[0].stale).toBe(true);
    });
});
