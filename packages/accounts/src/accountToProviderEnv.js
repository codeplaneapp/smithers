import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/**
 * Maps an account to the environment variables the matching provider CLI
 * honors. This is the canonical account→env mapping; packages/usage's
 * `getAccountUsage` and the CLI's `runAgentAdd` (SUBSCRIPTION_DIR_ENV_VAR)
 * mirror it rather than importing it, and must stay aligned.
 *
 * @param {import("./Account.ts").Account} account
 * @returns {Record<string, string>}
 */
export function accountToProviderEnv(account) {
    switch (account.provider) {
        case "claude-code":
            if (!account.configDir) {
                throw new SmithersError("ACCOUNT_INVALID", `claude-code account "${account.label}" missing configDir`);
            }
            return { CLAUDE_CONFIG_DIR: account.configDir };
        case "antigravity":
            if (!account.configDir) {
                throw new SmithersError("ACCOUNT_INVALID", `antigravity account "${account.label}" missing configDir`);
            }
            return { GEMINI_DIR: account.configDir };
        case "codex":
            if (!account.configDir) {
                throw new SmithersError("ACCOUNT_INVALID", `codex account "${account.label}" missing configDir`);
            }
            return { CODEX_HOME: account.configDir };
        case "kimi":
            if (!account.configDir) {
                throw new SmithersError("ACCOUNT_INVALID", `kimi account "${account.label}" missing configDir`);
            }
            return { KIMI_SHARE_DIR: account.configDir };
        case "anthropic-api":
            return account.apiKey ? { ANTHROPIC_API_KEY: account.apiKey } : {};
        case "openai-api":
            return account.apiKey ? { OPENAI_API_KEY: account.apiKey } : {};
        case "gemini-api":
            return account.apiKey ? { GEMINI_API_KEY: account.apiKey } : {};
        default:
            const exhaustive = /** @type {never} */ (account.provider);
            throw new SmithersError("ACCOUNT_INVALID", `unknown provider: ${exhaustive}`);
    }
}
