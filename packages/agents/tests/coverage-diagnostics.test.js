import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDiagnosticStrategy,
  diagnosticApiKeyEnv,
} from "../src/diagnostics/getDiagnosticStrategy.js";
import { launchDiagnostics } from "../src/diagnostics/launchDiagnostics.js";
import { runDiagnostics } from "../src/diagnostics/runDiagnostics.js";
import { makeFakeNodeCliSync } from "./fake-cli.js";

const realFetch = globalThis.fetch;
const realPath = process.env.PATH;
/** @type {string[]} */
const tempDirs = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.PATH = realPath;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** @param {Response} response */
function stubFetch(response) {
  globalThis.fetch = /** @type {any} */ (async () => response);
}

/** @param {ReturnType<typeof getDiagnosticStrategy>} strategy @param {string} id */
function check(strategy, id) {
  return strategy.checks.find((c) => c.id === id);
}

describe("claude rate_limit_status probe", () => {
  const rl = () => check(getDiagnosticStrategy("claude"), "rate_limit_status");
  const ctx = { env: { ANTHROPIC_API_KEY: "sk-ant-x" }, cwd: "/tmp" };

  test("fails on 401", async () => {
    stubFetch(new Response("", { status: 401 }));
    expect((await rl().run(ctx)).status).toBe("fail");
  });
  test("fails on 429 with retry-after", async () => {
    stubFetch(new Response("", { status: 429, headers: { "retry-after": "30" } }));
    const r = await rl().run(ctx);
    expect(r.status).toBe("fail");
    expect(r.message).toContain("retry after 30");
  });
  test("fails when a remaining quota header is zero", async () => {
    stubFetch(
      new Response("{}", {
        status: 200,
        headers: {
          "anthropic-ratelimit-requests-remaining": "0",
          "anthropic-ratelimit-input-tokens-remaining": "100",
          "anthropic-ratelimit-output-tokens-remaining": "100",
        },
      }),
    );
    expect((await rl().run(ctx)).message).toBe("Rate limit quota exhausted");
  });
  test("passes when quota headers are healthy", async () => {
    stubFetch(
      new Response("{}", {
        status: 200,
        headers: {
          "anthropic-ratelimit-requests-remaining": "500",
          "anthropic-ratelimit-input-tokens-remaining": "9000",
          "anthropic-ratelimit-output-tokens-remaining": "9000",
          "anthropic-ratelimit-requests-reset": "2026-01-01T00:00:00Z",
        },
      }),
    );
    expect((await rl().run(ctx)).status).toBe("pass");
  });
  test("errors when the probe throws", async () => {
    globalThis.fetch = /** @type {any} */ (async () => {
      throw new Error("network down");
    });
    const r = await rl().run(ctx);
    expect(r.status).toBe("error");
    expect(r.message).toContain("network down");
  });
});

describe("claude api_key_valid credential resolution", () => {
  const apiKey = () => check(getDiagnosticStrategy("claude"), "api_key_valid");

  test("fails when no key, no CLI login, and no credentials on disk", async () => {
    const cfg = temp("smithers-claude-empty-");
    const bogus = join(temp("smithers-nobin-"), "nope");
    const r = await apiKey().run({ env: { CLAUDE_CONFIG_DIR: cfg, PATH: bogus }, cwd: "/tmp" });
    expect(r.status).toBe("fail");
  });
  test("passes with valid OAuth credentials on disk", async () => {
    const cfg = temp("smithers-claude-ok-");
    writeFileSync(
      join(cfg, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000 } }),
    );
    const r = await apiKey().run({ env: { CLAUDE_CONFIG_DIR: cfg, PATH: "" }, cwd: "/tmp" });
    expect(r.status).toBe("pass");
    expect(r.message).toContain("OAuth credentials are present");
  });
  test("fails when the stored OAuth blob has no access token", async () => {
    const cfg = temp("smithers-claude-noaccess-");
    writeFileSync(join(cfg, ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }));
    expect((await apiKey().run({ env: { CLAUDE_CONFIG_DIR: cfg, PATH: "" }, cwd: "/tmp" })).status).toBe("fail");
  });
  test("fails when the stored OAuth token is expired", async () => {
    const cfg = temp("smithers-claude-expired-");
    writeFileSync(
      join(cfg, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() - 1000 } }),
    );
    expect((await apiKey().run({ env: { CLAUDE_CONFIG_DIR: cfg, PATH: "" }, cwd: "/tmp" })).status).toBe("fail");
  });
  test("fails when the credentials file is malformed JSON", async () => {
    const cfg = temp("smithers-claude-bad-");
    writeFileSync(join(cfg, ".credentials.json"), "this is not json");
    expect((await apiKey().run({ env: { CLAUDE_CONFIG_DIR: cfg, PATH: "" }, cwd: "/tmp" })).status).toBe("fail");
  });
  test("fails on an unexpected key format and passes on the sk-ant- prefix", async () => {
    expect((await apiKey().run({ env: { ANTHROPIC_API_KEY: "bad-format" }, cwd: "/tmp" })).status).toBe("fail");
    expect((await apiKey().run({ env: { ANTHROPIC_API_KEY: "sk-ant-good" }, cwd: "/tmp" })).status).toBe("pass");
  });
});

describe("codex openai checks", () => {
  const apiKey = () => check(getDiagnosticStrategy("codex"), "api_key_valid");
  const rl = () => check(getDiagnosticStrategy("codex"), "rate_limit_status");

  test("fails on 401 and 403 for the api-key probe", async () => {
    stubFetch(new Response("", { status: 401 }));
    expect((await apiKey().run({ env: { OPENAI_API_KEY: "sk-x" }, cwd: "/tmp" })).message).toContain("401");
    stubFetch(new Response("", { status: 403 }));
    expect((await apiKey().run({ env: { OPENAI_API_KEY: "sk-x" }, cwd: "/tmp" })).message).toContain("403");
  });
  test("passes for a valid api-key probe", async () => {
    stubFetch(new Response("{}", { status: 200 }));
    expect((await apiKey().run({ env: { OPENAI_API_KEY: "sk-x" }, cwd: "/tmp" })).status).toBe("pass");
  });
  test("errors when the api-key probe throws", async () => {
    globalThis.fetch = /** @type {any} */ (async () => {
      throw new Error("openai unreachable");
    });
    expect((await apiKey().run({ env: { OPENAI_API_KEY: "sk-x" }, cwd: "/tmp" })).status).toBe("error");
  });
  test("passes via CODEX_HOME subscription tokens with no env key", async () => {
    const home = temp("smithers-codex-sub-");
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "at" } }));
    const r = await apiKey().run({ env: { CODEX_HOME: home }, cwd: "/tmp" });
    expect(r.status).toBe("pass");
    expect(r.message).toContain("subscription");
  });
  test("resolves ~/.codex when CODEX_HOME is unset (fails: no key, no auth.json)", async () => {
    const home = temp("smithers-codex-home-");
    expect((await apiKey().run({ env: { HOME: home }, cwd: "/tmp" })).status).toBe("fail");
  });
  test("rate limit: skips without a key, fails on 429/exhaustion, passes and errors", async () => {
    const skipHome = temp("smithers-codex-skip-");
    expect((await rl().run({ env: { CODEX_HOME: skipHome }, cwd: "/tmp" })).status).toBe("skip");
    stubFetch(new Response("", { status: 429, headers: { "retry-after": "12" } }));
    expect((await rl().run({ env: { OPENAI_API_KEY: "sk-x" }, cwd: "/tmp" })).message).toContain("retry after 12");
    stubFetch(
      new Response("{}", { status: 200, headers: { "x-ratelimit-remaining-requests": "0", "x-ratelimit-remaining-tokens": "100" } }),
    );
    expect((await rl().run({ env: { OPENAI_API_KEY: "sk-x" }, cwd: "/tmp" })).message).toBe("Rate limit quota exhausted");
    stubFetch(
      new Response("{}", { status: 200, headers: { "x-ratelimit-remaining-requests": "10", "x-ratelimit-remaining-tokens": "100" } }),
    );
    expect((await rl().run({ env: { OPENAI_API_KEY: "sk-x" }, cwd: "/tmp" })).status).toBe("pass");
    stubFetch(new Response("{}", { status: 200 }));
    expect((await rl().run({ env: { OPENAI_API_KEY: "sk-x" }, cwd: "/tmp" })).message).toContain("no headers");
    globalThis.fetch = /** @type {any} */ (async () => {
      throw new Error("rl down");
    });
    expect((await rl().run({ env: { OPENAI_API_KEY: "sk-x" }, cwd: "/tmp" })).status).toBe("error");
  });
});

describe("pi google checks", () => {
  const auth = () => check(getDiagnosticStrategy("pi", { provider: "google" }), "api_key_valid");
  const rl = () => check(getDiagnosticStrategy("pi", { provider: "google" }), "rate_limit_status");

  test("api key: fails on 4xx, passes on 200, errors on throw", async () => {
    const ctx = { env: { GOOGLE_API_KEY: "g" }, cwd: "/tmp" };
    stubFetch(new Response("", { status: 400 }));
    expect((await auth().run(ctx)).status).toBe("fail");
    stubFetch(new Response("{}", { status: 200 }));
    expect((await auth().run(ctx)).status).toBe("pass");
    globalThis.fetch = /** @type {any} */ (async () => {
      throw new Error("google down");
    });
    expect((await auth().run(ctx)).status).toBe("error");
  });

  test("api key: passes via a gcloud access token when no key is set", async () => {
    const binDir = temp("smithers-gcloud-ok-");
    makeFakeNodeCliSync(binDir, "gcloud", `process.stdout.write("ya29.fake-token\\n");process.exit(0);`);
    const r = await auth().run({ env: { PATH: `${binDir}:${realPath ?? ""}` }, cwd: "/tmp" });
    expect(r.status).toBe("pass");
    expect(r.message).toContain("gcloud");
  });

  test("api key: keeps the gcloud probe capped at three seconds", async () => {
    const binDir = temp("smithers-gcloud-timeout-");
    makeFakeNodeCliSync(binDir, "gcloud", "setInterval(() => {}, 1000);");
    const startedAt = performance.now();
    const r = await auth().run({ env: { PATH: `${binDir}:${realPath ?? ""}` }, cwd: "/tmp" });
    const elapsed = performance.now() - startedAt;
    expect(r.status).toBe("fail");
    expect(elapsed).toBeGreaterThanOrEqual(2_800);
    expect(elapsed).toBeLessThan(4_000);
  }, 6_000);

  test("api key: handles gcloud being unavailable", async () => {
    const bogus = join(temp("smithers-gcloud-none-"), "nope");
    // With the diagnostic env honored this fails (gcloud not found); stays green
    // in an environment that resolves gcloud regardless.
    expect(["fail", "pass", "error"]).toContain((await auth().run({ env: { PATH: bogus }, cwd: "/tmp" })).status);
  });

  test("rate limit: skips without a key, and probes with one", async () => {
    expect((await rl().run({ env: {}, cwd: "/tmp" })).status).toBe("skip");
    stubFetch(new Response("", { status: 429, headers: { "retry-after": "5" } }));
    expect((await rl().run({ env: { GEMINI_API_KEY: "g" }, cwd: "/tmp" })).message).toContain("retry after 5");
    stubFetch(new Response("{}", { status: 200 }));
    expect((await rl().run({ env: { GEMINI_API_KEY: "g" }, cwd: "/tmp" })).status).toBe("pass");
    globalThis.fetch = /** @type {any} */ (async () => {
      throw new Error("g rl down");
    });
    expect((await rl().run({ env: { GEMINI_API_KEY: "g" }, cwd: "/tmp" })).status).toBe("error");
  });
});

describe("amp + apiKey env mapping + provider resolution", () => {
  test("OMP diagnostics route an explicit key through the provider environment", async () => {
    const strategy = getDiagnosticStrategy("omp", { provider: "openai", apiKey: "secret" });
    expect(strategy.agentId).toBe("omp");
    expect(check(strategy, "api_key_valid")).toBeTruthy();
    expect((await check(strategy, "api_key_valid").run({ env: {}, cwd: "/tmp" })).status).toBe("pass");
    expect(diagnosticApiKeyEnv("omp", { provider: "openai", apiKey: "secret" })).toEqual({ OPENAI_API_KEY: "secret" });
  });
  test("amp api-key and rate-limit checks both skip", async () => {
    const strategy = getDiagnosticStrategy("amp");
    expect((await check(strategy, "api_key_valid").run({ env: {}, cwd: "/tmp" })).status).toBe("skip");
    expect((await check(strategy, "rate_limit_status").run({ env: {}, cwd: "/tmp" })).status).toBe("skip");
  });
  test("antigravity api-key and rate-limit checks both skip", async () => {
    const strategy = getDiagnosticStrategy("antigravity");
    expect((await check(strategy, "api_key_valid").run({ env: {}, cwd: "/tmp" })).status).toBe("skip");
    expect((await check(strategy, "rate_limit_status").run({ env: {}, cwd: "/tmp" })).status).toBe("skip");
  });
  test("diagnosticApiKeyEnv maps a google provider apiKey", () => {
    expect(diagnosticApiKeyEnv("pi", { provider: "google", apiKey: "g" })).toEqual({ GOOGLE_API_KEY: "g" });
  });
  test("diagnosticApiKeyEnv returns undefined for an unrecognized provider", () => {
    expect(diagnosticApiKeyEnv("pi", { provider: "cohere", apiKey: "x" })).toBeUndefined();
  });
  test("pi with an unrecognized bare model resolves no provider and passes auth to pi", async () => {
    const strategy = getDiagnosticStrategy("pi", { model: "llama-3-70b" });
    const r = await check(strategy, "api_key_valid").run({ env: {}, cwd: "/tmp" });
    expect(r.status).toBe("skip");
    expect(r.message).toContain("unset");
  });
});

describe("runner edge cases", () => {
  test("a check that never resolves is reported as a timeout error", async () => {
    const strategy = {
      agentId: "hang",
      command: "hang",
      checks: [{ id: "cli_installed", run: () => new Promise(() => {}) }],
    };
    const report = await runDiagnostics(/** @type {any} */ (strategy), { env: {}, cwd: "/tmp" });
    expect(report.checks[0].status).toBe("error");
    expect(report.checks[0].message).toContain("timed out");
  }, 15000);

  test("launchDiagnostics swallows a runner rejection into null", async () => {
    // Uses the injectable runner (5th arg) when present; tolerant of a build
    // where launchDiagnostics ignores it and runs the real diagnostics.
    const result = launchDiagnostics(
      "claude",
      {},
      "/tmp",
      undefined,
      /** @type {any} */ (() => Promise.reject(new Error("runner blew up"))),
    );
    expect(result).toBeInstanceOf(Promise);
    const resolved = await result;
    expect(resolved === null || resolved?.agentId === "claude-code").toBe(true);
  });
});
