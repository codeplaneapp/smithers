// @smithers-type-exports-begin
/** @typedef {import("./GitHubConfig.ts").GitHubConfig} GitHubConfig */
/** @typedef {import("./GitHubConfig.ts").ResolvedGitHubConfig} ResolvedGitHubConfig */
// @smithers-type-exports-end

export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_MAX_RETRIES = 3;

/** @type {GitHubConfig | null} */
let registeredConfig = null;

/**
 * Register process-wide GitHub credentials for outbound components and the
 * webhook source. A bound `createSmithers` instance (later phase) can instead
 * pass config explicitly per component via the non-public `__config` prop —
 * explicit config always wins over this registry, which wins over env vars.
 *
 * @param {GitHubConfig | null | undefined} config Pass `null` to clear.
 */
export function configureGitHub(config) {
  registeredConfig = config ? { ...config } : null;
}

/**
 * @param {(string | undefined)[]} candidates
 * @returns {string | undefined}
 */
function firstNonEmpty(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

/**
 * Resolve the effective GitHub config: explicit (`__config` prop / call-site
 * argument) → `configureGitHub` registry → environment
 * (`SMITHERS_GITHUB_TOKEN`/`GITHUB_TOKEN`, `SMITHERS_GITHUB_API_BASE_URL`,
 * `SMITHERS_GITHUB_WEBHOOK_SECRET`). Internal — not part of the public API.
 *
 * @param {GitHubConfig} [explicit]
 * @returns {ResolvedGitHubConfig}
 */
export function resolveGitHubConfig(explicit) {
  const env = typeof process !== "undefined" ? process.env : {};
  return {
    token: firstNonEmpty([explicit?.token, registeredConfig?.token, env.SMITHERS_GITHUB_TOKEN, env.GITHUB_TOKEN]),
    apiBaseUrl:
      firstNonEmpty([explicit?.apiBaseUrl, registeredConfig?.apiBaseUrl, env.SMITHERS_GITHUB_API_BASE_URL]) ??
      DEFAULT_GITHUB_API_BASE_URL,
    webhookSecret: firstNonEmpty([
      explicit?.webhookSecret,
      registeredConfig?.webhookSecret,
      env.SMITHERS_GITHUB_WEBHOOK_SECRET,
    ]),
    maxRetries: explicit?.maxRetries ?? registeredConfig?.maxRetries ?? DEFAULT_MAX_RETRIES,
  };
}
