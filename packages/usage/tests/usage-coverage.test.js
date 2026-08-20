import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  anthropicHeaderUsage,
  accountUsageScore,
  accountQuotaBlock,
  clearAccountQuotaLimit,
  claudeOauthUsage,
  codexWhamUsage,
  decodeJwtClaims,
  formatUsageReports,
  getAccountUsage,
  getUsageForAccounts,
  googleUsage,
  humanizeDurationShort,
  kimiCodeUsage,
  openaiHeaderUsage,
  orderAccountsByUsage,
  parseAnthropicRateLimitHeaders,
  parseCodexUsage,
  parseDurationSeconds,
  parseKimiUsage,
  parseOpenAiRateLimitHeaders,
  readUsageCache,
  readAccountQuotaState,
  readClaudeCredentials,
  readCodexCredentials,
  readKimiCredentials,
  refreshKimiToken,
  recordAccountQuotaLimit,
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
      return jsonResponse(
        429,
        {},
        {
          "anthropic-ratelimit-requests-limit": "100",
          "anthropic-ratelimit-requests-remaining": "0",
          "anthropic-ratelimit-requests-reset": "2026-06-03T00:01:00.000Z",
          "retry-after": "12",
        },
      );
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
      return jsonResponse(
        200,
        {},
        {
          "x-ratelimit-limit-requests": "50",
          "x-ratelimit-remaining-requests": "49",
          "x-ratelimit-reset-requests": "1s",
        },
      );
    });

    const usage = await openaiHeaderUsage({ apiKey: "openai-key" });

    expect(usage).toMatchObject({ source: "headers" });
    expect(usage.windows[0]).toMatchObject({ id: "requests-per-min", limit: 50, remaining: 49, used: 1 });
  });

  test("claudeOauthUsage reads credentials and parses OAuth usage fixtures", async () => {
    const configDir = tempDir();
    writeFileSync(
      join(configDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "claude-token", expiresAt: 99999999999999 },
      }),
    );
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
    writeFileSync(
      join(configDir, "auth.json"),
      JSON.stringify({
        tokens: { access_token: "codex-token", account_id: "acct-direct" },
      }),
    );
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

  test("kimiCodeUsage refreshes an expired token, probes, and parses the live payload shape", async () => {
    const configDir = tempDir();
    mkdirSync(join(configDir, "credentials"), { recursive: true });
    writeFileSync(
      join(configDir, "credentials", "kimi-code.json"),
      JSON.stringify({
        access_token: "kimi-old",
        refresh_token: "kimi-refresh-1",
        expires_at: 1,
        expires_in: 900,
        scope: "kimi-code",
        token_type: "Bearer",
      }),
    );

    const calls = [];
    globalThis.fetch = mock(async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        expect(url).toBe("https://auth.kimi.com/api/oauth/token");
        expect(init.method).toBe("POST");
        expect(String(init.body)).toContain("grant_type=refresh_token");
        expect(String(init.body)).toContain("refresh_token=kimi-refresh-1");
        return jsonResponse(200, {
          access_token: "kimi-fresh",
          refresh_token: "kimi-refresh-2",
          expires_in: 900,
          scope: "kimi-code",
          token_type: "Bearer",
        });
      }
      expect(url).toBe("https://api.kimi.com/coding/v1/usages");
      expect(init.headers.Authorization).toBe("Bearer kimi-fresh");
      return jsonResponse(200, {
        user: { userId: "u1", region: "REGION_OVERSEA", membership: { level: "LEVEL_STANDARD" } },
        usage: { limit: "100", used: "73", remaining: "27", resetTime: "2026-07-31T15:57:51.057807Z" },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", used: "5", remaining: "95", resetTime: "2026-07-30T05:57:51.057807Z" },
          },
        ],
        parallel: { limit: "30", details: ["a", "b", "c"] },
        authentication: { method: "METHOD_API_KEY", scope: "FEATURE_CODING" },
      });
    });

    const usage = await kimiCodeUsage({ configDir });

    expect(calls).toHaveLength(2);
    expect(usage).toMatchObject({ source: "oauth", planType: "standard" });
    expect(usage.windows.map((w) => w.id)).toEqual(["weekly", "5h", "parallel-sessions"]);
    expect(usage.windows[0]).toMatchObject({ unit: "percent", usedPercent: 73, resetsAt: "2026-07-31T15:57:51.057Z" });
    expect(usage.windows[1]).toMatchObject({ label: "5-hour", usedPercent: 5 });
    expect(usage.windows[2]).toMatchObject({ unit: "count", used: 3, limit: 30, remaining: 27 });

    const persisted = JSON.parse(readFileSync(join(configDir, "credentials", "kimi-code.json"), "utf8"));
    expect(persisted.access_token).toBe("kimi-fresh");
    expect(persisted.refresh_token).toBe("kimi-refresh-2");
    expect(persisted.expires_at).toBeGreaterThan(Date.now() / 1000);
  });

  test("kimiCodeUsage skips the refresh when the on-disk token is still live", async () => {
    const configDir = tempDir();
    mkdirSync(join(configDir, "credentials"), { recursive: true });
    writeFileSync(
      join(configDir, "credentials", "kimi-code.json"),
      JSON.stringify({
        access_token: "kimi-live",
        refresh_token: "kimi-refresh",
        expires_at: Date.now() / 1000 + 600,
      }),
    );
    globalThis.fetch = mock(async (url, init) => {
      expect(url).toBe("https://api.kimi.com/coding/v1/usages");
      expect(init.headers.Authorization).toBe("Bearer kimi-live");
      return jsonResponse(200, { usage: { limit: "100", used: "10" } });
    });

    const usage = await kimiCodeUsage({ configDir });

    expect(usage.source).toBe("oauth");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("kimiCodeUsage degrades on missing creds, dead refresh grant, rejection, non-ok, and throw", async () => {
    await expect(kimiCodeUsage({ configDir: tempDir() })).resolves.toEqual({
      source: "none",
      error: "No Kimi OAuth credentials in configDir/credentials/kimi-code.json",
    });

    const configDir = tempDir();
    mkdirSync(join(configDir, "credentials"), { recursive: true });
    writeFileSync(
      join(configDir, "credentials", "kimi-code.json"),
      JSON.stringify({ access_token: "kimi-old", refresh_token: "dead-grant", expires_at: 1 }),
    );

    globalThis.fetch = mock(async () => jsonResponse(400, { error: "invalid_grant" }));
    await expect(kimiCodeUsage({ configDir })).resolves.toMatchObject({
      source: "none",
      error: expect.stringContaining("rejected"),
    });

    globalThis.fetch = mock(async (url) => {
      if (String(url).includes("auth.kimi.com")) {
        return jsonResponse(200, { access_token: "kimi-fresh", refresh_token: "r2", expires_in: 900 });
      }
      return jsonResponse(401, {});
    });
    await expect(kimiCodeUsage({ configDir })).resolves.toMatchObject({
      source: "none",
      error: expect.stringContaining("rejected (401)"),
    });

    globalThis.fetch = mock(async (url) => {
      if (String(url).includes("auth.kimi.com")) {
        return jsonResponse(200, { access_token: "kimi-fresh", refresh_token: "r2", expires_in: 900 });
      }
      return jsonResponse(502, {});
    });
    await expect(kimiCodeUsage({ configDir })).resolves.toEqual({
      source: "none",
      error: "Kimi usage endpoint returned 502",
    });

    globalThis.fetch = mock(async (url) => {
      if (String(url).includes("auth.kimi.com")) {
        return jsonResponse(200, { access_token: "kimi-fresh", refresh_token: "r2", expires_in: 900 });
      }
      throw new Error("kaput");
    });
    await expect(kimiCodeUsage({ configDir })).resolves.toMatchObject({
      source: "none",
      error: expect.stringContaining("Kimi usage probe failed: kaput"),
    });
  });

  test("refreshKimiToken keeps a concurrently rotated on-disk credential", async () => {
    const configDir = tempDir();
    mkdirSync(join(configDir, "credentials"), { recursive: true });
    const path = join(configDir, "credentials", "kimi-code.json");
    writeFileSync(path, JSON.stringify({ access_token: "old", refresh_token: "sent-grant", expires_at: 1 }));
    globalThis.fetch = mock(async () => {
      // A running kimi CLI rotated the grant while our refresh was in flight.
      writeFileSync(path, JSON.stringify({ access_token: "theirs", refresh_token: "their-grant" }));
      return jsonResponse(200, { access_token: "ours", refresh_token: "our-grant", expires_in: 900 });
    });

    const result = await refreshKimiToken({ configDir }, "sent-grant");

    expect(result).toMatchObject({ ok: true, accessToken: "ours" });
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.refresh_token).toBe("their-grant");
  });

  test("refreshKimiToken covers http failure, empty token, and network throw", async () => {
    const configDir = tempDir();
    globalThis.fetch = mock(async () => jsonResponse(503, {}));
    await expect(refreshKimiToken({ configDir }, "r")).resolves.toEqual({
      ok: false,
      reauth: false,
      error: "Kimi token refresh returned 503",
    });

    globalThis.fetch = mock(async () => jsonResponse(200, {}));
    await expect(refreshKimiToken({ configDir }, "r")).resolves.toEqual({
      ok: false,
      reauth: false,
      error: "Kimi token refresh returned no access_token",
    });

    globalThis.fetch = mock(async () => {
      throw new Error("down");
    });
    await expect(refreshKimiToken({ configDir }, "r")).resolves.toMatchObject({
      ok: false,
      reauth: false,
      error: "Kimi token refresh failed: down",
    });
  });
});

describe("credential readers", () => {
  test("readClaudeCredentials reads configDir credentials and ignores malformed files", () => {
    const configDir = tempDir();
    writeFileSync(
      join(configDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "claude-token", expiresAt: 456 },
      }),
    );

    expect(readClaudeCredentials({ configDir }, "linux")).toEqual({ accessToken: "claude-token", expiresAt: 456 });

    const badDir = tempDir();
    writeFileSync(join(badDir, ".credentials.json"), "{");
    expect(readClaudeCredentials({ configDir: badDir }, "linux")).toBeNull();
  });

  test("readClaudeCredentials reads the default non-Keychain credential file", () => {
    const homeDir = tempDir();
    mkdirSync(join(homeDir, ".claude"));
    writeFileSync(
      join(homeDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "default-token", subscriptionType: "max" } }),
    );
    expect(readClaudeCredentials({}, "linux", undefined, homeDir)).toEqual({
      accessToken: "default-token",
      expiresAt: undefined,
      subscriptionType: "max",
    });
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
        stdout: Buffer.from(
          JSON.stringify({
            claudeAiOauth: { accessToken: "keychain-token", expiresAt: 789 },
          }),
        ),
      };
    });

    expect(readClaudeCredentials({}, "darwin", spawn)).toEqual({ accessToken: "keychain-token", expiresAt: 789 });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("readClaudeCredentials queries the per-config-dir Keychain item for isolated accounts", () => {
    // Claude Code keys isolated logins as `Claude Code-credentials-<first 8
    // hex of sha256(configDir)>`; the unsuffixed item belongs to ~/.claude and
    // must NOT be consulted for a non-default configDir.
    const configDir = "/Users/williamcory/.smithers/accounts/claude-1";
    const spawn = mock((command, args) => {
      expect(command).toBe("security");
      expect(args).toEqual(["find-generic-password", "-s", "Claude Code-credentials-1f3da633", "-w"]);
      return {
        status: 0,
        stdout: Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: "isolated-token" } })),
      };
    });
    expect(readClaudeCredentials({ configDir }, "darwin", spawn)).toEqual({
      accessToken: "isolated-token",
      expiresAt: undefined,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("readClaudeCredentials does not fall back to the default Keychain item for isolated accounts", () => {
    const spawn = mock(() => ({ status: 44, stdout: Buffer.from("") }));
    expect(readClaudeCredentials({ configDir: "/tmp/isolated-claude" }, "darwin", spawn)).toBeNull();
    // Only the suffixed item is tried; returning ~/.claude's token here would
    // silently attribute another account's usage.
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
    writeFileSync(
      join(noExpiry, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "tok", expiresAt: "later" },
      }),
    );
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
    writeFileSync(
      join(configDir, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "codex-token",
          id_token: jwtWithClaims({
            "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-jwt" },
          }),
        },
      }),
    );

    expect(readCodexCredentials({ configDir })).toEqual({
      accessToken: "codex-token",
      accountId: "acct-from-jwt",
    });
  });

  test("readKimiCredentials reads credentials/kimi-code.json and degrades on bad input", () => {
    expect(readKimiCredentials({})).toBeNull();

    const bad = tempDir();
    mkdirSync(join(bad, "credentials"), { recursive: true });
    writeFileSync(join(bad, "credentials", "kimi-code.json"), "{not json");
    expect(readKimiCredentials({ configDir: bad })).toBeNull();

    const noToken = tempDir();
    mkdirSync(join(noToken, "credentials"), { recursive: true });
    writeFileSync(join(noToken, "credentials", "kimi-code.json"), JSON.stringify({ refresh_token: "r" }));
    expect(readKimiCredentials({ configDir: noToken })).toBeNull();

    const good = tempDir();
    mkdirSync(join(good, "credentials"), { recursive: true });
    writeFileSync(
      join(good, "credentials", "kimi-code.json"),
      JSON.stringify({ access_token: "kimi-token", refresh_token: "kimi-refresh", expires_at: 1784684567.749258 }),
    );
    const creds = readKimiCredentials({ configDir: good });
    expect(creds?.accessToken).toBe("kimi-token");
    expect(creds?.refreshToken).toBe("kimi-refresh");
    expect(creds?.expiresAtMs).toBeCloseTo(1784684567749, -3);
  });
});

describe("parser and formatter branches", () => {
  test("humanizeDurationShort treats non-finite input as now", () => {
    expect(humanizeDurationShort(Number.NaN)).toBe("now");
    expect(humanizeDurationShort(Infinity)).toBe("now");
  });

  test("formatUsageReports renders estimated and count window variants", () => {
    const out = formatUsageReports(
      [
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
      ],
      Date.parse("2026-06-03T00:00:00.000Z"),
    );

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

  test("parseKimiUsage labels windows, derives used from remaining, and tolerates junk", () => {
    expect(parseKimiUsage(null)).toEqual({ windows: [] });

    const { windows, planType } = parseKimiUsage({
      user: { membership: { level: "LEVEL_PRO" } },
      usage: { limit: "100", remaining: "40", resetTime: "not-a-date" },
      limits: [
        { window: { duration: 2, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "50", used: "25" } },
        { window: { duration: 1, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: "0", used: "0" } },
        "junk",
        { detail: { limit: "10", used: "1" } },
      ],
      parallel: { limit: "5" },
    });

    expect(planType).toBe("pro");
    expect(windows.map((w) => [w.id, w.label])).toEqual([
      ["weekly", "weekly"],
      ["5h", "2-hour"],
      ["limit", "limit"],
      ["parallel-sessions", "parallel sessions"],
    ]);
    expect(windows[0]).toMatchObject({ usedPercent: 60, resetsAt: undefined });
    expect(windows[1].usedPercent).toBe(50);
    expect(windows[3]).toMatchObject({ used: 0, remaining: 5 });
  });

  test("rate-limit header parsers handle partial and inverted count windows", () => {
    const fixedNow = Date.parse("2026-06-03T00:00:00.000Z");
    const openai = parseOpenAiRateLimitHeaders(
      (name) =>
        ({
          "x-ratelimit-limit-requests": "10",
          "x-ratelimit-remaining-requests": "15",
          "x-ratelimit-reset-requests": "2m0s",
          "x-ratelimit-remaining-tokens": "42",
          "x-ratelimit-reset-tokens": "bad-duration",
        })[name] ?? null,
      fixedNow,
    );

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

    const anthropic = parseAnthropicRateLimitHeaders(
      (name) =>
        ({
          "anthropic-ratelimit-requests-remaining": "5",
          "anthropic-ratelimit-output-tokens-limit": "100",
          "anthropic-ratelimit-output-tokens-remaining": "90",
          "anthropic-ratelimit-output-tokens-reset": "2026-06-03T00:03:00.000Z",
        })[name] ?? null,
    );

    expect(anthropic.map((window) => window.id)).toEqual(["requests-per-min", "output-tokens-per-min"]);
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
    writeUsageCache(
      {
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
      },
      env,
    );

    const reports = await getUsageForAccounts([{ label: "k", provider: "kimi", configDir: "/x" }], {
      env,
      fresh: true,
      nowMs: Date.parse("2026-06-03T00:00:01.000Z"),
    });

    expect(reports[0].stale).toBe(false);
    expect(reports[0].error).toBe("No Kimi OAuth credentials in configDir/credentials/kimi-code.json");
  });

  test("claude-code respects the hard 180s floor even with --fresh", async () => {
    const env = { SMITHERS_HOME: tempDir() };
    writeUsageCache(
      {
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
      },
      env,
    );

    const reports = await getUsageForAccounts([{ label: "claude", provider: "claude-code", configDir: "/x" }], {
      env,
      fresh: true,
      nowMs: Date.parse("2026-06-03T00:02:59.000Z"),
    });

    expect(reports[0]).toMatchObject({ stale: true, error: "cached-floor" });

    const probed = await getUsageForAccounts([{ label: "claude", provider: "claude-code", configDir: "/x" }], {
      env,
      fresh: true,
      bypassHardFloor: true,
      nowMs: Date.parse("2026-06-03T00:02:59.000Z"),
    });
    expect(probed[0]).toMatchObject({
      stale: false,
      source: "none",
      error: "No Claude OAuth credentials in configDir or Keychain",
    });
  });

  test("--fresh re-probes a claude-code account whose cached report is a failure", async () => {
    const env = { SMITHERS_HOME: tempDir() };
    const claudeConfig = tempDir();
    // the credential the user just refreshed after the cached probe failed
    writeFileSync(
      join(claudeConfig, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "refreshed-token", expiresAt: 99999999999999 },
      }),
    );
    writeUsageCache(
      {
        version: 1,
        entries: {
          claude: {
            identity: { provider: "claude-code", configDir: claudeConfig },
            report: {
              accountLabel: "claude",
              provider: "claude-code",
              authMode: "subscription",
              source: "none",
              stale: false,
              estimate: false,
              fetchedAt: "2026-06-03T00:00:00.000Z",
              windows: [],
              error: "Claude OAuth token expired; run `claude` to refresh",
            },
          },
        },
      },
      env,
    );
    globalThis.fetch = mock(async () =>
      jsonResponse(200, {
        five_hour: { utilization: 10, resets_at: "2026-06-03T05:00:00.000Z" },
      }),
    );

    // age 30s, far inside the 180s floor: the floor may not pin a failure
    const reports = await getUsageForAccounts([{ label: "claude", provider: "claude-code", configDir: claudeConfig }], {
      env,
      fresh: true,
      nowMs: Date.parse("2026-06-03T00:00:30.000Z"),
    });

    expect(reports[0]).toMatchObject({ stale: false, source: "oauth", error: undefined });
    expect(readUsageCache(env).entries.claude.report.source).toBe("oauth");
  });

  test("a cached claude-code failure still serves the soft interval without --fresh", async () => {
    const env = { SMITHERS_HOME: tempDir() };
    writeUsageCache(
      {
        version: 1,
        entries: {
          claude: {
            identity: { provider: "claude-code", configDir: "/x" },
            report: {
              accountLabel: "claude",
              provider: "claude-code",
              authMode: "subscription",
              source: "none",
              stale: false,
              estimate: false,
              fetchedAt: "2026-06-03T00:00:00.000Z",
              windows: [],
              error: "Claude usage endpoint rate limited (429); try again shortly",
            },
          },
        },
      },
      env,
    );
    const fetchMock = mock(async () => jsonResponse(200, {}));
    globalThis.fetch = fetchMock;

    const reports = await getUsageForAccounts([{ label: "claude", provider: "claude-code", configDir: "/x" }], {
      env,
      nowMs: Date.parse("2026-06-03T00:02:59.000Z"),
    });

    expect(reports[0]).toMatchObject({
      stale: true,
      error: "Claude usage endpoint rate limited (429); try again shortly",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("cache write failures do not fail usage collection", async () => {
    const rootFile = join(tempDir(), "not-a-dir");
    writeFileSync(rootFile, "already a file");

    await expect(
      getUsageForAccounts([{ label: "k", provider: "kimi", configDir: "/x" }], {
        env: { SMITHERS_HOME: rootFile },
        nowMs: Date.parse("2026-06-03T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject([{ accountLabel: "k", source: "none" }]);
  });

  test("codex uses the 60s soft interval and claude-code re-probes past its 180s floor", async () => {
    const env = { SMITHERS_HOME: tempDir() };
    const claudeConfig = tempDir();
    writeFileSync(
      join(claudeConfig, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "claude-token", expiresAt: 99999999999999 },
      }),
    );
    writeUsageCache(
      {
        version: 1,
        entries: {
          cx: {
            identity: { provider: "codex", configDir: "/x" },
            report: {
              accountLabel: "cx",
              provider: "codex",
              authMode: "subscription",
              source: "oauth",
              stale: false,
              estimate: false,
              fetchedAt: "2026-06-03T00:03:00.000Z",
              windows: [],
              error: "codex-cached",
            },
          },
          cl: {
            identity: { provider: "claude-code", configDir: claudeConfig },
            report: {
              accountLabel: "cl",
              provider: "claude-code",
              authMode: "subscription",
              source: "oauth",
              stale: false,
              estimate: false,
              fetchedAt: "2026-06-03T00:00:00.000Z",
              windows: [],
              error: "claude-cached",
            },
          },
          km: {
            identity: { provider: "kimi", configDir: "/x" },
            report: {
              accountLabel: "km",
              provider: "kimi",
              authMode: "subscription",
              source: "none",
              stale: false,
              estimate: false,
              fetchedAt: "2026-06-03T00:03:20.000Z",
              windows: [],
              error: "kimi-cached",
            },
          },
        },
      },
      env,
    );
    globalThis.fetch = mock(async () =>
      jsonResponse(200, {
        five_hour: { utilization: 10, resets_at: "2026-06-03T05:00:00.000Z" },
      }),
    );

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

describe("quota-aware account selection", () => {
  test("uses flows model usage to route equal-headroom accounts", () => {
    const env = { SMITHERS_HOME: tempDir() };
    const accounts = [{ label: "busy", provider: "claude-code", configDir: "/busy" }, { label: "idle", provider: "claude-code", configDir: "/idle" }];
    const events = new Map([["busy", [{ type: "usage", inputTokens: 900, outputTokens: 100 }, { type: "settle" }]], ["idle", [{ type: "usage", inputTokens: 90, outputTokens: 10 }, { type: "settle" }]]]);
    expect(orderAccountsByUsage(accounts, { env, modelEventsFor: (account) => events.get(account.label) }).map((account) => account.label)).toEqual(["idle", "busy"]);
  });

  test("prefers model-specific headroom", () => {
    const env = { SMITHERS_HOME: tempDir() };
    const entry = (label, fiveHour, weekly, fable) => ({
      identity: { provider: "claude-code", configDir: `/${label}` },
      report: {
        accountLabel: label,
        provider: "claude-code",
        authMode: "subscription",
        source: "oauth",
        stale: false,
        estimate: false,
        fetchedAt: "2026-08-15T00:00:00Z",
        windows: [
          { id: "5h", label: "5-hour session", unit: "percent", usedPercent: fiveHour },
          { id: "weekly", label: "weekly", unit: "percent", usedPercent: weekly },
          { id: "weekly-fable", label: "weekly (Fable, 50% plan cap)", unit: "percent", usedPercent: fable },
        ],
      },
    });
    const a = entry("a", 10, 20, 90);
    const b = entry("b", 20, 30, 40);
    writeUsageCache({ version: 1, entries: { a, b } }, env);
    const accounts = [
      { label: "a", provider: "claude-code", configDir: "/a" },
      { label: "b", provider: "claude-code", configDir: "/b" },
    ];
    expect(orderAccountsByUsage(accounts, { env, modelFor: () => "claude-fable-5" }).map((row) => row.label)).toEqual([
      "b",
      "a",
    ]);
    expect(accountUsageScore(a.report, "claude-opus-5")).toBe(20);
    expect(
      accountUsageScore(
        { ...a.report, windows: a.report.windows.filter((window) => window.id !== "weekly-fable") },
        "claude-fable-5",
      ),
    ).toBe(40);
  });

  test("persists quota blocks and orders the soonest reset first", () => {
    const env = { SMITHERS_HOME: tempDir() };
    const nowMs = Date.parse("2026-08-15T00:00:00Z");
    recordAccountQuotaLimit("a", { env, nowMs, untilMs: nowMs + 20_000 });
    recordAccountQuotaLimit("b", { env, nowMs, untilMs: nowMs + 10_000 });
    const accounts = [
      { label: "a", provider: "claude-code", configDir: "/a" },
      { label: "b", provider: "claude-code", configDir: "/b" },
      { label: "c", provider: "claude-code", configDir: "/c" },
    ];
    expect(orderAccountsByUsage(accounts, { env, nowMs }).map((row) => row.label)).toEqual(["c", "b", "a"]);
    expect(readAccountQuotaState(env, nowMs).entries.b.untilMs).toBe(nowMs + 10_000);
    recordAccountQuotaLimit("b", { env, nowMs, untilMs: nowMs + 5_000 });
    expect(readAccountQuotaState(env, nowMs).entries.b.untilMs).toBe(nowMs + 10_000);
    expect(clearAccountQuotaLimit("b", env)).toBe(true);
  });

  test("keeps model quota blocks separate from shared account blocks", () => {
    const env = { SMITHERS_HOME: tempDir() };
    const nowMs = Date.parse("2026-08-15T00:00:00Z");
    recordAccountQuotaLimit("a", {
      env,
      nowMs,
      untilMs: nowMs + 10_000,
      model: "claude-fable-5",
      scope: "model",
    });
    const entries = readAccountQuotaState(env, nowMs).entries;
    expect(accountQuotaBlock(entries, "a", "claude-fable-5")?.untilMs).toBe(nowMs + 10_000);
    expect(accountQuotaBlock(entries, "a", "claude-opus-5")).toBeUndefined();
    recordAccountQuotaLimit("a", { env, nowMs, untilMs: nowMs + 20_000 });
    expect(accountQuotaBlock(readAccountQuotaState(env, nowMs).entries, "a", "claude-opus-5")?.untilMs).toBe(
      nowMs + 20_000,
    );
    expect(clearAccountQuotaLimit("a", env)).toBe(true);
    expect(Object.keys(readAccountQuotaState(env, 0).entries)).toEqual([]);
  });

  test("treats exhausted cached model usage as blocked until its reset", () => {
    const nowMs = Date.parse("2026-08-15T00:00:00Z");
    const resetAt = "2026-08-15T01:00:00Z";
    const report = {
      accountLabel: "a",
      provider: "claude-code",
      authMode: "subscription",
      source: "oauth",
      stale: false,
      estimate: false,
      fetchedAt: "2026-08-14T23:59:00Z",
      windows: [
        { id: "weekly", label: "weekly", unit: "percent", usedPercent: 30, resetsAt: resetAt },
        { id: "weekly-fable", label: "weekly Fable", unit: "percent", usedPercent: 100, resetsAt: resetAt },
      ],
    };
    expect(accountQuotaBlock({}, "a", "claude-fable-5", report, nowMs)).toMatchObject({
      untilMs: Date.parse(resetAt),
      model: "claude-fable-5",
    });
    expect(accountQuotaBlock({}, "a", "claude-opus-5", report, nowMs)).toBeUndefined();
    expect(accountQuotaBlock({}, "a", "claude-fable-5", report, Date.parse(resetAt) + 1)).toBeUndefined();
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

    globalThis.fetch = mock(async () =>
      jsonResponse(
        200,
        {},
        {
          "anthropic-ratelimit-requests-limit": "100",
          "anthropic-ratelimit-requests-remaining": "40",
          "anthropic-ratelimit-requests-reset": "2026-06-03T00:01:00.000Z",
        },
      ),
    );
    const ok = await anthropicHeaderUsage({ apiKey: "good" });
    expect(ok).toMatchObject({ source: "headers" });
    expect(ok.error).toBeUndefined();
    expect(ok.windows[0]).toMatchObject({ id: "requests-per-min", remaining: 40 });

    globalThis.fetch = mock(async () => jsonResponse(400, {}));
    await expect(anthropicHeaderUsage({ apiKey: "bad-model" })).resolves.toEqual({
      source: "none",
      error: "Anthropic returned 400 with no rate-limit headers",
    });

    globalThis.fetch = mock(async () => {
      throw new Error("boom");
    });
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

    globalThis.fetch = mock(async () =>
      jsonResponse(
        429,
        {},
        {
          "x-ratelimit-limit-requests": "50",
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-reset-requests": "30s",
          "retry-after": "9",
        },
      ),
    );
    const limited = await openaiHeaderUsage({ apiKey: "k" });
    expect(limited).toMatchObject({ source: "headers" });
    expect(limited.error).toContain("retry after 9s");

    globalThis.fetch = mock(async () => jsonResponse(500, {}));
    await expect(openaiHeaderUsage({ apiKey: "k" })).resolves.toEqual({
      source: "none",
      error: "OpenAI returned 500 with no rate-limit headers",
    });

    globalThis.fetch = mock(async () => {
      throw new Error("neterr");
    });
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
    writeFileSync(
      join(configDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "claude-token", expiresAt: 99999999999999 },
      }),
    );

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

    globalThis.fetch = mock(async () => {
      throw new Error("down");
    });
    await expect(claudeOauthUsage({ configDir })).resolves.toMatchObject({
      source: "none",
      error: expect.stringContaining("Claude usage probe failed: down"),
    });
  });

  test("claudeOauthUsage reports an expired token", () => {
    const configDir = tempDir();
    writeFileSync(
      join(configDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "claude-token", expiresAt: 1 },
      }),
    );
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
    writeFileSync(
      join(configDir, "auth.json"),
      JSON.stringify({
        tokens: { access_token: "codex-token", account_id: "acct" },
      }),
    );

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

    globalThis.fetch = mock(async () => {
      throw new Error("kaput");
    });
    await expect(codexWhamUsage({ configDir })).resolves.toMatchObject({
      source: "none",
      error: expect.stringContaining("Codex usage probe failed: kaput"),
    });
  });
});

describe("getAccountUsage provider routing", () => {
  test("routes every supported provider through its adapter", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse(
        200,
        {},
        {
          "anthropic-ratelimit-requests-limit": "100",
          "anthropic-ratelimit-requests-remaining": "99",
          "x-ratelimit-limit-requests": "50",
          "x-ratelimit-remaining-requests": "49",
        },
      ),
    );

    const claudeDir = tempDir();
    writeFileSync(
      join(claudeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "claude-token", expiresAt: 99999999999999 },
      }),
    );
    const codexDir = tempDir();
    writeFileSync(
      join(codexDir, "auth.json"),
      JSON.stringify({
        tokens: { access_token: "codex-token", account_id: "acct" },
      }),
    );

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
    const out = formatUsageReports(
      [
        {
          accountLabel: "erred",
          provider: "openai-api",
          authMode: "api-key",
          source: "none",
          stale: false,
          estimate: false,
          fetchedAt: "2026-06-03T00:00:00.000Z",
          windows: [],
          error: "boom happened",
        },
        {
          accountLabel: "silent",
          provider: "kimi",
          authMode: "subscription",
          source: "none",
          stale: false,
          estimate: false,
          fetchedAt: "2026-06-03T00:00:00.000Z",
          windows: [],
        },
      ],
      Date.parse("2026-06-03T00:00:00.000Z"),
    );

    expect(out).toContain("boom happened");
    expect(out).toContain("not supported");
  });

  test("formatUsageReports surfaces the error even when the report also has windows", () => {
    const out = formatUsageReports(
      [
        {
          accountLabel: "throttled",
          provider: "anthropic-api",
          authMode: "api-key",
          source: "headers",
          stale: false,
          estimate: false,
          fetchedAt: "2026-06-03T00:00:00.000Z",
          windows: [
            { id: "requests-per-min", label: "requests/min", unit: "count", used: 100, remaining: 0, limit: 100 },
          ],
          error: "Rate limited (429) — retry after 12s",
        },
      ],
      Date.parse("2026-06-03T00:00:00.000Z"),
    );

    expect(out).toContain("0/100 left");
    expect(out).toContain("Rate limited (429) — retry after 12s");
  });
});
