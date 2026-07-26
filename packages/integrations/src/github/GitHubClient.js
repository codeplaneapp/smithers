// @smithers-type-exports-begin
/** @typedef {import("./GitHubClientService.ts").GitHubClientService} GitHubClientService */
/** @typedef {import("./GitHubClientService.ts").GitHubRequestMethod} GitHubRequestMethod */
/**
 * @template A
 * @typedef {import("./GitHubClientService.ts").GitHubRequestOptions<A>} GitHubRequestOptions
 */
// @smithers-type-exports-end

import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect";
import { logWarning } from "@smithers-orchestrator/observability/logging";
import { IntegrationError } from "../core/IntegrationError.js";
import { resolveGitHubConfig } from "./config.js";

/** @typedef {import("./GitHubConfig.ts").GitHubConfig} GitHubConfig */

// Upper bound for honoring Retry-After / x-ratelimit-reset so a hostile or
// clock-skewed header can never park a workflow task for hours.
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Context tag for the GitHub REST client. Provide it with
 * `githubClientLayer(config)` (or `Layer.succeed(GitHubClient, makeGitHubClient(...))`).
 * @type {Context.TagClass<GitHubClientTag, "GitHubClient", GitHubClientService>}
 */
export const GitHubClient = /** @type {Context.TagClass<GitHubClientTag, "GitHubClient", GitHubClientService>} */ (
  /** @type {unknown} */ (Context.Tag("GitHubClient")())
);
/** @typedef {{ readonly _: unique symbol }} GitHubClientTag */

/**
 * Ports the rate-limit detection behavior of mature GitHub clients: a 403
 * counts as rate limiting when `x-ratelimit-remaining` is exhausted or the
 * body mentions the (secondary) rate/abuse limit.
 * @param {number} status
 * @param {Headers} headers
 * @param {unknown} body
 * @returns {boolean}
 */
function isRateLimitResponse(status, headers, body) {
  if (status === 429) {
    return true;
  }
  if (status !== 403) {
    return false;
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    return true;
  }
  const message =
    body &&
    typeof body === "object" &&
    "message" in body &&
    typeof (/** @type {{ message?: unknown }} */ (body).message) === "string"
      ? /** @type {{ message: string }} */ (body).message.toLowerCase()
      : "";
  return message.includes("rate limit") || message.includes("abuse");
}

/**
 * Delay to wait before retrying, from `Retry-After` (seconds) or
 * `x-ratelimit-reset` (epoch seconds), capped at {@link MAX_RETRY_AFTER_MS}.
 * @param {Headers} headers
 * @returns {number | null}
 */
function retryAfterMs(headers) {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null) {
    const resetMs = Number(reset) * 1000 - Date.now();
    if (Number.isFinite(resetMs) && resetMs > 0) {
      return Math.min(resetMs, MAX_RETRY_AFTER_MS);
    }
  }
  return null;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableGitHubError(error) {
  return error instanceof IntegrationError && error.details?.retryable === true;
}

/**
 * Parse RFC 5988 `Link` header for the `rel="next"` URL.
 * @param {string | null} linkHeader
 * @returns {string | null}
 */
export function nextPageUrl(linkHeader) {
  if (!linkHeader) {
    return null;
  }
  for (const part of linkHeader.split(",")) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="next"$/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Build a GitHub REST client bound to `config` (explicit → `configureGitHub`
 * registry → env). The token is only ever written into the Authorization
 * header — never into errors, logs, or details.
 *
 * @param {GitHubConfig} [config]
 * @returns {GitHubClientService}
 */
export function makeGitHubClient(config) {
  const resolved = resolveGitHubConfig(config);
  const baseUrl = resolved.apiBaseUrl.replace(/\/+$/, "");
  const apiOrigin = new URL(baseUrl).origin;
  /**
   * Every request carries the bearer token, so absolute request URLs and
   * Link rel=next pagination targets must stay on the configured HTTP(S)
   * API origin — a foreign destination would receive the token.
   * @param {string} url
   * @returns {void}
   */
  const assertApiOrigin = (url) => {
    const parsed = new URL(url);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== apiOrigin) {
      throw new IntegrationError(
        "delivery-failed",
        `GitHub request refused: ${parsed.origin} is not the configured GitHub API origin.`,
        { origin: parsed.origin, apiOrigin, retryable: false },
      );
    }
  };
  /**
   * @param {string} path
   * @param {Record<string, string | number | boolean | undefined>} [query]
   * @returns {string}
   */
  const buildUrl = (path, query) => {
    const url = new URL(path.startsWith("http") ? path : `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  };
  /**
   * One HTTP attempt: resolves with `{ json, headers }` or fails with an
   * IntegrationError tagged `retryable` for 429/secondary-rate-limit/5xx.
   * Effect's interruption signal is forwarded to `fetch`, so interrupting the
   * fiber aborts the in-flight request and any pending body read.
   * @param {GitHubRequestMethod} method
   * @param {string} url
   * @param {unknown} [body]
   * @returns {Effect.Effect<{ json: unknown; headers: Headers }, IntegrationError>}
   */
  const attemptOnce = (method, url, body) =>
    Effect.tryPromise({
      try: async (signal) => {
        assertApiOrigin(url);
        /** @type {Record<string, string>} */
        const headers = {
          accept: "application/vnd.github+json",
          "user-agent": "smithers-integrations",
          "x-github-api-version": "2022-11-28",
        };
        if (resolved.token) {
          headers.authorization = `Bearer ${resolved.token}`;
        }
        if (body !== undefined) {
          headers["content-type"] = "application/json";
        }
        const response = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
        const text = await response.text();
        /** @type {unknown} */
        let json = null;
        if (text.length > 0) {
          try {
            json = JSON.parse(text);
          } catch {
            json = text;
          }
        }
        if (response.ok) {
          return { json, headers: response.headers };
        }
        const rateLimited = isRateLimitResponse(response.status, response.headers, json);
        const retryable = rateLimited || response.status >= 500;
        const message =
          json && typeof json === "object" && "message" in json
            ? String(/** @type {{ message: unknown }} */ (json).message)
            : response.statusText;
        throw new IntegrationError(
          "delivery-failed",
          `GitHub request failed: ${method} ${new URL(url).pathname} → ${response.status} ${message}`,
          {
            status: response.status,
            method,
            path: new URL(url).pathname,
            retryable,
            rateLimited,
            retryAfterMs: retryable ? retryAfterMs(response.headers) : null,
            ratelimitRemaining: response.headers.get("x-ratelimit-remaining"),
          },
        );
      },
      catch: (cause) =>
        cause instanceof IntegrationError
          ? cause
          : new IntegrationError(
              "delivery-failed",
              `GitHub request failed: ${method} — ${cause instanceof Error ? cause.message : String(cause)}`,
              { method, retryable: true },
              { cause },
            ),
    });
  /**
   * @param {GitHubRequestMethod} method
   * @param {string} url
   * @param {unknown} [body]
   */
  const requestUrl = (method, url, body) => {
    const retrySchedule = Schedule.intersect(
      Schedule.exponential("250 millis"),
      Schedule.recurs(resolved.maxRetries),
    ).pipe(
      Schedule.whileInput(isRetryableGitHubError),
      Schedule.passthrough,
      Schedule.addDelay(
        /** @param {unknown} error */ (error) => {
          if (!isRetryableGitHubError(error)) {
            return Duration.zero;
          }
          const details = /** @type {{ retryAfterMs?: number | null; status?: number }} */ (error.details ?? {});
          logWarning(
            "github request retrying",
            {
              method,
              path: new URL(url).pathname,
              status: details.status,
              retryAfterMs: details.retryAfterMs ?? null,
            },
            "integrations:github",
          );
          return typeof details.retryAfterMs === "number" && details.retryAfterMs > 0
            ? Duration.millis(details.retryAfterMs)
            : Duration.zero;
        },
      ),
    );
    return attemptOnce(method, url, body).pipe(Effect.retry(retrySchedule));
  };
  /** @type {GitHubClientService["request"]} */
  const request = (method, path, body, options) =>
    requestUrl(method, buildUrl(path, options?.query), body).pipe(
      Effect.flatMap(({ json }) =>
        options?.schema
          ? Schema.decodeUnknown(options.schema)(json).pipe(
              Effect.mapError(
                (cause) =>
                  new IntegrationError(
                    "decode-failed",
                    `GitHub response for ${method} ${path} failed schema validation.`,
                    { method, path },
                    { cause },
                  ),
              ),
            )
          : Effect.succeed(/** @type {any} */ (json)),
      ),
    );
  /** @type {GitHubClientService["paginate"]} */
  const paginate = (path, options) =>
    Effect.gen(function* () {
      const perPage = options?.perPage ?? 100;
      const maxPages = options?.maxPages ?? 10;
      /** @type {unknown[]} */
      const items = [];
      /** @type {string | null} */
      let url = buildUrl(path, { per_page: perPage });
      let pages = 0;
      while (url && pages < maxPages) {
        const { json, headers } = yield* requestUrl("GET", url);
        if (Array.isArray(json)) {
          items.push(...json);
        } else if (json !== null) {
          items.push(json);
        }
        url = nextPageUrl(headers.get("link"));
        pages += 1;
      }
      return items;
    });
  return { request, paginate };
}

/**
 * Live Layer for {@link GitHubClient}.
 * @param {GitHubConfig} [config]
 */
export function githubClientLayer(config) {
  return Layer.succeed(GitHubClient, makeGitHubClient(config));
}
