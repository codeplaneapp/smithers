import type { Effect } from "effect";
import type { Schema } from "effect";
import type { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

export type GitHubRequestMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type GitHubRequestOptions<A = unknown> = {
  /** Effect Schema to validate/decode the response body with. */
  schema?: Schema.Schema<A>;
  /** Extra query params appended to the path. */
  query?: Record<string, string | number | boolean | undefined>;
};

/**
 * Minimal Effect-native GitHub REST client: `request` performs a single
 * REST call (with built-in retry on 429 / secondary-rate-limit / 5xx that
 * honors `Retry-After` and `x-ratelimit-reset`); `paginate` follows RFC 5988
 * `Link: rel="next"` headers and concatenates array pages.
 */
export type GitHubClientService = {
  request: <A = unknown>(
    method: GitHubRequestMethod,
    path: string,
    body?: unknown,
    options?: GitHubRequestOptions<A>,
  ) => Effect.Effect<A, SmithersError>;
  paginate: (
    path: string,
    options?: { perPage?: number; maxPages?: number },
  ) => Effect.Effect<unknown[], SmithersError>;
};
