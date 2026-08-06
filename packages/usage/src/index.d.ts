import * as _smthrs_accounts from '@smthrs/accounts';
import { AccountProvider } from '@smthrs/accounts';
import { spawnSync } from 'node:child_process';

/**
 * Where a usage report's numbers came from.
 *
 * - `oauth`   — an authenticated subscription usage endpoint (Claude, Codex).
 * - `headers` — live rate-limit response headers from an API-key request.
 * - `local`   — estimated locally from token logs (Google providers).
 * - `none`    — the provider exposes no usage surface, or the probe failed.
 */
type UsageSource = "oauth" | "headers" | "local" | "none";

/**
 * One quota window for an account: a 5-hour session, a weekly cap, a per-minute
 * request bucket, and so on.
 *
 * The `unit` decides which fields are meaningful:
 * - `percent`   — subscription utilization; read `usedPercent` (0–100).
 * - `count`     — API-key buckets; read `limit`, `remaining`, `used`.
 * - `estimated` — locally estimated; read `usedPercent`/`used`/`limit`, treat as
 *                 a lower bound, never as authoritative.
 */
type UsageWindow$5 = {
    /** Stable id, e.g. "5h" | "weekly" | "requests-per-min" | "tokens-per-min". */
    id: string;
    /** Human label, e.g. "5-hour session". */
    label: string;
    /** Which fields below are meaningful. */
    unit: "percent" | "count" | "estimated";
    /** 0–100. Set for `percent` and `estimated`. */
    usedPercent?: number;
    /** Absolute amount consumed. Set for `count` and `estimated`. */
    used?: number;
    /** Absolute cap. Set for `count` and `estimated`. */
    limit?: number;
    /** `limit - used`. Set for `count`. */
    remaining?: number;
    /** ISO-8601 timestamp when this window rolls over. */
    resetsAt?: string;
};

/**
 * Normalized usage for a single registered account. Every adapter — subscription
 * utilization, API-key headers, local estimate — produces this same shape so the
 * CLI, gateway, and UI render one model.
 */
type UsageReport$5 = {
    /** The account's label in `~/.smithers/accounts.json`. */
    accountLabel: string;
    /** The account's provider. */
    provider: AccountProvider;
    /** How this account authenticates. */
    authMode: "subscription" | "api-key";
    /** Where the numbers came from. */
    source: UsageSource;
    /** Quota windows, possibly empty when `source` is `none`. */
    windows: UsageWindow$5[];
    /** Plan/tier label if the provider reports one, e.g. "max", "pro". */
    planType?: string;
    /** Pay-as-you-go credit balance, if the provider reports one (Codex). */
    credits?: {
        hasCredits: boolean;
        unlimited: boolean;
        balance?: string;
    };
    /** ISO-8601 timestamp of when this report was produced. */
    fetchedAt: string;
    /** True when served from cache past its soft TTL. */
    stale: boolean;
    /** True when the windows are locally estimated, not provider-authoritative. */
    estimate: boolean;
    /** Human-readable reason when `source` is `none` or a probe failed. */
    error?: string;
};

/** @typedef {import("@smthrs/accounts").Account} Account */
/** @typedef {import("./UsageReport.ts").UsageReport} UsageReport */
/**
 * Routes an account to its usage adapter and returns a normalized report. This
 * switch mirrors `accountToProviderEnv` in the accounts package so the two stay
 * structurally aligned. Adapters never throw; they degrade to a `none` report.
 *
 * Credentials are read on the host that owns them and only the normalized report
 * leaves this function — no token is ever returned or logged.
 *
 * @param {Account} account
 * @returns {Promise<UsageReport>}
 */
declare function getAccountUsage(account: Account$3): Promise<UsageReport$4>;
type Account$3 = _smthrs_accounts.Account;
type UsageReport$4 = UsageReport$5;

/**
 * Gathers usage for many accounts in parallel, served through the on-disk cache.
 * Cached reports come back with `stale: true`. The cache is read once and written
 * once, so parallel probes never race on the file.
 *
 * @param {Account[]} accounts
 * @param {{ fresh?: boolean; env?: NodeJS.ProcessEnv; nowMs?: number }} [options]
 * @returns {Promise<UsageReport[]>}
 */
declare function getUsageForAccounts(accounts: Account$2[], options?: {
    fresh?: boolean;
    env?: NodeJS.ProcessEnv;
    nowMs?: number;
}): Promise<UsageReport$3[]>;
type Account$2 = _smthrs_accounts.Account;
type UsageReport$3 = UsageReport$5;

/** @typedef {import("@smthrs/accounts").Account} Account */
/** @typedef {import("./UsageReport.ts").UsageReport} UsageReport */
/** @typedef {import("./UsageWindow.ts").UsageWindow} UsageWindow */
/**
 * The partial result an adapter returns. The dispatcher wraps it with the
 * account identity and timestamp to form a complete {@link UsageReport}.
 *
 * @typedef {object} UsageProbe
 * @property {import("./UsageSource.ts").UsageSource} source
 * @property {UsageWindow[]} [windows]
 * @property {string} [planType]
 * @property {{ hasCredits: boolean; unlimited: boolean; balance?: string }} [credits]
 * @property {boolean} [estimate]
 * @property {string} [error]
 */
/**
 * Assembles a full usage report from an account and an adapter probe. Keeps the
 * adapters free of repeated identity/timestamp boilerplate.
 *
 * @param {Account} account
 * @param {UsageProbe} probe
 * @param {{ nowIso?: string }} [options]
 * @returns {UsageReport}
 */
declare function buildUsageReport(account: Account$1, probe: UsageProbe$6, options?: {
    nowIso?: string;
}): UsageReport$2;
type Account$1 = _smthrs_accounts.Account;
type UsageReport$2 = UsageReport$5;
/**
 * The partial result an adapter returns. The dispatcher wraps it with the
 * account identity and timestamp to form a complete {@link UsageReport}.
 */
type UsageProbe$6 = {
    source: UsageSource;
    windows?: UsageWindow$5[] | undefined;
    planType?: string | undefined;
    credits?: {
        hasCredits: boolean;
        unlimited: boolean;
        balance?: string;
    } | undefined;
    estimate?: boolean | undefined;
    error?: string | undefined;
};

/**
 * Renders an array of usage reports as an aligned text table. Pure: pass a fixed
 * `nowMs` in tests to get deterministic "resets in" values.
 *
 * @param {UsageReport[]} reports
 * @param {number} [nowMs]
 * @returns {string}
 */
declare function formatUsageReports(reports: UsageReport$1[], nowMs?: number): string;
type UsageReport$1 = UsageReport$5;

/**
 * Formats an ISO reset timestamp as a relative "resets in" string. Returns an
 * empty string when there is no timestamp, and `"now"` when it is in the past.
 *
 * @param {string | undefined} resetsAt
 * @param {number} [nowMs]
 * @returns {string}
 */
declare function formatRelativeReset(resetsAt: string | undefined, nowMs?: number): string;

/**
 * Formats a number of seconds as a short human duration, e.g. `"2h 41m"`,
 * `"5d 3h"`, `"42s"`. Used for "resets in" columns. Non-positive or non-finite
 * input renders as `"now"`.
 *
 * @param {number} seconds
 * @returns {string}
 */
declare function humanizeDurationShort(seconds: number): string;

/**
 * Normalizes the Claude Code subscription usage payload into usage windows. The
 * payload powers the in-CLI `/usage` view: a 5-hour rolling window, a weekly
 * window, and optional per-model weekly windows.
 *
 * @param {unknown} payload
 * @returns {UsageWindow[]}
 */
declare function parseClaudeOauthUsage(payload: unknown): UsageWindow$4[];
type UsageWindow$4 = UsageWindow$5;

/**
 * Normalizes the Codex usage payload (from `GET /backend-api/wham/usage`, or the
 * `codex.rate_limits` event) into windows plus plan and credit metadata. The
 * rate-limit object may sit at the top level, under a `rate_limits` key (the
 * app-server/event shape, with `primary`/`secondary` windows), or under a
 * `rate_limit` key (the HTTP shape, with `primary_window`/`secondary_window`);
 * all are accepted. Either window may be null/absent — OpenAI removed the
 * 5-hour window from some plans, leaving only the weekly window — and each is
 * parsed independently so a surviving window still surfaces.
 *
 * @param {unknown} payload
 * @returns {{ windows: UsageWindow[]; planType?: string; credits?: { hasCredits: boolean; unlimited: boolean; balance?: string } }}
 */
declare function parseCodexUsage(payload: unknown): {
    windows: UsageWindow$3[];
    planType?: string;
    credits?: {
        hasCredits: boolean;
        unlimited: boolean;
        balance?: string;
    };
};
type UsageWindow$3 = UsageWindow$5;

/**
 * Normalizes the Kimi for Coding usage payload (`GET /coding/v1/usages`) into
 * windows plus plan metadata. The top-level `usage` block is the weekly quota;
 * `limits[]` carries shorter rate windows (observed: a 300-minute window);
 * `parallel` is the concurrent-session cap, reported as a count window.
 *
 * @param {unknown} payload
 * @returns {{ windows: UsageWindow[]; planType?: string }}
 */
declare function parseKimiUsage(payload: unknown): {
    windows: UsageWindow$2[];
    planType?: string;
};
type UsageWindow$2 = UsageWindow$5;

/**
 * Parses Anthropic rate-limit response headers into usage windows. Anthropic
 * returns RFC-3339 reset timestamps directly, so no clock math is needed.
 *
 * Pass a getter, e.g. `(name) => response.headers.get(name)`.
 *
 * @param {(name: string) => string | null | undefined} get
 * @returns {UsageWindow[]}
 */
declare function parseAnthropicRateLimitHeaders(get: (name: string) => string | null | undefined): UsageWindow$1[];
type UsageWindow$1 = UsageWindow$5;

/**
 * Parses OpenAI rate-limit response headers into usage windows. OpenAI's reset
 * headers are Go-duration strings relative to "now", so `nowMs` is added to
 * produce an absolute ISO reset time (pass a fixed value in tests).
 *
 * Pass a getter, e.g. `(name) => response.headers.get(name)`.
 *
 * @param {(name: string) => string | null | undefined} get
 * @param {number} [nowMs]
 * @returns {UsageWindow[]}
 */
declare function parseOpenAiRateLimitHeaders(get: (name: string) => string | null | undefined, nowMs?: number): UsageWindow[];
type UsageWindow = UsageWindow$5;

/**
 * Parses a Go-style duration string into seconds. OpenAI's rate-limit reset
 * headers use this format, e.g. `"1s"`, `"6m0s"`, `"1h2m3s"`, `"800ms"`.
 *
 * Returns `undefined` for input it cannot parse, so callers can omit a reset
 * time rather than render a wrong one.
 *
 * @param {string | null | undefined} value
 * @returns {number | undefined}
 */
declare function parseDurationSeconds(value: string | null | undefined): number | undefined;

/**
 * Decodes the claims (the middle segment) of a JWT without verifying its
 * signature. Used to read the `chatgpt_account_id` claim out of the Codex
 * `id_token` when `auth.json` does not carry `tokens.account_id` directly.
 *
 * Verification is intentionally skipped: the token already authenticated the
 * user with the provider, and we only read a non-secret routing claim from it.
 *
 * Returns an empty object for anything that is not a decodable JWT.
 *
 * @param {string | null | undefined} token
 * @returns {Record<string, unknown>}
 */
declare function decodeJwtClaims(token: string | null | undefined): Record<string, unknown>;

/**
 * Reads the Claude Code subscription OAuth token for an account. Tries the
 * account's `configDir/.credentials.json` first (the cross-platform location
 * when `CLAUDE_CONFIG_DIR` is set), then the macOS Keychain: Claude Code keys
 * per-config-dir logins as `Claude Code-credentials-<first 8 hex of
 * sha256(configDir)>`, so an isolated account's item is tried before the
 * unsuffixed default-install item. For accounts with a `configDir`, the
 * unsuffixed item is NOT used as a fallback — it belongs to the default
 * `~/.claude` login and would silently attribute another account's token.
 *
 * Returns `null` when no credential can be read, so the adapter degrades to a
 * "none" report rather than throwing. The token is returned only to mint an
 * outbound Authorization header; callers must never log or persist it.
 *
 * @param {{ configDir?: string }} account
 * @param {NodeJS.Platform} [platform]
 * @param {typeof spawnSync} [spawn] Injectable for tests; defaults to `node:child_process` `spawnSync`.
 * @returns {{ accessToken: string; expiresAt?: number } | null}
 */
declare function readClaudeCredentials(account: {
    configDir?: string;
}, platform?: NodeJS.Platform, spawn?: typeof spawnSync): {
    accessToken: string;
    expiresAt?: number;
} | null;

/**
 * Reads the Codex ChatGPT-subscription OAuth token for an account from
 * `configDir/auth.json` (the per-account `CODEX_HOME`). The ChatGPT account id
 * comes from `tokens.account_id`, or failing that the `chatgpt_account_id`
 * claim inside the `id_token` JWT.
 *
 * Returns `null` when no credential can be read or the account uses an API key
 * instead of ChatGPT auth. The token is returned only to mint an outbound
 * Authorization header.
 *
 * @param {{ configDir?: string }} account
 * @returns {{ accessToken: string; accountId?: string } | null}
 */
declare function readCodexCredentials(account: {
    configDir?: string;
}): {
    accessToken: string;
    accountId?: string;
} | null;

/**
 * Reads the Kimi for Coding OAuth token for an account from
 * `configDir/credentials/kimi-code.json` (the per-account `KIMI_SHARE_DIR`).
 * Kimi access tokens live ~15 minutes, so callers should expect
 * `expiresAtMs` to be in the past and refresh via `refreshKimiToken`.
 *
 * Returns `null` when no credential can be read. The token is returned only
 * to mint an outbound Authorization header or a refresh grant.
 *
 * @param {{ configDir?: string }} account
 * @returns {{ accessToken: string; refreshToken?: string; expiresAtMs?: number } | null}
 */
declare function readKimiCredentials(account: {
    configDir?: string;
}): {
    accessToken: string;
    refreshToken?: string;
    expiresAtMs?: number;
} | null;

/**
 * @typedef {object} KimiRefreshSuccess
 * @property {true} ok
 * @property {string} accessToken
 * @property {number | undefined} expiresAtMs
 */
/**
 * @typedef {object} KimiRefreshFailure
 * @property {false} ok
 * @property {string} error
 * @property {boolean} reauth True when the refresh grant is dead and the user must re-login.
 */
/**
 * Refreshes a Kimi for Coding OAuth token against
 * `POST {KIMI_CODE_OAUTH_HOST|KIMI_OAUTH_HOST|auth.kimi.com}/api/oauth/token`
 * (the same client_id and grant the official kimi CLI uses) and persists the
 * rotated tokens back to `credentials/kimi-code.json` so the CLI keeps working.
 *
 * Refresh tokens rotate on every refresh. Before writing, the credentials file
 * is re-read: when another process (a running kimi CLI) already rotated the
 * grant, the on-disk tokens win and the just-refreshed pair is discarded —
 * writing ours would orphan the file's newer refresh token.
 *
 * @param {{ configDir?: string }} account
 * @param {string} refreshToken
 * @returns {Promise<KimiRefreshSuccess | KimiRefreshFailure>}
 */
declare function refreshKimiToken(account: {
    configDir?: string;
}, refreshToken: string): Promise<KimiRefreshSuccess | KimiRefreshFailure>;
type KimiRefreshSuccess = {
    ok: true;
    accessToken: string;
    expiresAtMs: number | undefined;
};
type KimiRefreshFailure = {
    ok: false;
    error: string;
    /**
     * True when the refresh grant is dead and the user must re-login.
     */
    reauth: boolean;
};

/**
 * Probes the Claude Code subscription usage endpoint for an account's 5-hour and
 * weekly utilization. Undocumented and best-effort: any failure degrades to a
 * `none` report with a readable reason.
 *
 * @param {{ configDir?: string }} account
 * @param {typeof readClaudeCredentials} [readCreds] Injectable for tests; defaults to `readClaudeCredentials`.
 * @returns {Promise<UsageProbe>}
 */
declare function claudeOauthUsage(account: {
    configDir?: string;
}, readCreds?: typeof readClaudeCredentials): Promise<UsageProbe$5>;
type UsageProbe$5 = UsageProbe$6;

/**
 * Probes the Codex ChatGPT-subscription usage endpoint for an account's 5-hour
 * and weekly windows. This is the same data the Codex `/status` view shows and
 * does not spend a turn. Undocumented and best-effort.
 *
 * @param {{ configDir?: string }} account
 * @returns {Promise<UsageProbe>}
 */
declare function codexWhamUsage(account: {
    configDir?: string;
}): Promise<UsageProbe$4>;
type UsageProbe$4 = UsageProbe$6;

/**
 * Probes the Kimi for Coding usage endpoint (`GET /coding/v1/usages`) for an
 * account's weekly quota, shorter rate windows, and parallel-session count.
 * This is the same data the kimi CLI's `/usage` command shows. Kimi access
 * tokens expire after ~15 minutes, so an expired token is refreshed with the
 * on-disk refresh token first. Undocumented and best-effort.
 *
 * @param {{ configDir?: string }} account
 * @returns {Promise<UsageProbe>}
 */
declare function kimiCodeUsage(account: {
    configDir?: string;
}): Promise<UsageProbe$3>;
type UsageProbe$3 = UsageProbe$6;

/**
 * Reads live Anthropic rate-limit headers for an API-key account. Uses the
 * `count_tokens` endpoint, which returns the rate-limit header family without
 * producing output tokens.
 *
 * @param {{ apiKey?: string }} account
 * @returns {Promise<UsageProbe>}
 */
declare function anthropicHeaderUsage(account: {
    apiKey?: string;
}): Promise<UsageProbe$2>;
type UsageProbe$2 = UsageProbe$6;

/**
 * Reads live OpenAI rate-limit headers for an API-key account.
 *
 * @param {{ apiKey?: string }} account
 * @returns {Promise<UsageProbe>}
 */
declare function openaiHeaderUsage(account: {
    apiKey?: string;
}): Promise<UsageProbe$1>;
type UsageProbe$1 = UsageProbe$6;

/** @typedef {import("./buildUsageReport.js").UsageProbe} UsageProbe */
/**
 * Google (Gemini, Antigravity, Gemini API) exposes no live "remaining quota"
 * surface to a personal-login or API-key client: there are no rate-limit
 * response headers, only a 429 `RESOURCE_EXHAUSTED` after the wall is hit. The
 * documented path forward is local token-log accounting against published caps
 * (see `publishedCaps.js`), which depends on run-history integration and lands
 * in a later phase. Until then this reports `none` honestly rather than inventing
 * a number.
 *
 * @param {{ provider: string }} account
 * @returns {Promise<UsageProbe>}
 */
declare function googleUsage(account: {
    provider: string;
}): Promise<UsageProbe>;
type UsageProbe = UsageProbe$6;

/**
 * Looks up a published cap by tier id. Returns `undefined` for unknown tiers so
 * the caller can degrade to "unknown" rather than invent a number.
 *
 * @param {string | undefined} tier
 * @returns {{ label: string; requestsPerDay: number; rpm?: number } | undefined}
 */
declare function publishedCapForTier(tier: string | undefined): {
    label: string;
    requestsPerDay: number;
    rpm?: number;
} | undefined;
/**
 * Published daily request caps for Google providers, keyed by tier. Google does
 * not expose a live "remaining quota" surface to a personal-login or API-key
 * client, so any usage estimate must subtract local request counts from these
 * documented caps. The numbers move (and the personal Code Assist tiers in the
 * Gemini CLI stop serving 2026-06-18), so they live here as data, not logic.
 *
 * @type {Record<string, { label: string; requestsPerDay: number; rpm?: number }>}
 */
declare const PUBLISHED_CAPS: Record<string, {
    label: string;
    requestsPerDay: number;
    rpm?: number;
}>;

/** @typedef {import("./UsageReport.ts").UsageReport} UsageReport */
/** @typedef {import("@smthrs/accounts").Account} Account */
/** @typedef {{ provider: Account["provider"]; configDir?: string; model?: string; apiKeyHash?: string }} UsageCacheAccountIdentity */
/** @typedef {{ version: 1; entries: Record<string, { identity?: UsageCacheAccountIdentity; report: UsageReport }> }} UsageCacheFile */
/**
 * Path to the on-disk usage cache. Lives next to `accounts.json` under the
 * Smithers root so it honors `SMITHERS_HOME` in tests and CI.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
declare function usageCachePath(env?: NodeJS.ProcessEnv): string;
/**
 * Reads the usage cache, returning an empty cache when the file is missing or
 * malformed (a cold cache is the normal startup state, not an error).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {UsageCacheFile}
 */
declare function readUsageCache(env?: NodeJS.ProcessEnv): UsageCacheFile;
/**
 * Writes the usage cache atomically with mode 0600.
 *
 * @param {UsageCacheFile} contents
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} the path written
 */
declare function writeUsageCache(contents: UsageCacheFile, env?: NodeJS.ProcessEnv): string;
type UsageReport = UsageReport$5;
type Account = _smthrs_accounts.Account;
type UsageCacheAccountIdentity = {
    provider: Account["provider"];
    configDir?: string;
    model?: string;
    apiKeyHash?: string;
};
type UsageCacheFile = {
    version: 1;
    entries: Record<string, {
        identity?: UsageCacheAccountIdentity;
        report: UsageReport;
    }>;
};

export { PUBLISHED_CAPS, type UsageReport$5 as UsageReport, type UsageWindow$5 as UsageWindow, anthropicHeaderUsage, buildUsageReport, claudeOauthUsage, codexWhamUsage, decodeJwtClaims, formatRelativeReset, formatUsageReports, getAccountUsage, getUsageForAccounts, googleUsage, humanizeDurationShort, kimiCodeUsage, openaiHeaderUsage, parseAnthropicRateLimitHeaders, parseClaudeOauthUsage, parseCodexUsage, parseDurationSeconds, parseKimiUsage, parseOpenAiRateLimitHeaders, publishedCapForTier, readClaudeCredentials, readCodexCredentials, readKimiCredentials, readUsageCache, refreshKimiToken, usageCachePath, writeUsageCache };
