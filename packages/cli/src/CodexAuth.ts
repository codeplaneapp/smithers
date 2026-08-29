/**
 * ChatGPT-subscription credentials for the OpenAI provider, read from the
 * codex CLI's auth store — `$CODEX_HOME/auth.json`, `~/.codex/auth.json` by
 * default. `flows` shares the store rather than owning one: `codex login`
 * provisions it, either client may refresh it, and a rewrite here preserves
 * every field codex expects so codex keeps working afterwards.
 *
 * The store implements the model layer's `Auth` contract. `sign` reads the
 * file fresh on every attempt, refreshes proactively when the access token's
 * JWT `exp` is inside the expiry margin, and emits the bearer plus the
 * `chatgpt-account-id` header. `refresh` is the reactive half `Route.stream`
 * runs after a 401. Both funnel into one single-flight section that re-reads
 * the file before spending the refresh token, because codex may have rotated
 * it first and OAuth refresh tokens are not guaranteed reusable.
 *
 * Refresh traffic goes through the composed `RequestExecutor`, never a bare
 * fetch, so the executor's retry ladder and credential redaction apply to the
 * token endpoint exactly as they do to model calls. No token, account id, or
 * endpoint response ever enters an error message, a log, or a journal: errors
 * name the file path and the endpoint, nothing else.
 *
 * Confirmed against the live backend and codex v0.149.1 on 2026-08-25: the
 * refresh endpoint, client id, scope, response shape, and auth.json layout.
 *
 * @since 0.1.0
 */
import type * as Auth from "@smthrs/model/Auth"
import { ModelError } from "@smthrs/model/ModelError"
import type * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Clock, Effect, Semaphore } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The OAuth token endpoint the refresh grant is sent to. This is the auth
 * host, not the backend-api host serving model calls.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const refreshUrl = "https://auth.openai.com/oauth/token"

/**
 * The codex CLI's public OAuth client id. Not a secret: it names the client
 * whose sessions `auth.json` holds, and a refresh must present the same id.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const clientId = "app_EMoamEEZ73f0CkXaXp7hrann"

/** How long before JWT `exp` a token is treated as already stale. */
const EXPIRY_MARGIN_MS = 5 * 60_000

/**
 * Where the auth store lives for a given environment: `$CODEX_HOME/auth.json`,
 * defaulting to `~/.codex/auth.json` exactly as codex does.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const locate = (environment: Readonly<Record<string, string | undefined>>): string => {
  const home = environment["CODEX_HOME"]
  return join(home === undefined || home === "" ? join(homedir(), ".codex") : home, "auth.json")
}

/**
 * One auth store, shared by every seat that resolves against the same file.
 * Sharing is what makes the refresh single-flight process-wide: parallel
 * sealed steps signing concurrently await one refresh rather than racing the
 * token endpoint with the same refresh token.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Store {
  readonly auth: (options: { readonly modelId: string }) => Auth.Auth
}

/**
 * What {@link make} needs: the store file and the executor refresh traffic
 * runs through.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MakeOptions {
  readonly file: string
  readonly executor: RequestExecutor.RequestExecutor
}

interface Tokens {
  readonly access: string
  readonly refresh: string
  readonly accountId: string | undefined
}

interface FileState {
  readonly raw: Readonly<Record<string, unknown>>
  readonly rawTokens: Readonly<Record<string, unknown>>
  readonly tokens: Tokens
}

const authenticationError = (message: string): ModelError => new ModelError({ code: "authentication", message })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

/**
 * The access token's JWT expiry in epoch milliseconds, or undefined for a
 * token whose payload cannot be read. Unreadable expiry means "assume valid":
 * the reactive refresh path recovers from the 401 if the assumption is wrong,
 * while assuming expired would refresh on every request.
 */
const tokenExpiryMillis = (accessToken: string): number | undefined => {
  const payload = accessToken.split(".")[1]
  if (payload === undefined) return undefined
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return isRecord(decoded) && typeof decoded.exp === "number" && Number.isFinite(decoded.exp)
      ? decoded.exp * 1000
      : undefined
  } catch {
    return undefined
  }
}

const isFresh = (accessToken: string, now: number): boolean => {
  const expiry = tokenExpiryMillis(accessToken)
  return expiry === undefined || now < expiry - EXPIRY_MARGIN_MS
}

/** RFC3339 with six fractional digits, the format codex writes. */
const lastRefreshInstant = (now: number): string => new Date(now).toISOString().replace(/Z$/, "000Z")

/**
 * Builds the shared ChatGPT auth store over one `auth.json` file.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: MakeOptions): Store => {
  const { executor, file } = options
  const gate = Semaphore.makeUnsafe(1)

  const read: Effect.Effect<FileState, ModelError> = Effect.suspend(() => {
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      return Effect.fail(authenticationError(
        `No ChatGPT credentials at ${file}; sign in with \`codex login\` or use FLOWS_OPENAI_AUTH=api-key`
      ))
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return Effect.fail(authenticationError(`${file} is not valid JSON; sign in again with \`codex login\``))
    }
    const raw = isRecord(parsed) ? parsed : undefined
    const rawTokens = raw === undefined ? undefined : isRecord(raw.tokens) ? raw.tokens : undefined
    const access = rawTokens === undefined ? undefined : nonEmptyString(rawTokens.access_token)
    const refresh = rawTokens === undefined ? undefined : nonEmptyString(rawTokens.refresh_token)
    if (raw === undefined || rawTokens === undefined || access === undefined || refresh === undefined) {
      return Effect.fail(authenticationError(
        `${file} holds no ChatGPT token set; sign in with \`codex login\` (API-key logins cannot serve this mode)`
      ))
    }
    return Effect.succeed({
      raw,
      rawTokens,
      tokens: { access, refresh, accountId: nonEmptyString(rawTokens.account_id) }
    })
  })

  // The rewrite codex expects: every existing field preserved, the three
  // rotating tokens overwritten (`account_id` is not in the refresh response
  // and survives untouched), `last_refresh` restamped, written atomically at
  // mode 0600 so a crash never leaves a truncated store or a readable temp.
  const write = (
    state: FileState,
    refreshed: { readonly access: string; readonly refresh: string | undefined; readonly id: string | undefined },
    now: number
  ): Effect.Effect<void, ModelError> =>
    Effect.suspend(() => {
      const next = {
        ...state.raw,
        tokens: {
          ...state.rawTokens,
          ...(refreshed.id === undefined ? {} : { id_token: refreshed.id }),
          access_token: refreshed.access,
          refresh_token: refreshed.refresh ?? state.tokens.refresh
        },
        last_refresh: lastRefreshInstant(now)
      }
      const temporary = `${file}.tmp-${process.pid}`
      try {
        writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
        renameSync(temporary, file)
        return Effect.void
      } catch {
        try {
          rmSync(temporary, { force: true })
        } catch {
          // The rename already failed; a leftover temp is the lesser report.
        }
        return Effect.fail(authenticationError(`Refreshed ChatGPT credentials could not be written back to ${file}`))
      }
    })

  const requestRefresh = (state: FileState, modelId: string): Effect.Effect<string, ModelError> =>
    Effect.scoped(Effect.gen(function*() {
      const body = new TextEncoder().encode(JSON.stringify({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: state.tokens.refresh,
        scope: "openid profile email"
      }))
      const request = HttpClientRequest.post(refreshUrl).pipe(
        HttpClientRequest.bodyUint8Array(body, "application/json")
      )
      // Under the model's own capability and ladder: the refresh exists only
      // to serve this seat's calls, and the executor redacts the refresh
      // token from every diagnostic the attempt can produce.
      const response = yield* executor.execute(request, { modelId }).pipe(
        Effect.mapError((error) =>
          error instanceof ModelError
            ? error
            : authenticationError(`The host did not permit the ChatGPT token refresh at ${refreshUrl}`)
        )
      )
      return yield* response.text.pipe(
        Effect.mapError(() =>
          new ModelError({
            code: "transport",
            message: `The ChatGPT token refresh response from ${refreshUrl} could not be read`
          })
        )
      )
    }))

  const adoptRefresh = (state: FileState, text: string): Effect.Effect<Tokens, ModelError> =>
    Effect.gen(function*() {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      const access = isRecord(parsed) ? nonEmptyString(parsed.access_token) : undefined
      if (parsed === undefined || access === undefined) {
        return yield* Effect.fail(
          authenticationError(`The ChatGPT token endpoint at ${refreshUrl} answered without an access token`)
        )
      }
      const refreshed = {
        access,
        refresh: isRecord(parsed) ? nonEmptyString(parsed.refresh_token) : undefined,
        id: isRecord(parsed) ? nonEmptyString(parsed.id_token) : undefined
      }
      const now = yield* Clock.currentTimeMillis
      yield* write(state, refreshed, now)
      return { access, refresh: refreshed.refresh ?? state.tokens.refresh, accountId: state.tokens.accountId }
    })

  // The single-flight section. `stale` is the access token the caller found
  // wanting — near expiry, or answered with a 401. Inside the permit the file
  // is read again: a different, fresh token means codex or a concurrent fiber
  // already refreshed and the refresh token must not be spent twice.
  const refreshStale = (stale: string, modelId: string): Effect.Effect<Tokens, ModelError> =>
    gate.withPermits(1)(Effect.gen(function*() {
      const state = yield* read
      const now = yield* Clock.currentTimeMillis
      if (state.tokens.access !== stale && isFresh(state.tokens.access, now)) return state.tokens
      const answer = yield* requestRefresh(state, modelId)
      return yield* adoptRefresh(state, answer)
    }))

  const auth = (authOptions: { readonly modelId: string }): Auth.Auth => ({
    sign: Effect.fn("Auth.sign")((headers) =>
      Effect.gen(function*() {
        const state = yield* read
        const now = yield* Clock.currentTimeMillis
        const tokens = isFresh(state.tokens.access, now)
          ? state.tokens
          : yield* refreshStale(state.tokens.access, authOptions.modelId)
        return {
          ...headers,
          Authorization: `Bearer ${tokens.access}`,
          ...(tokens.accountId === undefined ? {} : { "chatgpt-account-id": tokens.accountId })
        }
      })
    ),
    refresh: Effect.gen(function*() {
      const state = yield* read
      yield* refreshStale(state.tokens.access, authOptions.modelId)
    })
  })

  return { auth }
}
