/**
 * The provider behind a registered account. Subscription providers are
 * authenticated by a CLI config directory; API providers are authenticated by
 * an API key.
 */
type AccountProvider = "claude-code" | "codex" | "gemini" | "kimi" | "anthropic-api" | "openai-api" | "gemini-api";

/**
 * A single registered account. Either `configDir` (subscription providers) or
 * `apiKey` (API providers) is set, never both. The CLI enforces this at
 * registration time.
 */
type Account$1 = {
    /** Unique label, e.g. "claude-work". Lowercase, kebab/snake/camel-case OK. */
    label: string;
    /** Which CLI/API this account belongs to. */
    provider: AccountProvider;
    /**
     * Absolute path to the per-account CLI config directory. Set for
     * subscription providers (claude-code, codex, gemini, kimi).
     */
    configDir?: string;
    /**
     * Raw API key. Set for API providers (anthropic-api, openai-api,
     * gemini-api). Stored in plaintext in `~/.smithers/accounts.json` (mode 600).
     * For stricter handling, set this to the empty string and override at
     * runtime via the matching env var.
     */
    apiKey?: string;
    /** Optional default model to bake into the generated `agents.ts`. */
    model?: string;
    /** ISO timestamp of when this account was added. */
    addedAt?: string;
};

type AccountsFile = {
    version: 1;
    accounts: Account$1[];
};

/**
 * Returns the user-level Smithers root directory (~/.smithers by default).
 * Honors `SMITHERS_HOME` for tests and CI.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
declare function accountsRoot(env?: NodeJS.ProcessEnv): string;

/**
 * Path to the JSON registry that lists all accounts.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
declare function accountsFilePath(env?: NodeJS.ProcessEnv): string;

/**
 * Default location for a per-account CLI config dir, e.g.
 * `~/.smithers/accounts/claude-work`.
 *
 * @param {string} label
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
declare function defaultConfigDir(label: string, env?: NodeJS.ProcessEnv): string;

/**
 * Parses a raw JSON string into a validated AccountsFile. Throws SmithersError
 * with code `ACCOUNTS_FILE_INVALID` if the shape is wrong. Tolerates missing
 * accounts.json (caller passes an empty string for that).
 *
 * @param {string} raw
 * @returns {import("./AccountsFile.ts").AccountsFile}
 */
declare function parseAccountsFile(raw: string): AccountsFile;
declare const SUBSCRIPTION_PROVIDERS: Set<string>;
declare const API_KEY_PROVIDERS: Set<string>;
declare const VALID_PROVIDERS: Set<string>;

/**
 * Reads ~/.smithers/accounts.json. Returns an empty registry if the file does
 * not exist (a fresh install with no accounts is the normal startup state, not
 * an error).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("./AccountsFile.ts").AccountsFile}
 */
declare function readAccounts(env?: NodeJS.ProcessEnv): AccountsFile;

/**
 * Atomically writes the accounts registry to ~/.smithers/accounts.json. The
 * file is mode 0600 because it may contain raw API keys.
 *
 * @param {import("./AccountsFile.ts").AccountsFile} contents
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} the file path that was written
 */
declare function writeAccounts(contents: AccountsFile, env?: NodeJS.ProcessEnv): string;

/**
 * Returns the array of registered accounts, in registration order.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("./Account.ts").Account[]}
 */
declare function listAccounts(env?: NodeJS.ProcessEnv): Account$1[];

/**
 * Looks up an account by label. Returns undefined if not found (callers
 * decide whether absence is an error).
 *
 * @param {string} label
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("./Account.ts").Account | undefined}
 */
declare function getAccount(label: string, env?: NodeJS.ProcessEnv): Account$1 | undefined;

/** @typedef {import("./Account.ts").Account} Account */
/**
 * Adds (or replaces, if a same-label account exists) an account in the
 * registry. Validates the entry before persisting so a malformed call cannot
 * corrupt the file.
 *
 * @param {Account} account
 * @param {{ replace?: boolean; env?: NodeJS.ProcessEnv }} [options]
 * @returns {Account}
 */
declare function addAccount(account: Account, options?: {
    replace?: boolean;
    env?: NodeJS.ProcessEnv;
}): Account;
type Account = Account$1;

/**
 * Removes an account by label. Throws if no account exists with that label
 * unless `silent: true`.
 *
 * @param {string} label
 * @param {{ silent?: boolean; env?: NodeJS.ProcessEnv }} [options]
 * @returns {boolean} true if an entry was removed
 */
declare function removeAccount(label: string, options?: {
    silent?: boolean;
    env?: NodeJS.ProcessEnv;
}): boolean;

/**
 * Maps an account to the environment variables that the spawned CLI honors.
 * Used by the agent classes' `buildCommand` and by `smithers agent test` to
 * exercise an account without involving an agent.
 *
 * @param {import("./Account.ts").Account} account
 * @returns {Record<string, string>}
 */
declare function accountToProviderEnv(account: Account$1): Record<string, string>;

export { API_KEY_PROVIDERS, type Account$1 as Account, type AccountProvider, type AccountsFile, SUBSCRIPTION_PROVIDERS, VALID_PROVIDERS, accountToProviderEnv, accountsFilePath, accountsRoot, addAccount, defaultConfigDir, getAccount, listAccounts, parseAccountsFile, readAccounts, removeAccount, writeAccounts };
