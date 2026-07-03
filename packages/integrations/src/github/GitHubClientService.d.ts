import { Schema, Effect } from 'effect';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';

type GitHubRequestMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type GitHubRequestOptions<A = unknown> = {
    /** Effect Schema to validate/decode the response body with. */
    schema?: Schema.Schema<A, any>;
    /** Extra query params appended to the path. */
    query?: Record<string, string | number | boolean | undefined>;
};
/**
 * Minimal Effect-native GitHub REST client: `request` performs a single
 * REST call (with built-in retry on 429 / secondary-rate-limit / 5xx that
 * honors `Retry-After` and `x-ratelimit-reset`); `paginate` follows RFC 5988
 * `Link: rel="next"` headers and concatenates array pages.
 */
type GitHubClientService = {
    request: <A = unknown>(method: GitHubRequestMethod, path: string, body?: unknown, options?: GitHubRequestOptions<A>) => Effect.Effect<A, SmithersError>;
    paginate: (path: string, options?: {
        perPage?: number;
        maxPages?: number;
    }) => Effect.Effect<unknown[], SmithersError>;
};

export type { GitHubClientService, GitHubRequestMethod, GitHubRequestOptions };
