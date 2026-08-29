/**
 * Executes provider requests with bounded retries, quota classification, and
 * credential-safe diagnostics.
 *
 * @since 0.1.0
 */
import type * as Permission from "@smthrs/capability/Permission"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Headers from "effect/unstable/http/Headers"
import type * as HttpClientError from "effect/unstable/http/HttpClientError"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as Auth from "./Auth.ts"
import { isContextOverflow, ModelError } from "./ModelError.ts"

const BODY_LIMIT = 16_384
const MAX_RETRIES = 2
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 10_000
const MAX_RETRY_DURATION_MS = 60_000
const REDACTED = "<redacted>"

// One source of truth for sensitive names across headers, URL query keys, and
// fields embedded in request or response bodies.
const SENSITIVE_NAME = Auth.credentialNamePattern
const SHORT_QUERY_NAME = /^(key|sig)$/i
const SENSITIVE_BODY_FIELD = new RegExp(`(?:${SENSITIVE_NAME.source}|key)`, "i")
const REDACT_JSON_FIELD = new RegExp(`("(?:${SENSITIVE_BODY_FIELD.source})"\\s*:\\s*)"[^"]*"`, "gi")
const REDACT_QUERY_FIELD = new RegExp(`((?:${SENSITIVE_BODY_FIELD.source})=)[^&\\s"]+`, "gi")

interface ResetMetadata {
  readonly retryAfterMillis?: number | undefined
  readonly resetAtEpochMillis?: number | undefined
  readonly resetSource?: string | undefined
}

interface ResetCandidate {
  readonly at: number
  readonly source: string
  readonly relevance: "retry" | "exhausted" | "unqualified"
}

const matchesName = (name: string, matcher: string | RegExp): boolean => {
  if (typeof matcher === "string") return name.toLowerCase() === matcher.toLowerCase()
  matcher.lastIndex = 0
  return matcher.test(name)
}

const isSensitiveHeaderName = (
  name: string,
  redactedNames: ReadonlyArray<string | RegExp> = []
): boolean => SENSITIVE_NAME.test(name) || redactedNames.some((matcher) => matchesName(name, matcher))

const isSensitiveQueryName = (name: string): boolean => isSensitiveHeaderName(name) || SHORT_QUERY_NAME.test(name)

const redactHeaders = (
  headers: Headers.Headers,
  redactedNames: ReadonlyArray<string | RegExp>
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(Headers.redact(headers, [...redactedNames, SENSITIVE_NAME])).map(([name, value]) => [
      name,
      String(value)
    ])
  )

const redactUrl = (value: string): string => {
  if (!URL.canParse(value)) return REDACTED
  const url = new URL(value)
  url.searchParams.forEach((_, key) => {
    if (isSensitiveQueryName(key)) url.searchParams.set(key, REDACTED)
  })
  return url.toString()
}

const redactedRequestUrl = (request: HttpClientRequest.HttpClientRequest): string => {
  const value = redactUrl(request.url)
  if (value === REDACTED) return value
  const url = new URL(value)
  for (const [key, item] of request.urlParams) {
    url.searchParams.append(key, isSensitiveQueryName(key) ? REDACTED : item)
  }
  return url.toString()
}

const normalizedHeaders = (headers: Headers.Headers): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))

const requestId = (headers: Record<string, string>): string | undefined =>
  headers["x-request-id"] ??
    headers["request-id"] ??
    headers["x-amzn-requestid"] ??
    headers["x-amz-request-id"] ??
    headers["x-goog-request-id"] ??
    headers["cf-ray"]

const retryableStatus = (status: number): boolean =>
  status === 429 || status === 503 || status === 504 || status === 529

const finiteNonNegative = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined
}

const retryAfter = (headers: Record<string, string>, now: number): ResetMetadata => {
  const millis = finiteNonNegative(headers["retry-after-ms"])
  if (millis !== undefined) {
    return {
      retryAfterMillis: millis,
      resetAtEpochMillis: now + millis,
      resetSource: "retry-after-ms"
    }
  }

  const value = headers["retry-after"]
  if (!value) return {}

  const seconds = finiteNonNegative(value)
  if (seconds !== undefined) {
    const retryAfterMillis = seconds * 1_000
    return {
      retryAfterMillis,
      resetAtEpochMillis: now + retryAfterMillis,
      resetSource: "retry-after"
    }
  }

  const date = Date.parse(value)
  if (Number.isNaN(date)) return {}
  return {
    retryAfterMillis: Math.max(0, date - now),
    resetAtEpochMillis: date,
    resetSource: "retry-after"
  }
}

const durationMillis = (value: string): number | undefined => {
  const input = value.trim().toLowerCase()
  if (input === "") return undefined
  const token = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g
  const factors: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000
  }
  let total = 0
  let consumed = 0
  let match: RegExpExecArray | null
  while ((match = token.exec(input)) !== null) {
    if (match.index !== consumed) return undefined
    const amount = match[1]
    const unit = match[2]
    if (amount === undefined || unit === undefined) return undefined
    const factor = factors[unit]
    if (factor === undefined) return undefined
    total += Number(amount) * factor
    consumed = token.lastIndex
  }
  return consumed === input.length && Number.isFinite(total) ? Math.max(0, total) : undefined
}

const timestampOrDuration = (value: unknown, now: number): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 1_000_000_000_000) return value
    if (value >= 1_000_000_000) return value * 1_000
    return now + Math.max(0, value) * 1_000
  }
  if (typeof value !== "string") return undefined

  const duration = durationMillis(value)
  if (duration !== undefined) return now + duration

  const numeric = Number(value)
  if (Number.isFinite(numeric)) return timestampOrDuration(numeric, now)

  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : date
}

const chooseReset = (candidates: ReadonlyArray<ResetCandidate>): ResetCandidate | undefined => {
  const retry = candidates.filter((candidate) => candidate.relevance === "retry")
  const exhausted = candidates.filter((candidate) => candidate.relevance === "exhausted")
  const unqualified = candidates.filter((candidate) => candidate.relevance === "unqualified")
  const eligible = retry.length > 0
    ? retry
    : exhausted.length > 0
    ? exhausted
    : unqualified.length === 1
    ? unqualified
    : []
  let selected: ResetCandidate | undefined
  for (const candidate of eligible) {
    if (!Number.isFinite(candidate.at)) continue
    if (selected === undefined || candidate.at < selected.at) selected = candidate
  }
  return selected
}

const headerResetCandidates = (
  headers: Record<string, string>,
  now: number
): ReadonlyArray<ResetCandidate> => {
  const remaining = new Map<string, number>()
  for (const [name, value] of Object.entries(headers)) {
    const openAi = /^x-ratelimit-remaining-(.+)$/.exec(name)?.[1]
    const anthropic = /^anthropic-ratelimit-(.+)-remaining$/.exec(name)?.[1]
    const resource = openAi ?? anthropic
    const parsed = finiteNonNegative(value)
    if (resource !== undefined && parsed !== undefined) remaining.set(resource, parsed)
  }

  const candidates: Array<ResetCandidate> = []
  for (const [name, value] of Object.entries(headers)) {
    const openAi = /^x-ratelimit-reset-(.+)$/.exec(name)?.[1]
    const anthropic = /^anthropic-ratelimit-(.+)-reset$/.exec(name)?.[1]
    const resource = openAi ?? anthropic
    if (resource === undefined) continue
    const remainingValue = remaining.get(resource)
    if (remainingValue !== undefined && remainingValue > 0) continue
    const at = timestampOrDuration(value, now)
    if (at !== undefined) {
      candidates.push({
        at,
        source: name,
        relevance: remainingValue === undefined ? "unqualified" : "exhausted"
      })
    }
  }
  return candidates
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String))

const parsedBody = (body: string | undefined): unknown =>
  body === undefined || body.trim() === ""
    ? undefined
    : Option.getOrUndefined(decodeJson(body))

const bodyResetCandidates = (
  value: unknown,
  now: number,
  path = "body"
): ReadonlyArray<ResetCandidate> => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => bodyResetCandidates(item, now, `${path}[${index}]`))
  }
  if (!isRecord(value)) return []

  const candidates: Array<ResetCandidate> = []
  const remainingFields = Object.entries(value).filter(([key, item]) =>
    /(?:^|[-_])remaining$/i.test(key) && finiteNonNegative(String(item)) !== undefined
  )
  const hasRemaining = remainingFields.length > 0
  const isExhausted = remainingFields.some(([, item]) => finiteNonNegative(String(item)) === 0)
  for (const [key, item] of Object.entries(value)) {
    const nextPath = `${path}.${key}`
    if (
      /^(?:reset|resets?[-_]?at|reset[-_]?time|quota[-_]?reset(?:[-_]?at)?|rate[-_]?limit[-_]?reset(?:[-_]?at)?)$/i
        .test(key)
    ) {
      const at = timestampOrDuration(item, now)
      if (at !== undefined && (!hasRemaining || isExhausted)) {
        candidates.push({
          at,
          source: nextPath,
          relevance: hasRemaining ? "exhausted" : "unqualified"
        })
      }
    } else if (/^(?:reset|retry)[-_]?after(?:[-_]?ms)?$/i.test(key)) {
      const millis = typeof item === "number" ? item : Number(item)
      if (Number.isFinite(millis)) {
        const multiplier = /ms$/i.test(key) ? 1 : 1_000
        candidates.push({
          at: now + Math.max(0, millis) * multiplier,
          source: nextPath,
          relevance: "retry"
        })
      }
    }
    candidates.push(...bodyResetCandidates(item, now, nextPath))
  }
  return candidates
}

const stringField = (value: unknown, names: ReadonlyArray<string>): string | undefined => {
  if (!isRecord(value)) return undefined
  for (const name of names) {
    const field = value[name]
    if (typeof field === "string") return field
  }
  return undefined
}

const providerFields = (body: unknown): {
  readonly code?: string | undefined
  readonly message?: string | undefined
} => {
  if (!isRecord(body)) return {}
  const nested = isRecord(body.error) ? body.error : undefined
  return {
    code: stringField(nested, ["code", "type"]) ?? stringField(body, ["code", "type"]),
    message: stringField(nested, ["message", "detail"]) ?? stringField(body, ["message", "detail"])
  }
}

const quotaBody = (parsed: unknown): boolean => {
  const fields = providerFields(parsed)
  return fields.code !== undefined &&
    /^(?:insufficient[-_]?quota|quota[-_]?exceeded|billing[-_]?hard[-_]?limit(?:[-_]?reached)?|credit[-_]?balance[-_]?too[-_]?low)$/i
      .test(fields.code)
}

const addSecret = (values: Set<string>, value: string): void => {
  if (value.length === 0) return
  values.add(value)
  values.add(encodeURIComponent(value))
  const json = encodeJsonString(value)
  if (json.length >= 2) values.add(json.slice(1, -1))
}

const addStructuredSecrets = (values: Set<string>, value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) addStructuredSecrets(values, item)
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (
      SENSITIVE_BODY_FIELD.test(key) &&
      (typeof item === "string" || typeof item === "number" || typeof item === "boolean")
    ) {
      addSecret(values, String(item))
    }
    addStructuredSecrets(values, item)
  }
}

const addTextBodySecrets = (values: Set<string>, text: string): void => {
  const decoded = decodeJson(text)
  if (Option.isSome(decoded)) addStructuredSecrets(values, decoded.value)
  try {
    const params = new URLSearchParams(text)
    params.forEach((value, key) => {
      if (isSensitiveQueryName(key)) addSecret(values, value)
    })
  } catch {
    // An opaque body has no structured credentials we can safely identify.
  }
}

const secretValues = (
  request: HttpClientRequest.HttpClientRequest,
  redactedNames: ReadonlyArray<string | RegExp>
): Set<string> => {
  const values = new Set<string>()
  const safeHeaders = redactHeaders(request.headers, redactedNames)

  for (const [name, value] of Object.entries(request.headers)) {
    if (!isSensitiveHeaderName(name, redactedNames) && safeHeaders[name] === value) continue
    addSecret(values, value)
    const bearer = /^Bearer\s+(.+)$/i.exec(value)?.[1]
    if (bearer) addSecret(values, bearer)
  }

  if (URL.canParse(request.url)) {
    new URL(request.url).searchParams.forEach((value, key) => {
      if (isSensitiveQueryName(key)) addSecret(values, value)
    })
  }
  for (const [key, value] of request.urlParams) {
    if (isSensitiveQueryName(key)) addSecret(values, value)
  }

  if (request.body._tag === "Uint8Array") {
    addTextBodySecrets(values, new TextDecoder().decode(request.body.body))
  } else if (request.body._tag === "Raw") {
    if (typeof request.body.body === "string") {
      addTextBodySecrets(values, request.body.body)
    } else if (request.body.body instanceof globalThis.Uint8Array) {
      addTextBodySecrets(values, new TextDecoder().decode(request.body.body))
    } else {
      addStructuredSecrets(values, request.body.body)
    }
  } else if (request.body._tag === "FormData") {
    request.body.formData.forEach((value, key) => {
      if (isSensitiveQueryName(key) && typeof value === "string") addSecret(values, value)
    })
  }

  return values
}

// Structural and literal passes ensure provider echoes are scrubbed before a
// body is truncated or incorporated into a serializable ModelError.
const redactBody = (
  body: string,
  request: HttpClientRequest.HttpClientRequest,
  redactedNames: ReadonlyArray<string | RegExp>
): string =>
  Array.from(secretValues(request, redactedNames))
    .sort((left, right) => right.length - left.length)
    .reduce(
      (text, secret) => text.split(secret).join(REDACTED),
      body.replace(REDACT_JSON_FIELD, `$1"${REDACTED}"`).replace(REDACT_QUERY_FIELD, `$1${REDACTED}`)
    )

const responseBody = (
  body: string | undefined,
  request: HttpClientRequest.HttpClientRequest,
  redactedNames: ReadonlyArray<string | RegExp>
): { readonly body?: string | undefined; readonly bodyTruncated?: boolean | undefined } => {
  if (body === undefined) return {}
  const redacted = redactBody(body, request, redactedNames)
  if (redacted.length <= BODY_LIMIT) return { body: redacted }
  return { body: redacted.slice(0, BODY_LIMIT), bodyTruncated: true }
}

const providerMessage = (
  status: number,
  details: { readonly body?: string | undefined; readonly bodyTruncated?: boolean | undefined }
): string => {
  if (details.body && details.body.length <= 500 && details.bodyTruncated !== true) {
    return `Provider request failed with HTTP ${status}: ${details.body}`
  }
  return `Provider request failed with HTTP ${status}`
}

const reasonForStatus = (status: number, body: string | undefined, parsed: unknown): ModelError["code"] => {
  if (/content[-_\s]?policy|content_filter|safety/i.test(body ?? "")) return "content_policy"
  if (status === 401 || status === 403) return "authentication"
  if (quotaBody(parsed)) return "quota_exceeded"
  if (status === 429) return "rate_limited"
  // Overflow is reported as a bad request by every provider this executor
  // fronts, so it has to be recognized before the bad-request branch claims it.
  if (isContextOverflow(undefined, body ?? "")) return "context_overflow"
  if (status === 400 || status === 404 || status === 409 || status === 413 || status === 422) {
    return "invalid_request"
  }
  if (status >= 500 || retryableStatus(status)) return "provider_internal"
  return "unknown"
}

const sanitizedField = (
  value: string | undefined,
  request: HttpClientRequest.HttpClientRequest,
  redactedNames: ReadonlyArray<string | RegExp>
): string | undefined => value === undefined ? undefined : redactBody(value, request, redactedNames)

const statusError = (
  request: HttpClientRequest.HttpClientRequest,
  redactedNames: ReadonlyArray<string | RegExp>,
  classifyError: ErrorClassifier | undefined
) =>
(
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<HttpClientResponse.HttpClientResponse, ModelError> =>
  Effect.gen(function*() {
    if (response.status < 400) return response

    const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed(undefined)))
    const headers = normalizedHeaders(response.headers)
    const now = yield* Clock.currentTimeMillis
    const retry = retryAfter(headers, now)
    const parsed = parsedBody(body)

    // docs/specs/Concepts/Run Ownership.md §4 needs one durable wake instant.
    // Retry-After is authoritative; otherwise only the exhausted resource's
    // window is eligible, preventing unrelated early wake/spin loops.
    const candidates: Array<ResetCandidate> = [
      ...headerResetCandidates(headers, now),
      ...bodyResetCandidates(parsed, now)
    ]
    const reset = retry.resetAtEpochMillis !== undefined && retry.resetSource !== undefined
      ? {
        at: retry.resetAtEpochMillis,
        source: retry.resetSource,
        relevance: "retry" as const
      }
      : chooseReset(candidates)
    const details = responseBody(body, request, redactedNames)
    const fields = providerFields(parsed)
    const classified = classifyError?.(response.status, body ?? "")
    const classifiedMessage = classified === undefined
      ? undefined
      : responseBody(classified.message, request, redactedNames).body

    return yield* Effect.fail(
      new ModelError({
        code: classified?.code ?? reasonForStatus(response.status, body, parsed),
        message: classifiedMessage ?? providerMessage(response.status, details),
        retryAfterMillis: classified?.retryAfterMillis ?? retry.retryAfterMillis,
        resetAtEpochMillis: classified?.resetAtEpochMillis ?? reset?.at,
        resetSource: sanitizedField(classified?.resetSource ?? reset?.source, request, redactedNames),
        providerCode: sanitizedField(classified?.providerCode ?? fields.code, request, redactedNames),
        requestId: sanitizedField(classified?.requestId ?? requestId(headers), request, redactedNames),
        httpStatus: response.status
      })
    )
  })

const transportError = (
  error: HttpClientError.HttpClientError,
  redactedNames: ReadonlyArray<string | RegExp>
): ModelError => {
  const safeHeaders = redactHeaders(error.request.headers, redactedNames)
  const hasHeaders = Object.keys(safeHeaders).length > 0
  const reason = error.reason
  const cause = "cause" in reason ? reason.cause : undefined
  const causeName = cause instanceof Error && cause.name !== "Error" ? cause.name : undefined
  const causeMessage = cause instanceof Error
    ? cause.message
    : typeof cause === "string" || typeof cause === "number" || typeof cause === "boolean"
    ? String(cause)
    : undefined
  const causeCode = isRecord(cause) && (typeof cause.code === "string" || typeof cause.code === "number")
    ? String(cause.code)
    : undefined
  const causeDetail = causeMessage === undefined || causeMessage.trim() === ""
    ? undefined
    : `${causeName === undefined ? "" : `${causeName} `}${
      causeCode === undefined ? "" : `[${causeCode}] `
    }${causeMessage}`.trim()
  const description = "description" in reason ? reason.description : undefined
  const details = [...new Set([description, causeDetail].filter((value): value is string => value !== undefined))]
    .map((value) => redactBody(value, error.request, redactedNames))
    .join(": ")
  return new ModelError({
    code: "transport",
    message: `HTTP transport failed: ${error.reason._tag}${
      details === "" ? "" : `: ${details}`
    } (${error.request.method} ${redactedRequestUrl(error.request)}${hasHeaders ? ", headers redacted" : ""})`
  })
}

const mapHttpError = (
  error: HttpClientError.HttpClientError,
  redactedNames: ReadonlyArray<string | RegExp>
): RequestError => {
  // The kernel projects permission failures into the error channel Effect's
  // `HttpClient` tag fixes, keeping the structured failure on the cause; this
  // recovers it so suspension metadata survives the model boundary.
  const permission = KernelHttpClient.fromHttpClientError(error)
  return Option.isSome(permission) ? permission.value : transportError(error, redactedNames)
}

const retryFailures = <A, R>(
  effect: Effect.Effect<A, RequestError, R>
): Effect.Effect<A, RequestError, R> => {
  const schedule = Schedule.exponential(Duration.millis(BASE_DELAY_MS)).pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.millis(Math.min(Duration.toMillis(duration), MAX_DELAY_MS)))
    ),
    Schedule.jittered,
    Schedule.modifyDelay(({ duration, input }) =>
      Effect.succeed(
        Duration.millis(
          input instanceof ModelError && input.retryAfterMillis !== undefined
            ? input.retryAfterMillis
            : Duration.toMillis(duration)
        )
      )
    ),
    Schedule.upTo({ times: MAX_RETRIES, duration: Duration.millis(MAX_RETRY_DURATION_MS) })
  )
  return Effect.retry(effect, {
    schedule,
    while: (error): boolean => error instanceof ModelError && error.retryable
  })
}

/**
 * Protocol-specific classification for a failed HTTP response.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ErrorClassifier = (status: number, body: string) => ModelError

/**
 * Per-request execution policy supplied by the composed route.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ExecuteOptions {
  readonly modelId: string
  readonly classifyError?: ErrorClassifier | undefined
}

/**
 * Failures from provider execution. Kernel permission failures retain their
 * original classes and suspension metadata across the model boundary.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export type RequestError =
  | ModelError
  | Permission.PermissionRequired
  | Permission.PermissionDenied
  | Permission.GrantStoreError

/**
 * How many consecutive transport failures replace the client.
 *
 * A retry ladder assumes waiting repairs the failure, and for a rate limit or a
 * 5xx it does. For a *transport* failure it sometimes does not: an HTTP/2
 * session the peer has destroyed stays destroyed, and every attempt that reuses
 * the connection pool holding it fails the same way however long the ladder
 * waits between them. r92 of the SWE-bench full benchmark is the measurement —
 * ten `transport` retries across two instances, roughly half a minute of
 * jittered backoff each, and both runs died anyway against a socket that never
 * came back.
 *
 * Three is where waiting has stopped being the explanation. It is exactly what
 * one `execute` spends when every attempt fails on the transport — the first
 * attempt plus `MAX_RETRIES` — so no attempt inside a request ever runs on a
 * client the request itself discarded, and the replacement lands on the first
 * rung of the *outer* ladder, the sealed model step's, which is where a socket
 * that is genuinely dead first shows itself. A single request cannot both
 * throw away a connection pool and go on using the replacement, and a request
 * that fails on anything other than the transport leaves the pool alone.
 *
 * The counter is about the transport, which every request in the process
 * shares, so it is shared too. Any success resets it: a client that answers is
 * a client that works.
 *
 * @category constants
 * @since 0.1.0
 */
export const rebuildAfter = 3

/**
 * The client an executor runs on, and the host's way of replacing it.
 *
 * Two fields rather than a factory called twice, because the first client is
 * usually a resource somebody else already built — the layer's own — and only
 * the replacement has to be made on demand. A host with nothing to rebuild says
 * so with {@link fixed}, and its executor behaves exactly as it did before this
 * existed.
 *
 * What a rebuild *means* is the host's business and deliberately not this
 * module's: on Node it is a fresh Undici `Agent`, which is a fresh connection
 * pool; in a browser there is no pool to replace and `fixed` is the honest
 * answer.
 *
 * @category models
 * @since 0.1.0
 */
export interface Transport {
  /** The client every request goes through until a rebuild replaces it. */
  readonly client: KernelHttpClient.HttpClient
  /**
   * Builds a replacement, called after {@link rebuildAfter} consecutive
   * transport failures and before the attempt that follows them.
   */
  readonly rebuild: Effect.Effect<KernelHttpClient.HttpClient>
}

/**
 * A transport with nothing behind it to replace: every rebuild answers the same
 * client.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fixed = (client: KernelHttpClient.HttpClient): Transport => ({
  client,
  rebuild: Effect.succeed(client)
})

/**
 * Scoped provider request executor.
 *
 * The caller's scope owns the successful response body and aborts its transport
 * when that scope closes.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface RequestExecutor {
  readonly execute: (
    request: HttpClientRequest.HttpClientRequest,
    options: ExecuteOptions
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, RequestError, Scope.Scope>
}

/**
 * Service tag for the provider request executor.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export const RequestExecutor: Context.Service<RequestExecutor, RequestExecutor> = Context.Service<
  RequestExecutor,
  RequestExecutor
>("/model/RequestExecutor")

/**
 * Builds a request executor over a transport it may replace.
 *
 * The replacement is the rung the retry ladder did not have. Everything above
 * it — this module's own bounded retry, and the sealed model step's jittered
 * ladder in `@smthrs/agent` — repairs a failure by waiting, and a destroyed
 * session is the failure waiting does not repair. After
 * {@link rebuildAfter} consecutive transport failures the next attempt is made
 * on a client the host built fresh, and the counter starts again.
 *
 * The counter lives in this closure rather than in a request, because what it
 * counts is a property of the client and not of any one call: the run that
 * motivated it made ten attempts across two ladders and one dead socket.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeWith = (transport: Transport): Effect.Effect<RequestExecutor> =>
  Effect.sync(() => {
    let http = transport.client
    /** Transport failures since the last response of any kind. */
    let failures = 0

    const executeOnce = (
      request: HttpClientRequest.HttpClientRequest,
      options: ExecuteOptions
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, RequestError, Scope.Scope> =>
      Effect.gen(function*() {
        if (failures >= rebuildAfter) {
          http = yield* transport.rebuild
          failures = 0
        }
        const redactedNames = yield* Headers.CurrentRedactedNames
        const response = yield* http.execute(request).pipe(
          // `model:call` on this model, not a plain `net:*` effect: the same host
          // answers many models and a grant for one is not a grant for the rest.
          KernelHttpClient.withModelCall(options.modelId),
          Effect.mapError((error) => mapHttpError(error, redactedNames))
        )
        return yield* statusError(request, redactedNames, options.classifyError)(response)
      }).pipe(
        // A response of any kind clears the count. Only the transport failing
        // says the client itself may be the problem; a 429 or a 500 arrived
        // over a connection that worked.
        Effect.tap(() =>
          Effect.sync(() => {
            failures = 0
          })
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            failures = error instanceof ModelError && error.code === "transport" ? failures + 1 : 0
          })
        )
      )

    return RequestExecutor.of({
      execute: Effect.fn("RequestExecutor.execute")((request, options) => retryFailures(executeOnce(request, options)))
    })
  })

/**
 * Builds a request executor around the permission-aware kernel HTTP client.
 *
 * The client in context is the only one there is, so a rebuild answers with it
 * unchanged. A host that can build a second one — a Node process, whose
 * connection pool is a value it owns — passes {@link makeWith} a transport that
 * says so.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make: Effect.Effect<RequestExecutor, never, KernelHttpClient.HttpClient> = Effect.gen(function*() {
  const http = yield* KernelHttpClient.HttpClient
  return yield* makeWith(fixed(http))
})

/**
 * Provides the request executor, requiring the kernel HTTP client.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<RequestExecutor, never, KernelHttpClient.HttpClient> = Layer.effect(
  RequestExecutor,
  make
)
