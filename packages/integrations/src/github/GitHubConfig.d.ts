/**
 * Configuration for the GitHub integration: outbound REST client + webhook
 * ingress. All fields are optional at the type level; each consumer resolves
 * what it needs through `resolveGitHubConfig` (explicit → `configureGitHub`
 * registry → environment) and fails loudly when a required value is missing.
 */
type GitHubConfig = {
    /**
     * Personal access token / installation token used for outbound REST calls.
     * Falls back to `SMITHERS_GITHUB_TOKEN` then `GITHUB_TOKEN`. Never logged.
     */
    token?: string;
    /**
     * REST API base URL. Defaults to `https://api.github.com`; override to
     * point at GitHub Enterprise or a test fixture server
     * (`SMITHERS_GITHUB_API_BASE_URL`).
     */
    apiBaseUrl?: string;
    /**
     * HMAC secret for `X-Hub-Signature-256` webhook verification
     * (`SMITHERS_GITHUB_WEBHOOK_SECRET`).
     */
    webhookSecret?: string;
    /** Max retries for 429/secondary-rate-limit/5xx responses. @default 3 */
    maxRetries?: number;
};
/** Fully-resolved config (defaults applied) used by the client internals. */
type ResolvedGitHubConfig = {
    token: string | undefined;
    apiBaseUrl: string;
    webhookSecret: string | undefined;
    maxRetries: number;
};

export type { GitHubConfig, ResolvedGitHubConfig };
