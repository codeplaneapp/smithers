import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { addAccount, defaultConfigDir } from "@smithers-orchestrator/accounts";
import { regenerateAgentsTsIfPresent } from "./regenerateAgentsTsIfPresent.js";

/** @typedef {import("@smithers-orchestrator/accounts").AccountProvider} AccountProvider */

/**
 * Provider id → CLI binary name. For API-key providers this is null because
 * they don't have a separate CLI to log into.
 * @type {Record<string, string | null>}
 */
const SUBSCRIPTION_LOGIN_BIN = {
    "claude-code": "claude",
    "antigravity": "agy",
    "codex": "codex",
    "kimi": "kimi",
    "anthropic-api": null,
    "openai-api": null,
    "gemini-api": null,
};

/**
 * Subcommand args appended to the login command. Some CLIs use a dedicated
 * subcommand (`codex login`, `kimi login`); others authenticate via a slash
 * command inside the REPL (the user types /login after launching).
 * @type {Record<string, string[] | ((configDir: string) => string[])>}
 */
const SUBSCRIPTION_LOGIN_ARGS = {
    "claude-code": [],
    "antigravity": (configDir) => ["--gemini_dir", configDir],
    "codex": ["login"],
    "kimi": ["login"],
};

/**
 * Provider id → env var the CLI reads to find its config dir.
 * @type {Record<string, string | null>}
 */
const SUBSCRIPTION_DIR_ENV_VAR = {
    "claude-code": "CLAUDE_CONFIG_DIR",
    "antigravity": "GEMINI_DIR",
    "codex": "CODEX_HOME",
    "kimi": "KIMI_SHARE_DIR",
    "anthropic-api": null,
    "openai-api": null,
    "gemini-api": null,
};

/**
 * @param {string} provider
 * @param {string} configDir
 */
function subscriptionLoginArgs(provider, configDir) {
    const args = SUBSCRIPTION_LOGIN_ARGS[provider] ?? [];
    return typeof args === "function" ? args(configDir) : args;
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function dirHasContents(dir) {
    if (!existsSync(dir)) return false;
    try { return readdirSync(dir).length > 0; }
    catch { return false; }
}

/**
 * @typedef {{
 *   provider: AccountProvider;
 *   label: string;
 *   configDir?: string;
 *   apiKey?: string;
 *   model?: string;
 *   skipLogin?: boolean;
 *   force?: boolean;
 *   replace?: boolean;
 *   env?: NodeJS.ProcessEnv;
 *   cwd?: string;
 *   loginInstructions?: (cmd: string) => void;
 * }} RunAgentAddInput
 */

/**
 * Non-interactive entry point: register an account from already-resolved
 * inputs. Used by both the flag-driven CLI and the clack wizard. Returns the
 * persisted account plus a summary of the register/regen operation.
 *
 * @param {RunAgentAddInput} input
 */
export function runAgentAdd(input) {
    const env = input.env ?? process.env;
    const cwd = input.cwd ?? process.cwd();
    const isSubscription = SUBSCRIPTION_LOGIN_BIN[input.provider] !== null;
    const isApiKey = !isSubscription;
    if (isSubscription) {
        const configDir = input.configDir ?? defaultConfigDir(input.label, env);
        mkdirSync(configDir, { recursive: true });
        // Verify there's something there before registering, unless --force or
        // --skip-login (e2e tests pre-populate a fake credentials file).
        const populated = dirHasContents(configDir);
        if (!populated && !input.skipLogin && !input.force) {
            const bin = SUBSCRIPTION_LOGIN_BIN[input.provider];
            const envVar = SUBSCRIPTION_DIR_ENV_VAR[input.provider];
            const subArgs = subscriptionLoginArgs(input.provider, configDir);
            const cmd = `${envVar}=${configDir} ${bin}${subArgs.length ? " " + subArgs.join(" ") : ""}`;
            const detail = `Config dir ${configDir} is empty. Run the following in another terminal to log in, then re-run \`smithers agents add\`:\n\n  ${cmd}\n\n(or pass --skip-login to register the empty dir, --force to register without verification)`;
            return { ok: false, reason: "login-required", detail, configDir };
        }
        const account = addAccount({
            label: input.label,
            provider: input.provider,
            configDir,
            model: input.model,
        }, { env, replace: input.replace });
        const regen = regenerateAgentsTsIfPresent(cwd);
        return { ok: true, account, regen };
    }
    if (isApiKey) {
        if (typeof input.apiKey !== "string") {
            return { ok: false, reason: "missing-api-key", detail: `Provider ${input.provider} requires --api-key (may be empty for env-var-only).` };
        }
        const account = addAccount({
            label: input.label,
            provider: input.provider,
            apiKey: input.apiKey,
            model: input.model,
        }, { env, replace: input.replace });
        const regen = regenerateAgentsTsIfPresent(cwd);
        return { ok: true, account, regen };
    }
    return { ok: false, reason: "unknown-provider", detail: `Unknown provider: ${input.provider}` };
}

/**
 * Quick health check: spawn `<bin> --version` (or equivalent) under the
 * account's env vars and report whether the CLI starts cleanly. Best-effort —
 * a non-zero exit is reported but does not throw.
 *
 * @param {{ provider: AccountProvider; configDir?: string; apiKey?: string }} account
 * @returns {{ ran: boolean; exitCode: number | null; cmd: string }}
 */
export function pingAccount(account) {
    const bin = SUBSCRIPTION_LOGIN_BIN[account.provider];
    if (!bin) return { ran: false, exitCode: null, cmd: "(api-key provider; no CLI to ping)" };
    const envVar = SUBSCRIPTION_DIR_ENV_VAR[account.provider];
    const env = { ...process.env };
    if (envVar && account.configDir) env[envVar] = account.configDir;
    const result = spawnSync(bin, ["--version"], { env, encoding: "utf8" });
    return {
        ran: true,
        exitCode: result.status,
        cmd: `${envVar ? `${envVar}=${account.configDir} ` : ""}${bin} --version`,
    };
}
