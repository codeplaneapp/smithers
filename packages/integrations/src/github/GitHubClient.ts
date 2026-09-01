/**
 * The GitHub REST client.
 *
 * Three behaviors are the reason this exists rather than a bare `fetch`:
 *
 * - **Rate limits.** GitHub signals them as a 429 *and* as a 403 whose
 *   `x-ratelimit-remaining` is `0` or whose body mentions the secondary or
 *   abuse limit. All three are retried, waiting the server's `Retry-After` or
 *   `x-ratelimit-reset`, capped so a skewed clock cannot park a call for hours.
 * - **Pagination.** `paginate` follows RFC 5988 `Link: rel="next"`.
 * - **Token hygiene.** The token reaches the `Authorization` header and
 *   nothing else, not a message, not `details`, not a log line, and every
 *   request URL, including a `rel="next"` target, is pinned to the configured
 *   API origin so a redirected link cannot carry the token elsewhere.
 *
 * Interruption is forwarded to `fetch`, so interrupting the fiber aborts the
 * request in flight rather than leaving it running.
 *
 * @since 1.0.0
 */
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect"
import { IntegrationError, isRetryable } from "../core/IntegrationError.ts"
import * as Environment from "../Environment.ts"
import { type GitHubConfig, resolve } from "./Config.ts"

// Upper bound on an honored Retry-After / x-ratelimit-reset, so a hostile or
// clock-skewed header cannot park a call for hours.
const MAX_RETRY_AFTER_MS = 60_000

/**
 * The REST verbs this client issues.
 *
 * @category models
 * @since 1.0.0
 */
export type RequestMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"

/**
 * Per-request options.
 *
 * @category models
 * @since 1.0.0
 */
export interface RequestOptions<A> {
  /** Decodes the response body. Omit it to receive the parsed JSON. */
  readonly schema?: Schema.Schema<A> | undefined
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>> | undefined
}

/**
 * The client service.
 *
 * @category services
 * @since 1.0.0
 */
export interface GitHubClient {
  readonly request: <A = unknown>(
    method: RequestMethod,
    path: string,
    body?: unknown,
    options?: RequestOptions<A>
  ) => Effect.Effect<A, IntegrationError>
  /** Follows `Link: rel="next"` and concatenates the pages. */
  readonly paginate: (
    path: string,
    options?: { readonly perPage?: number | undefined; readonly maxPages?: number | undefined }
  ) => Effect.Effect<ReadonlyArray<unknown>, IntegrationError>
}

/**
 * Service tag for the GitHub REST client.
 *
 * @category services
 * @since 1.0.0
 */
export const GitHubClient: Context.Service<GitHubClient, GitHubClient> = Context.Service(
  "@smthrs/integrations/GitHubClient"
)

/**
 * Whether a response is GitHub telling us to slow down.
 *
 * A 403 counts when the remaining budget is exhausted or the body names the
 * rate or abuse limit, which is how GitHub reports a secondary limit.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isRateLimitResponse = (status: number, headers: Headers, body: unknown): boolean => {
  if (status === 429) return true
  if (status !== 403) return false
  if (headers.get("x-ratelimit-remaining") === "0") return true
  const message = typeof body === "object" && body !== null && "message" in body &&
      typeof (body as { message?: unknown }).message === "string"
    ? (body as { message: string }).message.toLowerCase()
    : ""
  return message.includes("rate limit") || message.includes("abuse")
}

/**
 * How long to wait before retrying, from `Retry-After` (seconds) or
 * `x-ratelimit-reset` (epoch seconds), capped at one minute.
 *
 * @category getters
 * @since 1.0.0
 */
export const retryAfterMs = (headers: Headers, nowMs: number = Date.now()): number | null => {
  const retryAfter = headers.get("retry-after")
  if (retryAfter !== null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
  }
  const reset = headers.get("x-ratelimit-reset")
  if (reset !== null) {
    const resetMs = Number(reset) * 1000 - nowMs
    if (Number.isFinite(resetMs) && resetMs > 0) return Math.min(resetMs, MAX_RETRY_AFTER_MS)
  }
  return null
}

/**
 * The `rel="next"` URL in an RFC 5988 `Link` header, or `null`.
 *
 * @category getters
 * @since 1.0.0
 */
export const nextPageUrl = (linkHeader: string | null): string | null => {
  if (linkHeader === null || linkHeader.length === 0) return null
  for (const part of linkHeader.split(",")) {
    const match = /^<([^>]+)>;\s*rel="next"$/.exec(part.trim())
    if (match !== null) return match[1] ?? null
  }
  return null
}

/**
 * Builds a REST client bound to `config`.
 *
 * `env` is the fallback source for anything `config` omits. Passing one
 * replaces the ambient environment rather than layering over it, so a caller
 * that supplies its own credentials cannot be surprised by an ambient
 * `GITHUB_TOKEN` deciding which account a call runs as.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  config: GitHubConfig = {},
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): GitHubClient => {
  const resolved = resolve(config, env)
  const baseUrl = resolved.apiBaseUrl.replace(/\/+$/, "")
  const apiOrigin = new URL(baseUrl).origin

  // Every request carries the bearer token, so an absolute request URL and a
  // `rel="next"` target must stay on the configured API origin. A foreign
  // destination would receive the token.
  const assertApiOrigin = (url: string): void => {
    const parsed = new URL(url)
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== apiOrigin) {
      throw new IntegrationError(
        "delivery-failed",
        `GitHub request refused: ${parsed.origin} is not the configured GitHub API origin.`,
        { origin: parsed.origin, apiOrigin, retryable: false }
      )
    }
  }

  const buildUrl = (path: string, query?: RequestOptions<unknown>["query"]): string => {
    const url = new URL(path.startsWith("http") ? path : `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  const attemptOnce = (
    method: RequestMethod,
    url: string,
    body?: unknown
  ): Effect.Effect<{ readonly json: unknown; readonly headers: Headers }, IntegrationError> =>
    Effect.tryPromise({
      try: async (signal) => {
        assertApiOrigin(url)
        const headers: Record<string, string> = {
          accept: "application/vnd.github+json",
          "user-agent": "smithers-integrations",
          "x-github-api-version": "2022-11-28"
        }
        if (resolved.token !== undefined) headers["authorization"] = `Bearer ${resolved.token}`
        if (body !== undefined) headers["content-type"] = "application/json"
        const response = await fetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal
        })
        const text = await response.text()
        let json: unknown = null
        if (text.length > 0) {
          try {
            json = JSON.parse(text)
          } catch {
            json = text
          }
        }
        if (response.ok) return { json, headers: response.headers }
        const rateLimited = isRateLimitResponse(response.status, response.headers, json)
        const retryable = rateLimited || response.status >= 500
        const message = typeof json === "object" && json !== null && "message" in json
          ? String(json.message)
          : response.statusText
        throw new IntegrationError(
          "delivery-failed",
          `GitHub request failed: ${method} ${new URL(url).pathname} -> ${response.status} ${message}`,
          {
            status: response.status,
            method,
            path: new URL(url).pathname,
            retryable,
            rateLimited,
            retryAfterMs: retryable ? retryAfterMs(response.headers) : null,
            ratelimitRemaining: response.headers.get("x-ratelimit-remaining")
          }
        )
      },
      catch: (cause) =>
        cause instanceof IntegrationError ? cause : new IntegrationError(
          "delivery-failed",
          `GitHub request failed: ${method} - ${cause instanceof Error ? cause.message : String(cause)}`,
          { method, retryable: true },
          { cause }
        )
    })

  const requestUrl = (
    method: RequestMethod,
    url: string,
    body?: unknown
  ): Effect.Effect<{ readonly json: unknown; readonly headers: Headers }, IntegrationError> => {
    const schedule = Schedule.exponential("250 millis").pipe(
      Schedule.upTo({ times: resolved.maxRetries }),
      Schedule.while(({ input }) => isRetryable(input)),
      Schedule.passthrough,
      Schedule.addDelay(({ input }) => {
        if (!isRetryable(input)) return Effect.succeed(Duration.zero)
        const details = (input as IntegrationError).details as { readonly retryAfterMs?: number | null } | undefined
        const wait = details?.retryAfterMs
        return Effect.succeed(typeof wait === "number" && wait > 0 ? Duration.millis(wait) : Duration.zero)
      })
    )
    return attemptOnce(method, url, body).pipe(Effect.retry(schedule))
  }

  const request = <A>(
    method: RequestMethod,
    path: string,
    body?: unknown,
    options?: RequestOptions<A>
  ): Effect.Effect<A, IntegrationError> =>
    requestUrl(method, buildUrl(path, options?.query), body).pipe(
      Effect.flatMap(({ json }) => {
        const schema = options?.schema
        if (schema === undefined) return Effect.succeed(json as A)
        return (Schema.decodeUnknownEffect(schema)(json) as Effect.Effect<A, unknown>).pipe(
          Effect.mapError((cause) =>
            new IntegrationError(
              "decode-failed",
              `GitHub response for ${method} ${path} failed schema validation.`,
              { method, path },
              { cause }
            )
          )
        )
      })
    )

  const paginate: GitHubClient["paginate"] = (path, options) =>
    Effect.gen(function*() {
      const perPage = options?.perPage ?? 100
      const maxPages = options?.maxPages ?? 10
      const items: Array<unknown> = []
      let url: string | null = buildUrl(path, { per_page: perPage })
      let pages = 0
      while (url !== null && pages < maxPages) {
        const page: { readonly json: unknown; readonly headers: Headers } = yield* requestUrl("GET", url)
        if (Array.isArray(page.json)) items.push(...page.json)
        else if (page.json !== null) items.push(page.json)
        url = nextPageUrl(page.headers.get("link"))
        pages += 1
      }
      return items
    })

  return GitHubClient.of({ request, paginate })
}

/**
 * Layer for a client bound to `config`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  config: GitHubConfig = {},
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): Layer.Layer<GitHubClient> => Layer.sync(GitHubClient, () => make(config, env))
