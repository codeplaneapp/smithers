import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/**
 * Maps an account to the environment variables that the spawned CLI honors.
 * Used by the agent classes' `buildCommand` and by `smithers agent test` to
 * exercise an account without involving an agent.
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
