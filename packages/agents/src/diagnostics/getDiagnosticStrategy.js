import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/** @typedef {import("./DiagnosticCheck.ts").DiagnosticCheck} DiagnosticCheck */
/** @typedef {import("./DiagnosticCheckId.ts").DiagnosticCheckId} DiagnosticCheckId */
/** @typedef {import("./DiagnosticContext.ts").DiagnosticContext} DiagnosticContext */

/**
 * @typedef {{ agentId: string; command: string; checks: DiagnosticCheckDef[]; }} AgentDiagnosticStrategy
 */
/**
 * @typedef {{ id: DiagnosticCheckId; run: (ctx: DiagnosticContext) => Promise<DiagnosticCheck>; }} DiagnosticCheckDef
 */
/**
 * @typedef {{ provider?: string; model?: string; apiKey?: string }} DiagnosticHints
 */

// ---------------------------------------------------------------------------
// Shared check helpers
// ---------------------------------------------------------------------------
/**
 * @param {string} command
 * @param {string} agentId
 * @returns {DiagnosticCheckDef}
 */
function checkCliInstalled(command, agentId) {
    return {
        id: "cli_installed",
        run: async () => {
            const start = performance.now();
            const result = spawnSync("which", [command], {
                stdio: ["pipe", "pipe", "pipe"],
            });
            const elapsed = performance.now() - start;
            const binaryPath = result.stdout?.toString("utf8").trim();
            if (result.status === 0 && binaryPath) {
                return {
                    id: "cli_installed",
                    status: "pass",
                    message: `${agentId} found at ${binaryPath}`,
                    detail: { binaryPath },
                    durationMs: elapsed,
                };
            }
            return {
                id: "cli_installed",
                status: "fail",
                message: `${command} not found on PATH`,
                durationMs: elapsed,
            };
        },
    };
}
/**
 * @param {string | null} value
 * @returns {number | undefined}
 */
function parseHeaderInt(value) {
    if (value == null)
        return undefined;
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? undefined : n;
}
// ---------------------------------------------------------------------------
// Claude strategy
// ---------------------------------------------------------------------------
const claudeApiKeyCheck = {
    id: "api_key_valid",
    run: async (ctx) => {
        const start = performance.now();
        const apiKey = ctx.env.ANTHROPIC_API_KEY;
        // No API key means subscription mode — valid for Claude Code CLI
        if (!apiKey) {
            return {
                id: "api_key_valid",
                status: "pass",
                message: "No ANTHROPIC_API_KEY set — using subscription mode",
                durationMs: performance.now() - start,
            };
        }
        // Validate key format
        if (!apiKey.startsWith("sk-ant-")) {
            return {
                id: "api_key_valid",
                status: "fail",
                message: "ANTHROPIC_API_KEY has unexpected format (expected sk-ant-* prefix)",
                detail: { prefix: apiKey.slice(0, 7) },
                durationMs: performance.now() - start,
            };
        }
        return {
            id: "api_key_valid",
            status: "pass",
            message: "ANTHROPIC_API_KEY format valid",
            durationMs: performance.now() - start,
        };
    },
};
const claudeRateLimitCheck = {
    id: "rate_limit_status",
    run: async (ctx) => {
        const start = performance.now();
        const apiKey = ctx.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            return {
                id: "rate_limit_status",
                status: "skip",
                message: "Subscription mode — cannot probe rate limits via API",
                durationMs: performance.now() - start,
            };
        }
        try {
            const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
                method: "POST",
                headers: {
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: "claude-fable-5",
                    messages: [{ role: "user", content: "hi" }],
                }),
                signal: AbortSignal.timeout(4_000),
            });
            const elapsed = performance.now() - start;
            if (res.status === 401) {
                return {
                    id: "rate_limit_status",
                    status: "fail",
                    message: "API key is invalid (401 Unauthorized)",
                    durationMs: elapsed,
                };
            }
            if (res.status === 429) {
                const retryAfter = res.headers.get("retry-after");
                return {
                    id: "rate_limit_status",
                    status: "fail",
                    message: `Currently rate limited (429)${retryAfter ? ` — retry after ${retryAfter}s` : ""}`,
                    detail: { retryAfter },
                    durationMs: elapsed,
                };
            }
            // Parse rate limit headers
            const remaining = {
                requests: parseHeaderInt(res.headers.get("anthropic-ratelimit-requests-remaining")),
                inputTokens: parseHeaderInt(res.headers.get("anthropic-ratelimit-input-tokens-remaining")),
                outputTokens: parseHeaderInt(res.headers.get("anthropic-ratelimit-output-tokens-remaining")),
            };
            const resets = {
                requests: res.headers.get("anthropic-ratelimit-requests-reset"),
                inputTokens: res.headers.get("anthropic-ratelimit-input-tokens-reset"),
                outputTokens: res.headers.get("anthropic-ratelimit-output-tokens-reset"),
            };
            if (remaining.requests === 0 || remaining.inputTokens === 0 || remaining.outputTokens === 0) {
                return {
                    id: "rate_limit_status",
                    status: "fail",
                    message: "Rate limit quota exhausted",
                    detail: { remaining, resets },
                    durationMs: elapsed,
                };
            }
            return {
                id: "rate_limit_status",
                status: "pass",
                message: "Rate limit OK",
                detail: { remaining, resets },
                durationMs: elapsed,
            };
        }
        catch (err) {
            return {
                id: "rate_limit_status",
                status: "error",
                message: `Rate limit probe failed: ${err instanceof Error ? err.message : String(err)}`,
                durationMs: performance.now() - start,
            };
        }
    },
};
const claudeStrategy = {
    agentId: "claude-code",
    command: "claude",
    checks: [
        checkCliInstalled("claude", "Claude Code"),
        claudeApiKeyCheck,
        claudeRateLimitCheck,
    ],
};
// ---------------------------------------------------------------------------
// Codex strategy
// ---------------------------------------------------------------------------
/**
 * Resolve the OpenAI models endpoint, honoring OPENAI_BASE_URL (Azure, proxies,
 * OpenAI-compatible gateways, and hermetic test fixtures) the same way the
 * OpenAI SDK and codex do. Defaults to the public API, so existing behavior is
 * unchanged when the variable is unset.
 * @param {Record<string, string | undefined>} env
 */
function openaiModelsUrl(env) {
    const base = (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    return `${base}/models`;
}
/**
 * Resolve the Codex CLI config directory the same way the `codex` binary does:
 * an explicit `CODEX_HOME` wins, otherwise `~/.codex` (honoring `$HOME`).
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function resolveCodexHome(env) {
    const explicit = env.CODEX_HOME?.trim();
    if (explicit) {
        return explicit;
    }
    return join(env.HOME?.trim() || homedir(), ".codex");
}
/**
 * @typedef {{ apiKey: string; keySource: string } | { subscription: true } | { missing: true }} OpenAiCredentials
 */
/**
 * Read OpenAI credentials from `<CODEX_HOME>/auth.json`, the file `codex login`
 * writes. Mirrors the codex binary's own auth resolution: a stored API key, or
 * ChatGPT subscription tokens. Returns null when no usable credentials are
 * present (file missing, unreadable, malformed, or empty).
 * @param {Record<string, string | undefined>} env
 * @returns {{ kind: "apiKey"; apiKey: string } | { kind: "subscription" } | null}
 */
function readCodexCliAuth(env) {
    try {
        const raw = readFileSync(join(resolveCodexHome(env), "auth.json"), "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed?.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim()) {
            return { kind: "apiKey", apiKey: parsed.OPENAI_API_KEY.trim() };
        }
        if (typeof parsed?.tokens?.access_token === "string" && parsed.tokens.access_token.trim()) {
            return { kind: "subscription" };
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Resolve the OpenAI credentials a codex/pi invocation will actually use. An env
 * `OPENAI_API_KEY` always wins. When it is absent and `codexCliAuth` is set, fall
 * back to `<CODEX_HOME>/auth.json` (subscription tokens or a stored API key) the
 * same way the codex binary does (#448). pi leaves `codexCliAuth` off — it reads
 * the env var (or `--api-key`), not codex's auth.json.
 * @param {Record<string, string | undefined>} env
 * @param {boolean} codexCliAuth
 * @returns {OpenAiCredentials}
 */
function resolveOpenAiCredentials(env, codexCliAuth) {
    const envKey = env.OPENAI_API_KEY;
    if (envKey) {
        return { apiKey: envKey, keySource: "OPENAI_API_KEY" };
    }
    if (codexCliAuth) {
        const auth = readCodexCliAuth(env);
        if (auth?.kind === "apiKey") {
            return { apiKey: auth.apiKey, keySource: "Codex CLI auth.json API key" };
        }
        if (auth?.kind === "subscription") {
            return { subscription: true };
        }
    }
    return { missing: true };
}
/**
 * OpenAI API-key validity check via GET /v1/models (free, no tokens).
 *
 * Validates whatever concrete key the invocation will use — env `OPENAI_API_KEY`
 * or, when `codexCliAuth` is set, a key stored in `<CODEX_HOME>/auth.json`. A
 * stored key can be invalid/exhausted just like an env key, so it is probed, not
 * trusted on presence. ChatGPT subscription tokens can't be probed cheaply, so
 * (like the Claude subscription check) their presence passes (#448).
 * @param {{ codexCliAuth: boolean }} options
 * @returns {DiagnosticCheckDef}
 */
function openaiApiKeyCheck({ codexCliAuth }) {
    return {
        id: "api_key_valid",
        run: async (ctx) => {
            const start = performance.now();
            const creds = resolveOpenAiCredentials(ctx.env, codexCliAuth);
            if ("subscription" in creds) {
                return {
                    id: "api_key_valid",
                    status: "pass",
                    message: "No OPENAI_API_KEY set — using Codex CLI subscription auth (CODEX_HOME/auth.json)",
                    durationMs: performance.now() - start,
                };
            }
            if ("missing" in creds) {
                return {
                    id: "api_key_valid",
                    status: "fail",
                    message: codexCliAuth
                        ? "OPENAI_API_KEY not set and no Codex CLI auth found — run `codex login` or set OPENAI_API_KEY"
                        : "OPENAI_API_KEY not set",
                    durationMs: performance.now() - start,
                };
            }
            try {
                const res = await fetch(openaiModelsUrl(ctx.env), {
                    headers: { Authorization: `Bearer ${creds.apiKey}` },
                    signal: AbortSignal.timeout(4_000),
                });
                const elapsed = performance.now() - start;
                if (res.status === 401) {
                    return {
                        id: "api_key_valid",
                        status: "fail",
                        message: `${creds.keySource} is invalid (401 Unauthorized)`,
                        durationMs: elapsed,
                    };
                }
                if (res.status === 403) {
                    return {
                        id: "api_key_valid",
                        status: "fail",
                        message: `${creds.keySource} lacks permission (403 Forbidden)`,
                        durationMs: elapsed,
                    };
                }
                return {
                    id: "api_key_valid",
                    status: "pass",
                    message: `${creds.keySource} is valid`,
                    durationMs: elapsed,
                };
            }
            catch (err) {
                return {
                    id: "api_key_valid",
                    status: "error",
                    message: `OpenAI probe failed: ${err instanceof Error ? err.message : String(err)}`,
                    durationMs: performance.now() - start,
                };
            }
        },
    };
}
/**
 * Rate-limit probe via GET /v1/models (free, no tokens). Probes the same key the
 * api-key check resolves (env or Codex CLI auth.json), so a stored key's quota is
 * checked too; subscription/no-key resolve to a non-blocking skip.
 * @param {{ codexCliAuth: boolean }} options
 * @returns {DiagnosticCheckDef}
 */
function openaiRateLimitCheck({ codexCliAuth }) {
    return {
        id: "rate_limit_status",
        run: async (ctx) => {
            const start = performance.now();
            const creds = resolveOpenAiCredentials(ctx.env, codexCliAuth);
            if (!("apiKey" in creds)) {
                return {
                    id: "rate_limit_status",
                    status: "skip",
                    message: "subscription" in creds
                        ? "Subscription mode — cannot probe rate limits via API"
                        : "No API key — cannot check rate limits",
                    durationMs: 0,
                };
            }
            try {
                const res = await fetch(openaiModelsUrl(ctx.env), {
                    headers: { Authorization: `Bearer ${creds.apiKey}` },
                    signal: AbortSignal.timeout(4_000),
                });
                const elapsed = performance.now() - start;
                if (res.status === 429) {
                    const retryAfter = res.headers.get("retry-after");
                    return {
                        id: "rate_limit_status",
                        status: "fail",
                        message: `Currently rate limited (429)${retryAfter ? ` — retry after ${retryAfter}s` : ""}`,
                        detail: { retryAfter },
                        durationMs: elapsed,
                    };
                }
                // Parse OpenAI rate limit headers if present
                const remaining = {
                    requests: parseHeaderInt(res.headers.get("x-ratelimit-remaining-requests")),
                    tokens: parseHeaderInt(res.headers.get("x-ratelimit-remaining-tokens")),
                };
                const resets = {
                    requests: res.headers.get("x-ratelimit-reset-requests"),
                    tokens: res.headers.get("x-ratelimit-reset-tokens"),
                };
                const limits = {
                    requests: parseHeaderInt(res.headers.get("x-ratelimit-limit-requests")),
                    tokens: parseHeaderInt(res.headers.get("x-ratelimit-limit-tokens")),
                };
                const hasHeaders = remaining.requests !== undefined || remaining.tokens !== undefined;
                if (hasHeaders && (remaining.requests === 0 || remaining.tokens === 0)) {
                    return {
                        id: "rate_limit_status",
                        status: "fail",
                        message: "Rate limit quota exhausted",
                        detail: { remaining, resets, limits },
                        durationMs: elapsed,
                    };
                }
                return {
                    id: "rate_limit_status",
                    status: "pass",
                    message: hasHeaders ? "Rate limit OK" : "Rate limit OK (no headers returned)",
                    detail: hasHeaders ? { remaining, resets, limits } : undefined,
                    durationMs: elapsed,
                };
            }
            catch (err) {
                return {
                    id: "rate_limit_status",
                    status: "error",
                    message: `Rate limit probe failed: ${err instanceof Error ? err.message : String(err)}`,
                    durationMs: performance.now() - start,
                };
            }
        },
    };
}
// Codex resolves auth from `<CODEX_HOME>/auth.json` (subscription tokens or a
// stored API key) when OPENAI_API_KEY is absent, so its checks honor that.
const codexApiKeyAndRateLimitCheck = [
    openaiApiKeyCheck({ codexCliAuth: true }),
    openaiRateLimitCheck({ codexCliAuth: true }),
];
const codexStrategy = {
    agentId: "codex",
    command: "codex",
    checks: [
        checkCliInstalled("codex", "Codex"),
        ...codexApiKeyAndRateLimitCheck,
    ],
};
// ---------------------------------------------------------------------------
// Google CLI strategies
// ---------------------------------------------------------------------------
// Validate Google auth via GET /v1beta/models (free, no tokens)
const googleAuthCheck = {
    id: "api_key_valid",
    run: async (ctx) => {
        const start = performance.now();
        const apiKey = ctx.env.GOOGLE_API_KEY ?? ctx.env.GEMINI_API_KEY;
        if (apiKey) {
            // Probe the models endpoint to validate the key
            try {
                const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
                    headers: { "x-goog-api-key": apiKey },
                    signal: AbortSignal.timeout(4_000),
                });
                const elapsed = performance.now() - start;
                if (res.status === 400 || res.status === 403) {
                    return {
                        id: "api_key_valid",
                        status: "fail",
                        message: `Google API key is invalid (${res.status})`,
                        durationMs: elapsed,
                    };
                }
                return {
                    id: "api_key_valid",
                    status: "pass",
                    message: "Google API key is valid",
                    durationMs: elapsed,
                };
            }
            catch (err) {
                return {
                    id: "api_key_valid",
                    status: "error",
                    message: `Google API probe failed: ${err instanceof Error ? err.message : String(err)}`,
                    durationMs: performance.now() - start,
                };
            }
        }
        // No API key — check gcloud auth
        const result = spawnSync("gcloud", ["auth", "print-access-token"], {
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 3_000,
        });
        const elapsed = performance.now() - start;
        if (result.status === 0 && result.stdout?.toString("utf8").trim()) {
            return {
                id: "api_key_valid",
                status: "pass",
                message: "Authenticated via gcloud",
                durationMs: elapsed,
            };
        }
        return {
            id: "api_key_valid",
            status: "fail",
            message: "No GOOGLE_API_KEY/GEMINI_API_KEY set and gcloud auth not configured",
            durationMs: elapsed,
        };
    },
};
const googleRateLimitCheck = {
    id: "rate_limit_status",
    run: async (ctx) => {
        const start = performance.now();
        const apiKey = ctx.env.GOOGLE_API_KEY ?? ctx.env.GEMINI_API_KEY;
        if (!apiKey) {
            return {
                id: "rate_limit_status",
                status: "skip",
                message: "gcloud auth mode — cannot probe rate limits via API key",
                durationMs: 0,
            };
        }
        try {
            const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
                headers: { "x-goog-api-key": apiKey },
                signal: AbortSignal.timeout(4_000),
            });
            const elapsed = performance.now() - start;
            if (res.status === 429) {
                const retryAfter = res.headers.get("retry-after");
                return {
                    id: "rate_limit_status",
                    status: "fail",
                    message: `Currently rate limited (429)${retryAfter ? ` — retry after ${retryAfter}s` : ""}`,
                    detail: { retryAfter },
                    durationMs: elapsed,
                };
            }
            return {
                id: "rate_limit_status",
                status: "pass",
                message: "Rate limit OK",
                durationMs: elapsed,
            };
        }
        catch (err) {
            return {
                id: "rate_limit_status",
                status: "error",
                message: `Rate limit probe failed: ${err instanceof Error ? err.message : String(err)}`,
                durationMs: performance.now() - start,
            };
        }
    },
};
const antigravityAuthSkip = {
    id: "api_key_valid",
    run: async () => {
        return {
            id: "api_key_valid",
            status: "skip",
            message: "Antigravity CLI uses Google Sign-In/keyring auth; run `agy` to authenticate.",
            durationMs: 0,
        };
    },
};
const antigravityRateLimitSkip = {
    id: "rate_limit_status",
    run: async () => {
        return {
            id: "rate_limit_status",
            status: "skip",
            message: "Antigravity CLI rate limits are checked by the CLI at runtime.",
            durationMs: 0,
        };
    },
};
const antigravityStrategy = {
    agentId: "antigravity",
    command: "agy",
    checks: [
        checkCliInstalled("agy", "Antigravity CLI"),
        antigravityAuthSkip,
        antigravityRateLimitSkip,
    ],
};
// ---------------------------------------------------------------------------
// Pi strategy helpers — dispatch checks based on which provider pi is using
// ---------------------------------------------------------------------------
/**
 * Resolve the effective pi provider family from an explicit `--provider`, a
 * `provider/model` prefix, or a bare model id's well-known prefix.
 * @param {DiagnosticHints | undefined} hints
 * @returns {string}
 */
function resolvePiProvider(hints) {
    const explicit = (hints?.provider || "").trim().toLowerCase();
    if (explicit) {
        return explicit;
    }
    const model = typeof hints?.model === "string" ? hints.model.trim().toLowerCase() : "";
    if (!model) {
        return "";
    }
    if (model.includes("/")) {
        return model.split("/")[0];
    }
    // Bare model id (no provider prefix) — infer the provider family from
    // common id prefixes so diagnostics probe the right backend.
    if (model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-") || model.startsWith("o4-") || model.startsWith("chatgpt")) {
        return "openai";
    }
    if (model.startsWith("claude")) {
        return "anthropic";
    }
    if (model.startsWith("gemini")) {
        return "google";
    }
    return "";
}
/**
 * @param {DiagnosticHints | undefined} hints
 * @returns {DiagnosticCheckDef[]}
 */
function piProviderChecks(hints) {
    const raw = resolvePiProvider(hints);
    if (raw === "openai" || raw === "openai-codex" || raw === "azure" || raw === "azure-openai") {
        // pi reads OPENAI_API_KEY from the env (or --api-key), not codex's
        // auth.json, so it still requires the key — no Codex CLI auth fallback.
        return [
            openaiApiKeyCheck({ codexCliAuth: false }),
            openaiRateLimitCheck({ codexCliAuth: false }),
        ];
    }
    if (raw === "anthropic" || raw === "claude") {
        return [claudeApiKeyCheck, claudeRateLimitCheck];
    }
    if (raw === "google" || raw === "gemini") {
        return [googleAuthCheck, googleRateLimitCheck];
    }
    // Unknown provider — skip preflight, pi handles its own auth
    return [
        {
            id: "api_key_valid",
            run: async () => ({
                id: "api_key_valid",
                status: "skip",
                message: `Pi provider "${raw || "unset"}" — passing auth to pi`,
                durationMs: 0,
            }),
        },
    ];
}
/**
 * pi accepts credentials via the `--api-key` option instead of an environment
 * variable. Diagnostics only see the process env, so map an explicit apiKey to
 * the env var the selected provider's checks read — otherwise an apiKey-only pi
 * run is misreported as "key missing" (#284). Returns undefined when there is
 * nothing to inject.
 * @param {string} command
 * @param {DiagnosticHints | undefined} hints
 * @returns {Record<string, string> | undefined}
 */
export function diagnosticApiKeyEnv(command, hints) {
    if (command !== "pi" || !hints?.apiKey) {
        return undefined;
    }
    const raw = resolvePiProvider(hints);
    if (raw === "openai" || raw === "openai-codex" || raw === "azure" || raw === "azure-openai") {
        return { OPENAI_API_KEY: hints.apiKey };
    }
    if (raw === "anthropic" || raw === "claude") {
        return { ANTHROPIC_API_KEY: hints.apiKey };
    }
    if (raw === "google" || raw === "gemini") {
        return { GOOGLE_API_KEY: hints.apiKey };
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// Amp strategy
// ---------------------------------------------------------------------------
const ampApiKeySkip = {
    id: "api_key_valid",
    run: async () => {
        return {
            id: "api_key_valid",
            status: "skip",
            message: "Amp uses its own auth — skipping API key check",
            durationMs: 0,
        };
    },
};
const ampRateLimitSkip = {
    id: "rate_limit_status",
    run: async () => {
        return {
            id: "rate_limit_status",
            status: "skip",
            message: "Amp uses its own auth — skipping rate limit check",
            durationMs: 0,
        };
    },
};
const ampStrategy = {
    agentId: "amp",
    command: "amp",
    checks: [
        checkCliInstalled("amp", "Amp"),
        ampApiKeySkip,
        ampRateLimitSkip,
    ],
};
// ---------------------------------------------------------------------------
// Strategy registry
// ---------------------------------------------------------------------------
const strategies = {
    claude: claudeStrategy,
    codex: codexStrategy,
    antigravity: antigravityStrategy,
    agy: antigravityStrategy,
    amp: ampStrategy,
};
/**
 * @param {string} command
 * @param {DiagnosticHints} [hints]
 * @returns {AgentDiagnosticStrategy | null}
 */
export function getDiagnosticStrategy(command, hints) {
    if (command === "pi") {
        return {
            agentId: "pi",
            command: "pi",
            checks: [checkCliInstalled("pi", "Pi"), ...piProviderChecks(hints)],
        };
    }
    return strategies[command] ?? null;
}
