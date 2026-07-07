import { describe, expect, test } from "bun:test";
import { classifyQuotaError } from "../src/BaseCliAgent/BaseCliAgent.js";

const NOW_MS = 1_750_000_000_000; // fixed reference point
const ctx = { nowMs: () => NOW_MS };

describe("classifyQuotaError — pattern detection", () => {
    test("detects 'hit your usage limit' (Codex ChatGPT ticket example)", () => {
        const msg = "You've hit your usage limit. Try again at Jun 18th, 2026 9:54 AM.";
        const err = classifyQuotaError(msg, "codex", ctx);
        expect(err).not.toBeNull();
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
        expect(err?.details?.failureQuota).toBe(true);
    });

    test("detects 'usage limit exceeded'", () => {
        const err = classifyQuotaError("usage limit exceeded", "codex", ctx);
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
    });

    test("detects 'quota exceeded'", () => {
        const err = classifyQuotaError("Your quota exceeded for this month", "codex", ctx);
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
    });

    test("detects 'rate limit exceeded'", () => {
        const err = classifyQuotaError("rate limit exceeded, please wait", "codex", ctx);
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
    });

    test("detects 'you have reached your usage'", () => {
        const err = classifyQuotaError("you have reached your usage limit", "codex", ctx);
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
    });

    test("detects 'you've reached your quota'", () => {
        const err = classifyQuotaError("you've reached your quota", "codex", ctx);
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
    });

    test("detects 'usage cap reached'", () => {
        const err = classifyQuotaError("usage cap reached", "codex", ctx);
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
    });

    test("detects 'too many requests'", () => {
        const err = classifyQuotaError("Too many requests, slow down", "codex", ctx);
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
    });

    test("detects 429 with try again", () => {
        const err = classifyQuotaError("Error 429: rate limit hit. Please try again later.", "codex", ctx);
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
    });

    test("detects Claude/Fable 'hit your session limit' banner", () => {
        const msg = "You've hit your session limit · resets 1:30am (America/New_York)";
        const err = classifyQuotaError(msg, "claude-code", ctx);
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
        expect(err?.details?.failureQuota).toBe(true);
    });

    test("detects Claude/Fable 'out of usage credits' banner", () => {
        const msg = "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models";
        const err = classifyQuotaError(msg, "claude-code", ctx);
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
    });

    test("returns null for generic errors", () => {
        expect(classifyQuotaError("network timeout", "codex", ctx)).toBeNull();
        expect(classifyQuotaError("model not found", "codex", ctx)).toBeNull();
        expect(classifyQuotaError("invalid api key", "codex", ctx)).toBeNull();
        expect(classifyQuotaError("", "codex", ctx)).toBeNull();
    });
});

describe("classifyQuotaError — reset time parsing", () => {
    test("parses ordinal date format: 'try again at Jun 18th, 2026 9:54 AM'", () => {
        // Use a now well before June 2026
        const pastCtx = { nowMs: () => 1_000_000 };
        const msg = "You've hit your usage limit. Try again at Jun 18th, 2026 9:54 AM.";
        const err = classifyQuotaError(msg, "codex", pastCtx);
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
        // Should have parsed a reset time (date is in the future relative to nowMs=1000)
        expect(typeof err?.details?.quotaResetAtMs).toBe("number");
        expect(err?.details?.quotaResetAtMs).toBeGreaterThan(0);
    });

    test("parses 'resets 1:30am (America/New_York)' zoned clock format", () => {
        // 2025-06-15T12:00:00Z — well before the next 1:30am ET occurrence.
        const noonUtc = Date.parse("2025-06-15T12:00:00Z");
        const msg = "You've hit your session limit · resets 1:30am (America/New_York)";
        const err = classifyQuotaError(msg, "claude-code", { nowMs: () => noonUtc });
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
        const resetAt = err?.details?.quotaResetAtMs;
        expect(typeof resetAt).toBe("number");
        // 1:30am ET on 2025-06-16 (EDT, UTC-4) is 05:30 UTC the next day.
        expect(resetAt).toBe(Date.parse("2025-06-16T05:30:00Z"));
    });

    test("parses 'Your limit will reset at 4pm (Asia/Kolkata)' banner", () => {
        const noonUtc = Date.parse("2025-06-15T04:00:00Z");
        const msg = "Claude usage limit reached. Your limit will reset at 4pm (Asia/Kolkata).";
        const err = classifyQuotaError(msg, "claude-code", { nowMs: () => noonUtc });
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
        expect(typeof err?.details?.quotaResetAtMs).toBe("number");
        expect(err?.details?.quotaResetAtMs).toBeGreaterThan(noonUtc);
    });

    test("parses 'retry after N seconds' format", () => {
        const msg = "Rate limit exceeded. Retry after 60 seconds.";
        const err = classifyQuotaError(msg, "codex", ctx);
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
        expect(typeof err?.details?.quotaResetAtMs).toBe("number");
        // Should be approximately NOW_MS + 60_000
        const resetAt = err?.details?.quotaResetAtMs;
        expect(resetAt).toBeGreaterThanOrEqual(NOW_MS + 59_000);
        expect(resetAt).toBeLessThanOrEqual(NOW_MS + 61_000);
    });

    test("does not set quotaResetAtMs when no reset time present", () => {
        const msg = "You've hit your usage limit.";
        const err = classifyQuotaError(msg, "codex", ctx);
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
        expect(err?.details?.quotaResetAtMs).toBeUndefined();
    });

    test("does not set quotaResetAtMs when parsed date is in the past", () => {
        // Pass a nowMs well in the future so the date is always in the past
        const futureCtx = { nowMs: () => 9_999_999_999_999 };
        const msg = "You've hit your usage limit. Try again at Jun 18th, 2026 9:54 AM.";
        const err = classifyQuotaError(msg, "codex", futureCtx);
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
        expect(err?.details?.quotaResetAtMs).toBeUndefined();
    });
});

describe("classifyQuotaError — error metadata", () => {
    test("embeds agentId, agentModel, agentEngine from context", () => {
        const msg = "You've hit your usage limit.";
        const err = classifyQuotaError(msg, "codex", {
            ...ctx,
            agentId: "my-agent",
            agentModel: "gpt-5.4-mini",
            agentEngine: "codex",
        });
        expect(err?.details?.agentId).toBe("my-agent");
        expect(err?.details?.agentModel).toBe("gpt-5.4-mini");
        expect(err?.details?.agentEngine).toBe("codex");
    });

    test("uses <anonymous>/<unset> defaults when context is absent", () => {
        const msg = "quota exceeded";
        const err = classifyQuotaError(msg, "codex");
        expect(err?.details?.agentId).toBe("<anonymous>");
        expect(err?.details?.agentModel).toBe("<unset>");
    });
});

describe("classifyQuotaError — machine tokens", () => {
    test("detects out_of_credits (claude rate_limit_event overageDisabledReason)", () => {
        const err = classifyQuotaError('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","overageStatus":"rejected","overageDisabledReason":"out_of_credits"}}', "claude");
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
        expect(err?.details?.failureQuota).toBe(true);
    });
    test("detects usage_limit_reached (codex 429 body)", () => {
        const err = classifyQuotaError('http 429 Too Many Requests: {"error":{"type":"usage_limit_reached","plan_type":"pro"}}', "codex");
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
    });
    test("detects a rejected rate_limit_event JSON line", () => {
        const err = classifyQuotaError('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1781766000,"rateLimitType":"five_hour"}}', "claude");
        expect(err?.code).toBe("AGENT_QUOTA_EXCEEDED");
    });
    test("does not classify an allowed rate_limit_event", () => {
        const err = classifyQuotaError('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour"}}', "claude");
        expect(err).toBeNull();
    });
});
