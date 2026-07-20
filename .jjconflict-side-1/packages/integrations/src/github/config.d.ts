import { GitHubConfig as GitHubConfig$1, ResolvedGitHubConfig as ResolvedGitHubConfig$1 } from './GitHubConfig.js';

/**
 * Register process-wide GitHub credentials for outbound components and the
 * webhook source. A bound `createSmithers` instance (later phase) can instead
 * pass config explicitly per component via the non-public `__config` prop —
 * explicit config always wins over this registry, which wins over env vars.
 *
 * @param {GitHubConfig | null | undefined} config Pass `null` to clear.
 */
declare function configureGitHub(config: GitHubConfig | null | undefined): void;
/**
 * Resolve the effective GitHub config: explicit (`__config` prop / call-site
 * argument) → `configureGitHub` registry → environment
 * (`SMITHERS_GITHUB_TOKEN`/`GITHUB_TOKEN`, `SMITHERS_GITHUB_API_BASE_URL`,
 * `SMITHERS_GITHUB_WEBHOOK_SECRET`). Internal — not part of the public API.
 *
 * @param {GitHubConfig} [explicit]
 * @returns {ResolvedGitHubConfig}
 */
declare function resolveGitHubConfig(explicit?: GitHubConfig): ResolvedGitHubConfig;
/** @typedef {import("./GitHubConfig.ts").GitHubConfig} GitHubConfig */
/** @typedef {import("./GitHubConfig.ts").ResolvedGitHubConfig} ResolvedGitHubConfig */
declare const DEFAULT_GITHUB_API_BASE_URL: "https://api.github.com";
type GitHubConfig = GitHubConfig$1;
type ResolvedGitHubConfig = ResolvedGitHubConfig$1;

export { DEFAULT_GITHUB_API_BASE_URL, type GitHubConfig, type ResolvedGitHubConfig, configureGitHub, resolveGitHubConfig };
