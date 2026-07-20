/**
 * A raw `accounts.json` entry whose `provider` this build does not recognize —
 * e.g. a pre-0.25 `gemini` subscription row. Carried verbatim through
 * read → write so an unrelated `agents add`/`agents remove` cannot destroy the
 * credentials its `configDir` points at.
 *
 * `label` is always a non-empty string: `parseAccountsFile` validates the label
 * before it validates the provider.
 */
type UnknownAccount$1 = {
    label: string;
    provider?: unknown;
    [key: string]: unknown;
};

/**
 * The provider behind a registered account. Subscription providers are
 * authenticated by a CLI config directory; API providers are authenticated by
 * an API key.
 */
type AccountProvider$1 = "claude-code" | "antigravity" | "codex" | "kimi" | "anthropic-api" | "openai-api" | "gemini-api";

/**
 * A single registered account. Either `configDir` (subscription providers) or
 * `apiKey` (API providers) is set, never both. The CLI enforces this at
 * registration time.
 */
type Account$2 = {
    /** Unique label, e.g. "claude-work". Lowercase, kebab/snake/camel-case OK. */
    label: string;
    /** Which CLI/API this account belongs to. */
    provider: AccountProvider$1;
    /**
     * Absolute path to the per-account CLI config directory. Set for
     * subscription providers (claude-code, antigravity, codex, kimi).
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

type AccountsFile$1 = {
    version: 1;
    accounts: Account$2[];
    /**
     * Raw entries whose provider this build does not recognize. Present only when
     * the on-disk file carries such rows. Never serialized under this key —
     * `writeAccounts` merges them back into `accounts` so an unrelated mutation
     * cannot erase them.
     */
    unknownAccounts?: UnknownAccount$1[];
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
 * Reads ~/.smithers/accounts.json. Returns an empty registry if the file does
 * not exist (a fresh install with no accounts is the normal startup state, not
 * an error).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("./AccountsFile.ts").AccountsFile}
 */
declare function readAccounts(env?: NodeJS.ProcessEnv): AccountsFile$1;

/**
 * Atomically writes the accounts registry to ~/.smithers/accounts.json. The
 * file is mode 0600 because it may contain raw API keys.
 *
 * Writes to a temp file then renames over the target so a crash mid-write
 * leaves the existing accounts.json byte-identical (atomicity). If the rename
 * fails, the temp file — which contains plaintext API keys — is removed so it
 * cannot linger world-readable or accumulate under ~/.smithers.
 *
 * This is the single choke point that puts `unknownAccounts` — entries whose
 * provider this build doesn't recognize — back into the serialized `accounts`
 * array, appended after the known accounts, so an unrelated add/remove can't
 * erase a legacy row. `unknownAccounts` is never emitted as a key of its own.
 * A caller passing a plain `{ version, accounts }` gets byte-identical output
 * to before.
 *
 * @param {import("./AccountsFile.ts").AccountsFile} contents
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} the file path that was written
 */
declare function writeAccounts(contents: AccountsFile$1, env?: NodeJS.ProcessEnv): string;

/**
 * Cross-process advisory lock around accounts.json read-modify-write. Smithers
 * runs many agents/CLIs concurrently and both the wizard and the programmatic
 * API can mutate ~/.smithers/accounts.json at the same time. Without a lock,
 * two callers each readAccounts() the same base state and then writeAccounts()
 * the whole file via atomic rename — the second rename clobbers the first
 * writer's entry (lost update). This serializes those critical sections.
 *
 * The lock is an O_EXCL lock file next to accounts.json: only one process can
 * create it. Others spin-wait briefly. A lock older than {@link STALE_LOCK_MS}
 * is treated as orphaned (the holder crashed) and broken, so a killed process
 * can never wedge the registry permanently — which matters because Smithers'
 * whole premise is surviving kills/restarts.
 *
 * @template T
 * @param {NodeJS.ProcessEnv} env
 * @param {() => T} critical the read-modify-write to run while holding the lock
 * @returns {T}
 */
declare function withAccountsLock<T>(env: NodeJS.ProcessEnv, critical: () => T): T;

/**
 * Returns the array of registered accounts, in registration order.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("./Account.ts").Account[]}
 */
declare function listAccounts(env?: NodeJS.ProcessEnv): Account$2[];

/**
 * Looks up an account by label. Returns undefined if not found (callers
 * decide whether absence is an error).
 *
 * @param {string} label
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("./Account.ts").Account | undefined}
 */
declare function getAccount(label: string, env?: NodeJS.ProcessEnv): Account$2 | undefined;

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
declare function addAccount(account: Account$1, options?: {
    replace?: boolean;
    env?: NodeJS.ProcessEnv;
}): Account$1;
type Account$1 = Account$2;

/**
 * Removes an account by label. Also removes a preserved unknown-provider entry
 * with that label — since those now survive every rewrite, `agents remove` is
 * the supported way to clean up or migrate one. Throws if no account exists
 * with that label unless `silent: true`.
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
 * Maps an account to the environment variables the matching provider CLI
 * honors. This is the canonical account→env mapping; packages/usage's
 * `getAccountUsage` and the CLI's `runAgentAdd` (SUBSCRIPTION_DIR_ENV_VAR)
 * mirror it rather than importing it, and must stay aligned.
 *
 * @param {import("./Account.ts").Account} account
 * @returns {Record<string, string>}
 */
declare function accountToProviderEnv(account: Account$2): Record<string, string>;

/**
 * Parses a raw JSON string into a validated AccountsFile. Throws SmithersError
 * with code `ACCOUNTS_FILE_INVALID` if the file itself is unparseable or has the
 * wrong top-level shape. Tolerates missing accounts.json (caller passes an empty
 * string for that).
 *
 * Individual account entries whose `provider` is not a recognized value (e.g. a
 * legacy `gemini` account left over after that subscription provider was
 * removed) are excluded from `accounts` with a warning rather than failing the
 * whole file, so one stale entry can't lock a user out of all their valid
 * accounts. They are returned verbatim in `unknownAccounts` (omitted when there
 * are none) so `writeAccounts` can preserve them on rewrite. Entries that are
 * recognized but malformed (missing label, missing required configDir/apiKey,
 * etc.) still throw, since those indicate real corruption of a live account.
 *
 * @param {string} raw
 * @returns {import("./AccountsFile.ts").AccountsFile}
 */
declare function parseAccountsFile(raw: string): AccountsFile$1;
declare const SUBSCRIPTION_PROVIDERS: Set<string>;
declare const API_KEY_PROVIDERS: Set<string>;
declare const VALID_PROVIDERS: Set<string>;

/**
 * Builds an RFC 6749 authorization-code request URL with RFC 7636 PKCE parameters.
 */
declare function buildAuthorizationUrl(request: {
    authorizationEndpoint: string;
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scope?: string | readonly string[];
    codeChallengeMethod?: "S256" | "plain";
    extraParams?: Record<string, string>;
}): string;

/**
 * Creates an RFC 7636 PKCE code_verifier using high-entropy random bytes.
 *
 * @param {number} [byteLength]
 * @returns {string}
 */
declare function createCodeVerifier(byteLength?: number): string;
/**
 * Derives an RFC 7636 S256 code_challenge for a code_verifier.
 *
 * @param {string} codeVerifier
 * @returns {string}
 */
declare function deriveCodeChallenge(codeVerifier: string): string;
/**
 * Creates a full RFC 7636 S256 PKCE parameter set.
 *
 * @param {number} [byteLength]
 * @returns {{ codeVerifier: string; codeChallenge: string; codeChallengeMethod: "S256" }}
 */
declare function createPkcePair(byteLength?: number): {
    codeVerifier: string;
    codeChallenge: string;
    codeChallengeMethod: "S256";
};

type Account = Account$2;
type AccountProvider = AccountProvider$1;
type AccountsFile = AccountsFile$1;
type UnknownAccount = UnknownAccount$1;

export { API_KEY_PROVIDERS, type Account, type AccountProvider, type AccountsFile, SUBSCRIPTION_PROVIDERS, type UnknownAccount, VALID_PROVIDERS, accountToProviderEnv, accountsFilePath, accountsRoot, addAccount, buildAuthorizationUrl, createCodeVerifier, createPkcePair, defaultConfigDir, deriveCodeChallenge, getAccount, listAccounts, parseAccountsFile, readAccounts, removeAccount, withAccountsLock, writeAccounts };
