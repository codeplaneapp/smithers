import { GitHubConfig as GitHubConfig$1 } from './GitHubConfig.js';
import { GitHubClientService as GitHubClientService$1, GitHubRequestMethod as GitHubRequestMethod$1, GitHubRequestOptions as GitHubRequestOptions$1 } from './GitHubClientService.js';
import { Context, Layer } from 'effect';
import '@smithers-orchestrator/errors/SmithersError';

/**
 * Parse RFC 5988 `Link` header for the `rel="next"` URL.
 * @param {string | null} linkHeader
 * @returns {string | null}
 */
declare function nextPageUrl(linkHeader: string | null): string | null;
/**
 * Build a GitHub REST client bound to `config` (explicit → `configureGitHub`
 * registry → env). The token is only ever written into the Authorization
 * header — never into errors, logs, or details.
 *
 * @param {GitHubConfig} [config]
 * @returns {GitHubClientService}
 */
declare function makeGitHubClient(config?: GitHubConfig): GitHubClientService;
/**
 * Live Layer for {@link GitHubClient}.
 * @param {GitHubConfig} [config]
 */
declare function githubClientLayer(config?: GitHubConfig): Layer.Layer<GitHubClientTag, never, never>;
/**
 * Context tag for the GitHub REST client. Provide it with
 * `githubClientLayer(config)` (or `Layer.succeed(GitHubClient, makeGitHubClient(...))`).
 * @type {Context.ServiceClass<GitHubClientTag, "GitHubClient", GitHubClientService>}
 */
declare const GitHubClient: Context.ServiceClass<GitHubClientTag, "GitHubClient", GitHubClientService>;
type GitHubClientTag = {
    readonly _: unique symbol;
};
type GitHubClientService = GitHubClientService$1;
type GitHubRequestMethod = GitHubRequestMethod$1;
type GitHubRequestOptions<A> = GitHubRequestOptions$1<A>;
type GitHubConfig = GitHubConfig$1;

export { GitHubClient, type GitHubClientService, type GitHubClientTag, type GitHubConfig, type GitHubRequestMethod, type GitHubRequestOptions, githubClientLayer, makeGitHubClient, nextPageUrl };
