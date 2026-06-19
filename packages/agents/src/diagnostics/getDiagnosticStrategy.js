import { spawnSync } from "node:child_process";
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
// Combined API key validation + rate limit check via GET /v1/models (free, no tokens)
const codexApiKeyAndRateLimitCheck = [
    {
        id: "api_key_valid",
        run: async (ctx) => {
            const start = performance.now();
            const apiKey = ctx.env.OPENAI_API_KEY;
            if (!apiKey) {
                return {
                    id: "api_key_valid",
                    status: "fail",
                    message: "OPENAI_API_KEY not set",
                    durationMs: performance.now() - start,
                };
            }
            try {
                const res = await fetch("https://api.openai.com/v1/models", {
                    headers: { Authorization: `Bearer ${apiKey}` },
                    signal: AbortSignal.timeout(4_000),
                });
                const elapsed = performance.now() - start;
                if (res.status === 401) {
                    return {
                        id: "api_key_valid",
                        status: "fail",
                        message: "OPENAI_API_KEY is invalid (401 Unauthorized)",
                        durationMs: elapsed,
                    };
                }
                if (res.status === 403) {
                    return {
                        id: "api_key_valid",
                        status: "fail",
                        message: "OPENAI_API_KEY lacks permission (403 Forbidden)",
                        durationMs: elapsed,
                    };
                }
                return {
                    id: "api_key_valid",
                    status: "pass",
                    message: "OPENAI_API_KEY is valid",
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
    },
    {
        id: "rate_limit_status",
        run: async (ctx) => {
            const start = performance.now();
            const apiKey = ctx.env.OPENAI_API_KEY;
            if (!apiKey) {
                return {
                    id: "rate_limit_status",
                    status: "skip",
                    message: "No API key — cannot check rate limits",
                    durationMs: 0,
                };
            }
            try {
                const res = await fetch("https://api.openai.com/v1/models", {
                    headers: { Authorization: `Bearer ${apiKey}` },
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
    },
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
// Pi strategy
// ---------------------------------------------------------------------------
/**
 * Resolve the effective pi provider family from an explicit `--provider`, a
 * `provider/model` prefix, or a bare model id's well-known prefix. Returns ""
 * when undeterminable so callers fall back to pi's default (google) (#284).
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
        return [...codexApiKeyAndRateLimitCheck];
    }
    if (raw === "anthropic" || raw === "claude") {
        return [claudeApiKeyCheck, claudeRateLimitCheck];
    }
    return [googleAuthCheck, googleRateLimitCheck];
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
    return { GOOGLE_API_KEY: hints.apiKey };
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
