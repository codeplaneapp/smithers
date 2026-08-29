import {
  ADMIN_ALLOWLIST_PATH,
  ADMIN_ERRORS_PATH,
  ADMIN_GRANT_PATH,
  ADMIN_HEALTH_PATH,
  ADMIN_REQUESTS_PATH,
  ADMIN_ROUTE_PREFIX,
  APPROVAL_DECISION_PATH,
  AUTH_CALLBACK_PATH,
  AUTH_ROUTE_PREFIX,
  AUTH_SESSION_PATH,
  AUTH_SIGN_IN_PATH,
  BILLING_ROUTE_PREFIX,
  CANCEL_PATH,
  IDENTITY_ROUTE_PREFIX,
  MODEL_STREAM_PATH,
  TOOLS_BROWSER_FETCH_PATH,
  TURN_PATH,
  WORKFLOW_EVENTS_PATH,
  WORKFLOW_PROVISION_PATH,
  WORKFLOW_RPC_PATH,
  WORKFLOW_STREAM_PATH
} from "smithers-shared/AgentApiRoutes"
import { AgentRuntimeContextSchema, composeAgentInstructions } from "smithers-shared/AgentContext"
import { browserFetch, browserFetchResponseBody, resolveHostOverHttps } from "smithers-shared/BrowserFetch"
import type { StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import { appendClientError, ClientErrorLog, readClientErrors } from "./clientErrorLog"
import type { ClientErrorNamespace } from "./clientErrorLog"
import {
  ALLOWED_GATEWAY_METHODS,
  callGateway,
  DEFAULT_CLOUD_API_BASE_URL,
  ensureGateway,
  fetchCloudToken,
  GatewaySessionRegistry,
  isRelayRepoName,
  NON_REPLAYABLE_GATEWAY_METHODS,
  upstreamTimeoutMs
} from "./gateway"
import type { GatewaySessionNamespace } from "./gateway"
import { spendTurn, turnLimitResponse, TurnRateLimiter } from "./turnLimit"
import type { TurnLimitNamespace } from "./turnLimit"

declare const __SMITHERS_START__: boolean | undefined

/* The per-user gateway session registry (Wave 11) — wrangler binds this DO. */
export { GatewaySessionRegistry }
/* The per-login turn ceiling and the client-error log — wrangler binds both. */
export { ClientErrorLog, TurnRateLimiter }

/*
 * The deployable Smithers MVP server: a Cloudflare Worker that serves the built
 * SPA (assets binding, run_worker_first for the API routes) and implements the
 * same-origin `/api/agent` boundary the pure-web client talks to, plus the
 * trusted-proxy seam for the future engine gateway. Upstream credentials and
 * origin stay server-side; the browser only ever sees its own origin.
 */

const DEFAULT_CHAT_URL = "https://chat.smithers.sh/chat"
const DEFAULT_APP_ORIGIN = "https://smithers.sh"

/**
 * Cap for a single turn request body. Every turn replays the whole transcript,
 * so this is a conversation-length ceiling, not a per-message one. At 64 KB
 * seven long answers wedged the seam permanently on canary and `/clear` could
 * not recover it, because `/clear` runs a model turn of its own and hit the
 * same refusal (repro apps/ui/canary-repros/chat/4.13). The Vite dev boundary
 * (`src/server/AgentApi.ts`) allows 1 MB, so the two boundaries now agree and a
 * conversation that passes in dev passes here.
 */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * Every upstream this Worker calls is bounded. Without a deadline a sibling
 * that accepts the connection and never answers hangs the browser request for
 * as long as the tab is open: `POST /api/workflow/provision` stood past 70s on
 * canary with no answer, no timeout and no error (repro
 * apps/ui/canary-repros/honesty/22.6), which is a spinner that never ends —
 * the silent-failure family in its worst shape. The deadline bounds the wait
 * for the upstream's HEADERS; a response that has begun streaming is not cut
 * off by it.
 */
const UPSTREAM_TIMEOUT_MS = 20_000

/** A deadline expiring, distinguishable from the client hanging up. */
class UpstreamTimeoutError extends Error {
  constructor(readonly seam: string) {
    super(`${seam} did not answer within ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)}s.`)
  }
}

/**
 * Run one upstream call under a deadline. The timer is disarmed as soon as the
 * headers land, so a streaming body (billing, identity, the gateway)
 * keeps flowing for as long as it needs.
 */
const withDeadline = async (
  seam: string,
  run: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new UpstreamTimeoutError(seam)), timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The prose inside an upstream error body, or undefined when the body was
 * written for a machine. This is the rule the seam keeps: a Cloudflare HTML
 * page, a Go router's `404 page not found`, and a provider's error envelope
 * are never handed to a reader. Only a `message`/`error` string — a field an
 * upstream fills with a sentence — survives.
 */
const upstreamProse = (body: string): string | undefined => {
  const text = body.trim()
  if (text === "" || text.startsWith("<")) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const record = parsed as { message?: unknown; error?: unknown }
  const nested = typeof record.error === "object" && record.error !== null
    ? (record.error as { message?: unknown }).message
    : record.error
  const prose = [record.message, nested].find(
    (value): value is string => typeof value === "string" && value.trim() !== ""
  )
  return prose === undefined ? undefined : prose.trim().slice(0, 200)
}

/**
 * One sentence a reader can act on for an upstream that refused. The status is
 * classified here rather than trusting every upstream to write user-facing
 * prose: a provider's raw rate-limit JSON was pasted straight into the
 * transcript on canary (repro apps/ui/canary-repros/honesty/24.3), and a
 * Worker 500 arrived as a Cloudflare HTML page.
 */
const upstreamFailureMessage = (status: number, body: string, retryAfter: string | null): string => {
  if (status === 429) {
    const seconds = Number(retryAfter ?? "")
    const when = Number.isFinite(seconds) && seconds > 0
      ? `Try again in about ${seconds < 90 ? `${Math.ceil(seconds)} seconds` : `${Math.ceil(seconds / 60)} minutes`}.`
      : "Try again in a minute."
    return `The model service is rate-limiting this deployment right now, so the turn did not run. Nothing was charged. ${when}`
  }
  if (status === 401 || status === 403) {
    return "The model service refused this deployment's credentials, so the turn did not run. Nothing was charged, and this is a deployment configuration problem rather than anything to fix from here."
  }
  if (status === 413) {
    return "This conversation has grown too long for the model service to accept. Start a new conversation to keep going — nothing was charged."
  }
  const prose = upstreamProse(body)
  if (status >= 500) {
    return `The model service is having trouble right now (HTTP ${status}), so the turn did not run. Nothing was charged.${
      prose === undefined ? "" : ` It said: ${prose}`
    }`
  }
  return prose === undefined
    ? `The model service refused this turn (HTTP ${status}).`
    : `The model service refused this turn: ${prose}`
}

/** The OPFS SQLite persistence in the SPA needs cross-origin isolation. */
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp"
} as const

/**
 * Identity headers a client must never be trusted for: the proxy strips them off
 * every gateway-bound request and re-injects them only from a validated session
 * (trusted-proxy pattern, docs/guides/custom-workflow-ui.mdx).
 */
const STRIPPED_IDENTITY_HEADERS = [
  "x-user-id",
  "x-user-scopes",
  "x-user-role",
  "x-user-login",
  "x-smithers-token-id",
  "x-smithers-service-token",
  "authorization"
] as const

const GATEWAY_ROUTE_PREFIXES = ["/v1/rpc/", "/v1/api/", "/workflows/"] as const

/*
 * Server-side turn cancellation, the workerd-legal way. workerd forbids
 * touching another request's I/O (the old route aborted the turn handler's
 * AbortController cross-request and 500'd), so cancellation state lives in a
 * Durable Object keyed by runId — the one shared, transactional store two
 * requests may both reach. The cancel route only flips that state; the turn
 * handler polls it between NDJSON chunks (each poll is the turn request's own
 * I/O) and aborts ITS OWN upstream fetch when it sees "cancelled".
 *
 * The structurally-typed binding keeps this Worker free of a workers-types
 * dependency, matching the ASSETS binding above.
 */
export interface TurnCancelStorage {
  readonly get: <T>(key: string) => Promise<T | undefined>
  readonly put: (key: string, value: unknown) => Promise<void>
}

export interface TurnCancelStub {
  readonly fetch: (request: Request) => Promise<Response>
}

export interface TurnCancelNamespace {
  readonly idFromName: (name: string) => unknown
  readonly get: (id: unknown) => TurnCancelStub
}

type TurnCancelStateName = "active" | "cancelled" | "settled"

interface TurnCancelState {
  readonly state: TurnCancelStateName
  readonly at: number
}

const TURN_STATE_KEY = "state"
/**
 * A turn that never settled (its request died before the stream ended) must
 * not hold its runId hostage forever: an "active" registration older than
 * this is treated as settled. Turns are seconds long; ten minutes is far
 * beyond any honest stream.
 */
const STALE_ACTIVE_MS = 10 * 60 * 1000

export class TurnCancelRegistry {
  constructor(private readonly ctx: { readonly storage: TurnCancelStorage }) {}

  private async read(): Promise<TurnCancelState | undefined> {
    return this.ctx.storage.get<TurnCancelState>(TURN_STATE_KEY)
  }

  private async write(state: TurnCancelStateName): Promise<void> {
    await this.ctx.storage.put(TURN_STATE_KEY, { state, at: Date.now() })
  }

  async fetch(request: Request): Promise<Response> {
    const answer = (body: unknown): Response =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    const current = await this.read()
    const stale = current?.state === "active" && Date.now() - current.at > STALE_ACTIVE_MS
    switch (new URL(request.url).pathname) {
      case "/register": {
        if (current?.state === "active" && !stale) return answer({ status: "already-running" })
        await this.write("active")
        return answer({ status: "started" })
      }
      case "/cancel": {
        if (current?.state !== "active" || stale) return answer({ status: "not-found" })
        await this.write("cancelled")
        return answer({ status: "cancelled" })
      }
      case "/settle": {
        await this.write("settled")
        return answer({ status: "settled" })
      }
      case "/state": {
        const effective: TurnCancelStateName | "unknown" = stale || current === undefined ? "unknown" : current.state
        return answer({ state: effective })
      }
      default:
        return new Response("not found", { status: 404 })
    }
  }
}

const turnCancelStub = (env: WorkerEnv, runId: string): TurnCancelStub | undefined =>
  env.TURN_CANCELS?.get(env.TURN_CANCELS.idFromName(runId))

const readStubJson = async <T>(response: Response): Promise<T | undefined> =>
  (response.json().catch(() => undefined)) as Promise<T | undefined>

export interface WorkerEnv {
  readonly ASSETS: { readonly fetch: (request: Request) => Promise<Response> }
  readonly SMITHERS_CHAT_URL?: string
  readonly SMITHERS_CHAT_ORIGIN?: string
  /**
   * The deployment credential the chat upstream authenticates turns with
   * (`workers/chat` accepts only `authorization: Bearer`, resolved against
   * the cloud's /api/user). A client can never supply it — the turn route
   * builds its own headers — so without it the forward can only come back
   * the upstream's honest 401, which is surfaced verbatim.
   */
  readonly SMITHERS_CHAT_AUTH_TOKEN?: string
  /**
   * The chat worker's trusted-caller key (its PRODUCT_SERVICE_TOKEN). Sent
   * with the validated login on session-gated turns so the turn's metered
   * charge lands on the user's own account (wave 13, D-2).
   */
  readonly CHAT_PRODUCT_SERVICE_TOKEN?: string
  /** Per-session upstream engine gateway URL. Unset = the seam answers 501. */
  readonly GATEWAY_UPSTREAM_URL?: string
  /** Service-token branch: attached as the upstream bearer when configured. */
  readonly GATEWAY_AUTH_TOKEN?: string
  /** Trusted-proxy branch placeholder session: injected identity, when set. */
  readonly GATEWAY_SESSION_USER_ID?: string
  readonly GATEWAY_SESSION_USER_ROLE?: string
  readonly GATEWAY_SESSION_USER_SCOPES?: string
  /**
   * How long any one upstream gets to answer, in milliseconds. Unset uses
   * UPSTREAM_TIMEOUT_MS; a deployment behind a slow sibling can raise it
   * without a code change, and the tests shorten it to stay fast.
   */
  readonly UPSTREAM_TIMEOUT_MS?: string
  /** Identity worker (GitHub OAuth + allowlist) upstream. Unset = 501. */
  readonly IDENTITY_UPSTREAM_URL?: string
  /** Service token for the product-Worker → identity /api/identity/validate call. */
  readonly IDENTITY_SERVICE_TOKEN?: string
  /**
   * "1" opens the Stripe checkout and portal routes. Unset — the closed-alpha
   * state — makes both answer an honest refusal instead of reaching Stripe.
   */
  readonly BILLING_CHECKOUT_ENABLED?: string
  /** Billing worker upstream. Unset = 501. */
  readonly BILLING_UPSTREAM_URL?: string
  /**
   * The Smithers Cloud user bearer billing authenticates the account with
   * (`workers/billing` resolves it against `SMITHERS_CLOUD_API_BASE_URL/api/user`).
   * Billing reads no `x-user-*` claim, so without this the seam answers 501
   * rather than forwarding a request that can only come back 401.
   */
  readonly BILLING_AUTH_TOKEN?: string
  /**
   * The wave-5 trusted-caller key (`workers/billing`'s PRODUCT_SERVICE_TOKEN).
   * When a session validates, the billing proxy authenticates AS THAT USER with
   * `x-smithers-service-token` + `x-user-login` instead of the deployment-wide
   * bearer — the signed-in user reads their OWN account, never the shared one.
   */
  readonly BILLING_PRODUCT_SERVICE_TOKEN?: string
  /**
   * The admin tokens for the sibling workers' non-enumerable admin surfaces
   * (each sibling holds its own ADMIN_SERVICE_TOKEN). The product Worker's
   * /api/admin/* routes spend them only after the caller's session validates
   * as admin:true; every other caller gets the canonical 404.
   */
  readonly IDENTITY_ADMIN_TOKEN?: string
  readonly BILLING_ADMIN_TOKEN?: string
  /**
   * The per-runId cancellation registry (Durable Object). Present on every
   * real deployment — wrangler.jsonc binds it; only unit tests that exercise
   * the in-isolate fallback leave it unset.
   */
  readonly TURN_CANCELS?: TurnCancelNamespace
  /**
   * Smithers Cloud API base (Wave 11): the per-user gateway provision route
   * lives here (`POST /api/repos/{owner}/{repo}/gateway`).
   */
  readonly SMITHERS_CLOUD_API_BASE_URL?: string
  /**
   * The per-user gateway session registry (Wave 11, Durable Object keyed by
   * login): holds the relay records server-side so gateway tokens never
   * reach a browser. Unset only in unit tests (in-isolate fallback).
   */
  readonly GATEWAY_SESSIONS?: GatewaySessionNamespace
  /**
   * The per-login turn ceiling (Durable Object keyed by the validated login).
   * An abuse guard on a comped seam, not a billing pause — see turnLimit.ts.
   * Unset in unit tests and the stub stack, where it fails open.
   */
  readonly TURN_LIMITS?: TurnLimitNamespace
  /**
   * The bounded client-error log (one Durable Object for the deployment),
   * read back through GET /api/admin/errors. Unset in unit tests, where the
   * handler keeps its console.error and nothing is stored.
   */
  readonly CLIENT_ERRORS?: ClientErrorNamespace
}

const withIsolationHeaders = (response: Response): Response => {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...ISOLATION_HEADERS }
  })

const isStartTurnRequest = (value: unknown): value is StartAgentTurnRequest =>
  typeof value === "object" &&
  value !== null &&
  "runId" in value &&
  typeof value.runId === "string" &&
  value.runId !== "" &&
  "messages" in value &&
  Array.isArray(value.messages) &&
  "instructions" in value &&
  typeof value.instructions === "string" &&
  (!("tools" in value) || Array.isArray(value.tools)) &&
  (!("context" in value) ||
    value.context === undefined ||
    AgentRuntimeContextSchema.safeParse(value.context).success)

const readTurnBody = async (request: Request): Promise<unknown> => {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MAX_BODY_BYTES) throw new BodyTooLargeError()
  // Measured in bytes, not UTF-16 code units: a body of multi-byte characters
  // encodes to up to 4x its string length, so a `.length` check would admit a
  // body several times over the cap (and a chunked request declares no length).
  const reader = request.body?.getReader()
  const chunks: Array<Uint8Array> = []
  let byteLength = 0
  if (reader !== undefined) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        throw new BodyTooLargeError()
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new Error("Request body must be valid JSON.")
  }
}

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large.")
  }
}

/*
 * Every model call replays the whole transcript, so "too large" is a fact about
 * the CONVERSATION, not about the message that tripped it. The turn seam said
 * so; the model relay — which since the browser chain became the only backend
 * carries every turn — still answered the bare `Request body is too large.`,
 * which names nothing the reader can act on (repro
 * apps/ui/canary-repros/chat/4.13). One sentence, both doors.
 */
const TRANSCRIPT_TOO_LARGE =
  "This conversation has grown too long to send in one turn. Start a new conversation to keep going — nothing was charged, and the transcript above stays where it is."

/*
 * Live turns keyed by runId so /cancel can abort one. Per-isolate best effort,
 * used only when no TURN_CANCELS binding exists (unit tests): a disconnect of
 * the turn's own request always cancels upstream regardless.
 */
const activeTurns = new Map<string, AbortController>()

/** How often the streaming pump re-checks the kill state while the upstream is silent. */
const CANCEL_POLL_MS = 500

/**
 * The poll is a Durable Object subrequest, and a Worker request may only make
 * ~1000 of those — a token-streamed turn delivers far more chunks than that,
 * so polling once per chunk would kill long turns with "Too many subrequests".
 * The poll is therefore rate-limited: at most one per CANCEL_POLL_MS, and —
 * because workerd's clock only advances on I/O — at least one every
 * CANCEL_POLL_CHUNKS chunks, so a fast stream can never starve the check.
 */
const CANCEL_POLL_CHUNKS = 64

/**
 * The turn's own view of the kill state. `isCancelled` reads the runId's
 * Durable Object — every read is this request's own subrequest, which workerd
 * allows, unlike touching another request's AbortController. `settle` marks
 * the turn finished so a later cancel answers an honest not-found.
 */
interface TurnStreamHooks {
  readonly isCancelled: () => Promise<boolean>
  readonly settle: () => Promise<void>
}

/**
 * Stamp each upstream frame with the turn's runId. The upstream wire frame
 * carries none (the dev boundary's CloudAgent adds it on publish; this Worker
 * is that boundary for the deployed app), and the client's stream reader
 * drops frames that don't name their turn — an untouched pass-through would
 * be a silent stall. Unparseable lines pass through verbatim.
 *
 * The terminal `done` frame also settles the kill state — here, while the
 * frame is still in the transform, never later: a tool-loop continuation leg
 * re-POSTs the same runId the instant the client reads that frame, and must
 * not meet a stale 409 from a registration the stream lifecycle hadn't
 * settled yet.
 *
 * A server-side kill surfaces between chunks: the pump re-reads the registry
 * before every upstream read and on a timer tick while the upstream is
 * silent, and on "cancelled" it aborts ITS OWN upstream fetch (legal — same
 * request context), emits an honest terminal `done` frame with reason
 * "cancelled", and closes. The turn never completes silently after a kill.
 */
const tagRunId = (
  body: ReadableStream<Uint8Array>,
  runId: string,
  hooks?: TurnStreamHooks
): ReadableStream<Uint8Array> => {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  let settled = false
  // One pending upstream read at a time, held across pulls: a timer tick that
  // wins the race leaves the read in place for the next pull instead of
  // issuing a second read on the same reader (which would throw).
  let pendingRead:
    | Promise<ReadableStreamDefaultReadDoneResult | ReadableStreamDefaultReadValueResult<Uint8Array>>
    | undefined
  const settleOnce = async (): Promise<void> => {
    if (settled) return
    settled = true
    await hooks?.settle()
  }
  // Rate-limited kill check: skipped once the turn has settled (the registry
  // entry is then free for the next leg, and a later "cancelled" on it is not
  // this stream's business) and while neither the clock nor the chunk count
  // says another poll is due.
  let lastPollAt = 0
  let chunksSincePoll = CANCEL_POLL_CHUNKS
  const killed = async (): Promise<boolean> => {
    if (hooks === undefined || settled) return false
    const now = Date.now()
    if (now - lastPollAt < CANCEL_POLL_MS && chunksSincePoll < CANCEL_POLL_CHUNKS) return false
    lastPollAt = now
    chunksSincePoll = 0
    return hooks.isCancelled().catch(() => false)
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (await killed()) {
          controller.enqueue(
            encoder.encode(`${JSON.stringify({ runId, type: "done", reason: "cancelled" })}\n`)
          )
          await reader.cancel("cancelled").catch(() => {})
          await settleOnce()
          controller.close()
          return
        }
        pendingRead ??= reader.read()
        const read = pendingRead
        // The tick only bounds how long a silent upstream can hide a kill;
        // clear it as soon as the read wins so a chatty stream does not pile
        // up one live timer per chunk.
        let tick: ReturnType<typeof setTimeout> | undefined
        const result = await Promise.race([
          read,
          ...(hooks === undefined || settled
            ? []
            : [
              new Promise<"tick">((resolve) => {
                tick = setTimeout(() => resolve("tick"), CANCEL_POLL_MS)
              })
            ])
        ])
        if (tick !== undefined) clearTimeout(tick)
        if (result === "tick") return // pull is re-invoked while downstream wants more
        pendingRead = undefined
        chunksSincePoll += 1
        const { value, done } = result
        buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split("\n")
        buffer = done ? "" : (lines.pop() ?? "")
        for (const line of lines) {
          if (line.trim() === "") continue
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            parsed = undefined
          }
          if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
            if ((parsed as { type?: unknown }).type === "done") await settleOnce()
            controller.enqueue(
              encoder.encode(`${JSON.stringify({ ...parsed, runId })}\n`)
            )
          } else {
            controller.enqueue(encoder.encode(`${line}\n`))
          }
        }
        if (done) {
          await settleOnce()
          controller.close()
          return
        }
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return
      }
    },
    cancel: async (reason) => {
      await settleOnce()
      return reader.cancel(reason)
    }
  })
}

/**
 * Where managed inference lives, and how this Worker authenticates to it.
 *
 * Both model-spending routes — the turn path and the browser chain's relay —
 * call the SAME upstream with the SAME credentials, so there is one place that
 * decides what a Smithers-authenticated inference request looks like. The
 * upstream owns the provider key, prices the turn against the rate card, and
 * meters it durably; nothing downstream of here has to reproduce any of that.
 */
const chatUpstreamUrl = (env: WorkerEnv): string => env.SMITHERS_CHAT_URL?.trim() || DEFAULT_CHAT_URL

/*
 * Wave 13 (D-2): a session-validated call is metered onto the USER's own
 * billing account — the chat worker attributes the charge to the vouched login
 * (complimentary: cost recorded, $0 debited), so the user's receipt shows the
 * usage and their balance never moves. The token pair is the chat worker's
 * trusted-caller door; a client can never inject it, because this header set is
 * BUILT here and the caller's own headers are never forwarded. Without the
 * configured token the call still runs — metering then attributes to the
 * deployment account, exactly as before that path existed.
 */
const chatUpstreamHeaders = (
  env: WorkerEnv,
  runId: string,
  session: ValidatedIdentity | undefined
): Record<string, string> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: env.SMITHERS_CHAT_ORIGIN?.trim() || DEFAULT_APP_ORIGIN,
    "x-smithers-run-id": runId
  }
  const chatToken = env.SMITHERS_CHAT_AUTH_TOKEN?.trim()
  if (chatToken !== undefined && chatToken !== "") {
    headers.authorization = `Bearer ${chatToken}`
  }
  const chatProductToken = env.CHAT_PRODUCT_SERVICE_TOKEN?.trim()
  if (session !== undefined && chatProductToken !== undefined && chatProductToken !== "") {
    headers["x-smithers-service-token"] = chatProductToken
    headers["x-user-login"] = session.login
  }
  return headers
}

const handleTurn = async (
  request: Request,
  env: WorkerEnv,
  turnSession?: ValidatedIdentity
): Promise<Response> => {
  let body: unknown
  try {
    body = await readTurnBody(request)
  } catch (error) {
    // The transcript rides every turn, so "too large" is a fact about the
    // conversation, not about this one message. Say which, and say the way out.
    if (error instanceof BodyTooLargeError) {
      return json(413, { status: "error", message: TRANSCRIPT_TOO_LARGE })
    }
    return json(400, {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid request."
    })
  }
  if (!isStartTurnRequest(body)) {
    return json(400, {
      status: "error",
      message: "Body must be { runId, messages, instructions } with optional tools and context."
    })
  }
  const registry = turnCancelStub(env, body.runId)
  if (registry !== undefined) {
    // The registry is the cross-isolate authority on duplicate turns; the
    // per-isolate map only ever sees this isolate's requests.
    const registration = await readStubJson<{ status?: string }>(
      await registry.fetch(new Request("https://turn-cancel.internal/register", { method: "POST" }))
    )
    if (registration?.status !== "started") {
      return json(409, { status: "error", message: "That Smithers turn is already running." })
    }
  } else if (activeTurns.has(body.runId)) {
    return json(409, { status: "error", message: "That Smithers turn is already running." })
  }
  const settle = async (): Promise<void> => {
    activeTurns.delete(body.runId)
    if (registry !== undefined) {
      await registry
        .fetch(new Request("https://turn-cancel.internal/settle", { method: "POST" }))
        .then((response) => response.arrayBuffer())
        .catch(() => {})
    }
  }

  const upstream = new AbortController()
  activeTurns.set(body.runId, upstream)
  // The client going away cancels the upstream turn exactly like the native
  // CloudAgent's cancel does.
  request.signal.addEventListener("abort", () => upstream.abort())

  let response: Response
  try {
    response = await fetch(chatUpstreamUrl(env), {
      method: "POST",
      signal: upstream.signal,
      headers: chatUpstreamHeaders(env, body.runId, turnSession),
      body: JSON.stringify({
        messages: body.messages,
        // The hidden runtime context renders server-side into the
        // instructions — same composition as the native/dev CloudAgent.
        instructions: composeAgentInstructions(body.instructions, body.context),
        // The tool-loop contract (Wave 3b): the one tool spec rides every
        // turn; the upstream emits tool_call frames the client answers
        // with function_call_output continuation items in `messages`.
        ...(body.tools === undefined ? {} : { tools: body.tools })
      })
    })
  } catch (error) {
    await settle()
    if (upstream.signal.aborted) {
      return json(499, { status: "error", message: "The client disconnected." })
    }
    return json(502, {
      status: "error",
      message: `Smithers Cloud chat is unreachable: ${error instanceof Error ? error.message : "unknown error"}`
    })
  }
  if (!response.ok || response.body === null) {
    await settle()
    const detail = await response.text().catch(() => "")
    return json(response.ok ? 502 : response.status, {
      status: "error",
      message: response.ok
        ? "The model service accepted the turn and then sent no answer at all. Nothing was charged."
        : upstreamFailureMessage(response.status, detail, response.headers.get("retry-after"))
    })
  }

  // Stream the upstream NDJSON through with the run tagged on every frame so
  // the client can match it to its turn; a terminal frame, a kill observed
  // between chunks, or a closed connection settles the registry entry.
  const hooks: TurnStreamHooks | undefined = registry === undefined
    ? undefined
    : {
      isCancelled: async () => {
        const state = await readStubJson<{ state?: string }>(
          await registry.fetch(new Request("https://turn-cancel.internal/state"))
        )
        return state?.state === "cancelled"
      },
      settle
    }
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  void tagRunId(response.body, body.runId, hooks)
    .pipeTo(writable)
    .catch(() => {})
    .finally(() => void settle())
  return withIsolationHeaders(
    new Response(readable, {
      status: 200,
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" }
    })
  )
}

/*
 * The chain backend's model relay (DESIGN.md §14, D1) — and, since the browser
 * chain became the only backend, the one route a chat turn spends a model on.
 *
 * The browser runs the real @smthrs/model request/stream machinery against this
 * path and the relay forwards it, unchanged, to the SAME managed-inference
 * upstream `/api/agent/turn` uses (`chatUpstreamHeaders` above). That upstream
 * owns the Cerebras key, authorizes the balance BEFORE calling the provider,
 * and enqueues the turn's authoritative usage onto the durable metering queue —
 * so the relay inherits per-user metering rather than reproducing it, and no
 * provider credential exists on this Worker at all.
 *
 * The router gates the route before any of this runs: anonymous callers get
 * 401, non-allowlisted ones 403, and the per-login turn ceiling applies — all
 * of it decided before a single upstream byte is spent.
 */

const isModelStreamBody = (value: unknown): value is { readonly messages: ReadonlyArray<unknown> } =>
  typeof value === "object" &&
  value !== null &&
  "messages" in value &&
  Array.isArray((value as { readonly messages?: unknown }).messages) &&
  (value as { readonly messages: ReadonlyArray<unknown> }).messages.length > 0

const hasTools = (value: object): boolean =>
  "tools" in value &&
  Array.isArray((value as { readonly tools?: unknown }).tools) &&
  ((value as { readonly tools: ReadonlyArray<unknown> }).tools.length > 0)

const handleModelStream = async (
  request: Request,
  env: WorkerEnv,
  session: ValidatedIdentity | undefined
): Promise<Response> => {
  let body: unknown
  try {
    body = await readTurnBody(request)
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return json(413, { status: "error", message: TRANSCRIPT_TOO_LARGE })
    }
    return json(400, {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid request."
    })
  }
  if (!isModelStreamBody(body)) {
    return json(400, { status: "error", message: "Body must carry a non-empty messages array." })
  }
  // The sealed-step law, enforced at the boundary: the author call carries no
  // tools, so a tool-bearing request has no business on this relay.
  if (hasTools(body)) {
    return json(400, { status: "error", message: "The model relay serves sealed author calls only — no tools." })
  }
  /*
   * The run id is minted HERE, never read from the caller. Upstream derives
   * the charge's idempotency key from it, so a client that could choose it
   * could replay one receipt and take every later call for free.
   */
  const runId = crypto.randomUUID()
  const upstream = new AbortController()
  request.signal.addEventListener("abort", () => upstream.abort())
  let response: Response
  try {
    response = await fetch(chatUpstreamUrl(env), {
      method: "POST",
      signal: upstream.signal,
      headers: chatUpstreamHeaders(env, runId, session),
      body: JSON.stringify(body)
    })
  } catch (error) {
    if (upstream.signal.aborted) {
      return json(499, { status: "error", message: "The client disconnected." })
    }
    return json(502, {
      status: "error",
      message: `The model service is unreachable: ${error instanceof Error ? error.message : "unknown error"}`
    })
  }
  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => "")
    return json(response.ok ? 502 : response.status, {
      status: "error",
      message: response.ok
        ? "The model service accepted the request and then sent no answer at all."
        : upstreamFailureMessage(response.status, detail, response.headers.get("retry-after"))
    })
  }
  return withIsolationHeaders(
    new Response(response.body, {
      status: 200,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/x-ndjson",
        "cache-control": "no-store"
      }
    })
  )
}

const handleCancel = async (request: Request, env: WorkerEnv): Promise<Response> => {
  let body: unknown
  try {
    body = await readTurnBody(request)
  } catch (error) {
    return json(error instanceof BodyTooLargeError ? 413 : 400, {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid request."
    })
  }
  const runId = typeof body === "object" && body !== null && "runId" in body ? body.runId : undefined
  if (typeof runId !== "string" || runId === "") {
    return json(400, { status: "error", message: "runId is required." })
  }
  const registry = turnCancelStub(env, runId)
  if (registry !== undefined) {
    // workerd-legal kill: never touch the turn request's I/O from here —
    // just flip the registry state. The turn's own streaming pump observes
    // "cancelled" between chunks and aborts its own upstream fetch, then
    // ends the stream with an honest terminal frame.
    const result = await readStubJson<{ status?: string }>(
      await registry.fetch(new Request("https://turn-cancel.internal/cancel", { method: "POST" }))
    )
    return json(200, { status: result?.status === "cancelled" ? "cancelled" : "not-found" })
  }
  // In-isolate fallback (unit tests only; the bindingless dev boundary keeps
  // its own implementation). Same-request abort is legal everywhere.
  const active = activeTurns.get(runId)
  if (active === undefined) return json(200, { status: "not-found" })
  active.abort()
  activeTurns.delete(runId)
  return json(200, { status: "cancelled" })
}

const notConfigured = (name: string, detail: string): Response =>
  json(501, { status: "error", message: `${name} is not configured on this deployment (${detail}).` })

const gatewayNotConfigured = (): Response =>
  notConfigured(
    "The engine gateway seam",
    "GATEWAY_UPSTREAM_URL is unset. The engine itself does not ship in Wave 1"
  )

/**
 * The identity the gateway seam injects: a service-token bearer, or the
 * deployment-configured placeholder session. An upstream with neither branch
 * configured is a 501, never an unauthenticated forward.
 */
const gatewayIdentityHeaders = (env: WorkerEnv): Record<string, string> | Response => {
  const serviceToken = env.GATEWAY_AUTH_TOKEN?.trim()
  const sessionUserId = env.GATEWAY_SESSION_USER_ID?.trim()
  if ((serviceToken === undefined || serviceToken === "") && (sessionUserId === undefined || sessionUserId === "")) {
    return json(501, {
      status: "error",
      message: "The engine gateway seam has an upstream but no auth branch configured " +
        "(neither GATEWAY_AUTH_TOKEN nor a validated session)."
    })
  }
  if (serviceToken !== undefined && serviceToken !== "") {
    return { authorization: `Bearer ${serviceToken}` }
  }
  const headers: Record<string, string> = { "x-user-id": sessionUserId ?? "" }
  if (env.GATEWAY_SESSION_USER_ROLE !== undefined) headers["x-user-role"] = env.GATEWAY_SESSION_USER_ROLE
  if (env.GATEWAY_SESSION_USER_SCOPES !== undefined) headers["x-user-scopes"] = env.GATEWAY_SESSION_USER_SCOPES
  return headers
}

/**
 * Forward a gateway-bound request to the per-session upstream, stripping every
 * client-supplied identity header and re-injecting identity only from the
 * validated session (here: deployment-configured placeholder values).
 */
const proxyToGateway = (request: Request, env: WorkerEnv): Promise<Response> => {
  const upstream = env.GATEWAY_UPSTREAM_URL?.trim()
  if (upstream === undefined || upstream === "") return Promise.resolve(gatewayNotConfigured())

  const identity = gatewayIdentityHeaders(env)
  if (identity instanceof Response) return Promise.resolve(identity)

  const url = new URL(request.url)
  const target = new URL(url.pathname + url.search, upstream)
  const headers = new Headers(request.headers)
  for (const name of STRIPPED_IDENTITY_HEADERS) headers.delete(name)
  for (const [name, value] of Object.entries(identity)) headers.set(name, value)
  return forwardUnderDeadline(
    "The engine gateway",
    new Request(target.toString(), new Request(request, { headers })),
    upstreamTimeoutMs(env)
  )
}

const isGatewayRoute = (pathname: string): boolean =>
  GATEWAY_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))

/**
 * A proxy whose upstream never answered. Returning the raw rejection would end
 * the fetch handler with an uncaught exception, and workerd answers that with
 * its own `Error 1101 Worker threw exception` HTML page — which the transcript
 * then renders verbatim to the user (repro apps/ui/canary-repros/honesty/24.3,
 * the §24.4 note). A named JSON refusal is the honest answer instead.
 */
const upstreamUnreachable = (seam: string, error: unknown): Response =>
  json(error instanceof UpstreamTimeoutError ? 504 : 502, {
    status: "error",
    message: error instanceof UpstreamTimeoutError
      ? `${seam} did not answer in time, so nothing was read. Try again in a moment.`
      : `${seam} is unreachable right now: ${error instanceof Error ? error.message : "unknown error"}`
  })

/** Forward one already-built request under the seam's deadline, never throwing. */
const forwardUnderDeadline = (seam: string, target: Request, timeoutMs: number): Promise<Response> =>
  withDeadline(seam, (signal) => fetch(target, { signal }), timeoutMs).catch((error: unknown) =>
    upstreamUnreachable(seam, error)
  )

/**
 * The identity worker is the identity authority: it sets and reads its own
 * session cookie, so the proxy forwards cookies untouched but still strips
 * client-supplied identity headers — a browser must never inject x-user-*.
 *
 * Both sibling workers gate on the browser `Origin` (`ALLOWED_ORIGINS`), and a
 * same-origin GET carries none at all, so the proxy states the one origin that
 * is actually true of every request it forwards: its own. Deployments must list
 * this Worker's origin in the identity and billing workers' `ALLOWED_ORIGINS`.
 */
const withProxyOrigin = (headers: Headers, url: URL): void => {
  headers.set("origin", url.origin)
}

const proxyToIdentity = (request: Request, env: WorkerEnv): Promise<Response> => {
  const upstream = env.IDENTITY_UPSTREAM_URL?.trim()
  if (upstream === undefined || upstream === "") {
    return Promise.resolve(
      notConfigured("The identity seam", "IDENTITY_UPSTREAM_URL is unset. Sign-in is unavailable")
    )
  }
  const url = new URL(request.url)
  const target = new URL(url.pathname + url.search, upstream)
  const headers = new Headers(request.headers)
  for (const name of STRIPPED_IDENTITY_HEADERS) headers.delete(name)
  withProxyOrigin(headers, url)
  return forwardUnderDeadline(
    "The identity service",
    new Request(target.toString(), new Request(request, { headers })),
    upstreamTimeoutMs(env)
  )
}

/*
 * Wave 8 — no dead ends on the live surface.
 *
 * The OAuth start/callback routes are TOP-LEVEL PAGE NAVIGATIONS: the user
 * clicks "Sign in with GitHub" and the browser loads the route as a document.
 * When the identity upstream answers anything but a redirect (OAuth
 * unconfigured → 503, an upstream 4xx/5xx, an unreachable service), passing
 * the response through would strand the user on a browser-rendered blob of
 * raw JSON — an error that says neither what they were doing nor the next
 * step. So at this seam a non-redirect upstream answer becomes a minimal,
 * self-contained branded page that states honestly what happened and offers
 * the one way back home. Callers that ask for JSON (`Accept:
 * application/json`) keep the machine-readable upstream answer verbatim, and
 * the HTTP status is preserved either way.
 *
 * The heading/detail strings below are constants composed with an integer
 * status code only — no upstream or user input reaches the page unescaped.
 */
const prefersJson = (request: Request): boolean => {
  const accept = request.headers.get("accept") ?? ""
  return accept.includes("application/json") && !accept.includes("text/html")
}

const authErrorPage = (heading: string, detail: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${heading} — Smithers</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
	margin: 0;
	min-height: 100vh;
	display: grid;
	place-items: center;
	background: #f7f4ee;
	color: #211d18;
	font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	-webkit-font-smoothing: antialiased;
}
.card {
	max-width: 30rem;
	margin: 1.5rem;
	padding: 2.5rem 2.25rem;
	background: #fffefa;
	border: 1px solid #e4ddcf;
	border-radius: 16px;
	box-shadow: 0 1px 2px rgb(33 29 24 / 4%), 0 12px 32px rgb(33 29 24 / 10%);
}
.wordmark {
	margin: 0 0 1.75rem;
	font-size: 0.7813rem;
	font-weight: 600;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: #0f766e;
}
.wordmark::after {
	content: "";
	display: block;
	width: 2rem;
	height: 2px;
	margin-top: 0.5rem;
	background: #e8a33d;
	border-radius: 999px;
}
h1 {
	margin: 0 0 0.875rem;
	font-size: 1.375rem;
	line-height: 1.35;
	font-weight: 650;
}
.detail {
	margin: 0 0 2rem;
	font-size: 0.9375rem;
	line-height: 1.6;
	color: #4a443b;
}
.home {
	display: inline-block;
	padding: 0.625rem 1.25rem;
	border-radius: 10px;
	background: #0f766e;
	color: #fffefa;
	font-size: 0.9375rem;
	font-weight: 600;
	text-decoration: none;
}
.home:hover { background: #0b5b57; }
</style>
</head>
<body>
<main class="card">
<p class="wordmark">Smithers</p>
<h1>${heading}</h1>
<p class="detail">${detail}</p>
<a class="home" href="/">Back to Smithers</a>
</main>
</body>
</html>`

const authErrorResponse = (status: number, heading: string, detail: string): Response =>
  new Response(authErrorPage(heading, detail), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...ISOLATION_HEADERS
    }
  })

const OAUTH_OFF_HEADING = "GitHub sign-in isn't switched on yet for this preview."

/*
 * GitHub reports a refused authorization on the callback as `?error=…` with no
 * `code`. Forwarded to identity, that reads as a malformed callback and the
 * page told the user "the sign-in service answered HTTP 400" — blaming a
 * service for a button the user pressed (repro
 * apps/ui/canary-repros/access/2.3). The cause is knowable from the query
 * string, so it is read here and named.
 *
 * `access_denied` is not a failure: the user declined, the app did exactly what
 * it was told, and nothing was signed in. It answers 200 with that sentence.
 * Every other documented OAuth error IS a failure of the exchange and keeps a
 * 400 with the error GitHub named.
 */
const OAUTH_DENIED_HEADING = "You cancelled the GitHub sign-in."

const oauthCallbackRefusal = (url: URL): { status: number; heading: string; detail: string } | undefined => {
  const error = url.searchParams.get("error")?.trim()
  if (error === undefined || error === "") return undefined
  if (error === "access_denied") {
    return {
      status: 200,
      heading: OAUTH_DENIED_HEADING,
      detail:
        "You chose not to give Smithers access on GitHub, so the sign-in stopped there. Nothing was signed in and nothing was shared — head back whenever you want to try again."
    }
  }
  const described = url.searchParams.get("error_description")?.trim()
  return {
    status: 400,
    heading: "GitHub sign-in didn't finish.",
    detail: `GitHub stopped the sign-in and called it "${error}"${
      described === undefined || described === "" ? "" : ` — ${described}`
    }. Nothing was signed in — head back and try again.`
  }
}

const handleAuthNavigation = async (
  request: Request,
  env: WorkerEnv,
  route: "start" | "callback"
): Promise<Response> => {
  if (route === "callback") {
    const refusal = oauthCallbackRefusal(new URL(request.url))
    if (refusal !== undefined) {
      if (prefersJson(request)) {
        return json(refusal.status, {
          status: refusal.status === 200 ? "cancelled" : "error",
          message: refusal.detail
        })
      }
      return authErrorResponse(refusal.status, refusal.heading, refusal.detail)
    }
  }
  const upstream = env.IDENTITY_UPSTREAM_URL?.trim()
  if (upstream === undefined || upstream === "") {
    if (prefersJson(request)) return proxyToIdentity(request, env)
    return authErrorResponse(
      501,
      OAUTH_OFF_HEADING,
      "You tried to sign in with GitHub, but this preview deployment has no sign-in service configured yet, so the sign-in can't start. Nothing was signed in and nothing was lost."
    )
  }
  let response: Response
  try {
    response = await proxyToIdentity(request, env)
  } catch (error) {
    const cause = error instanceof Error ? error.message : "unknown error"
    if (prefersJson(request)) {
      return json(502, { status: "error", message: `The identity service is unreachable: ${cause}` })
    }
    return authErrorResponse(
      502,
      route === "start" ? "GitHub sign-in can't start right now." : "GitHub sign-in didn't finish.",
      `You tried to sign in with GitHub, but the sign-in service could not be reached, so the sign-in ${
        route === "start" ? "can't start" : "could not complete"
      }. Nothing was signed in — head back and try again in a bit.`
    )
  }
  // The happy path is a redirect: to GitHub from start, back here from callback.
  if (response.status >= 300 && response.status < 400 && response.headers.get("location") !== null) {
    return response
  }
  /*
   * The OTHER happy path (native sign-in handoff): a callback bound to a
   * handoff answers a 200 HTML page — "You're signed in — return to the
   * Smithers app" — because the session travels to the app through the
   * claim endpoint, not this tab. A success page is not an upstream error;
   * replacing it with the 502 surface told a signed-in user nothing was
   * signed in (the live bug).
   */
  if (
    route === "callback" &&
    response.status === 200 &&
    (response.headers.get("content-type") ?? "").includes("text/html")
  ) {
    return response
  }
  if (prefersJson(request)) return response
  // What remains is an upstream error (or a non-redirect oddity): read the
  // machine answer for its code, then replace it with the human page.
  const body = (await response.text().catch(() => "")).trim()
  let code: string | undefined
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === "object" && parsed !== null && "code" in parsed && typeof parsed.code === "string") {
      code = parsed.code
    }
  } catch {
    // A non-JSON error body has no code to read; the status still says enough.
  }
  const status = response.status >= 400 ? response.status : 502
  if (route === "start") {
    if (code === "oauth_not_configured") {
      return authErrorResponse(
        status,
        OAUTH_OFF_HEADING,
        `You tried to sign in with GitHub. The sign-in service answered that its GitHub credentials aren't installed yet (HTTP ${status}), so the sign-in can't start. Nothing was signed in and nothing was lost.`
      )
    }
    return authErrorResponse(
      status,
      "GitHub sign-in can't start right now.",
      `You tried to sign in with GitHub, but the sign-in service answered HTTP ${status} instead of sending you to GitHub, so the sign-in can't start. Nothing was signed in — head back and try again in a bit.`
    )
  }
  return authErrorResponse(
    status,
    "GitHub sign-in didn't finish.",
    `You were on your way back from GitHub, but the sign-in service answered HTTP ${status}, so the sign-in could not complete. Nothing was signed in — head back and try again.`
  )
}

/**
 * Wave 8 — the session probe is a question, not an error. The landing boots by
 * asking "who is signed in?", and the upstream's 401 IS the expected signed-out
 * answer — but the browser logs any 4xx document/subresource response as a
 * console error no matter how calmly the client JS handles it. So the seam
 * restates the expected answer as what it honestly is — a resolved 200 naming
 * the signed-out state.
 *
 * ONLY the 401. The identity worker spends 401 on exactly one thing here (no
 * session cookie, or an unreadable one); its 403 means "Forbidden origin" — a
 * deployment whose ALLOWED_ORIGINS omits this Worker, where every identity call
 * is broken and nobody could sign in. Restating that as "signed out" would
 * paint a broken deployment as a calm signed-out landing with a clean console,
 * which is exactly the kind of suppression this wave exists to stop. It, 5xx,
 * and an unreachable upstream all pass through untouched and still surface.
 */
const probeAuthSession = async (request: Request, env: WorkerEnv): Promise<Response> => {
  const response = await proxyToIdentity(request, env)
  if (response.status !== 401) return response
  await response.body?.cancel()
  return json(200, { status: "signed-out" })
}

interface ValidatedIdentity {
  readonly login: string
  readonly allowlisted: boolean
  readonly admin: boolean
  readonly scopes: ReadonlyArray<string>
}

type SessionValidation =
  | { readonly status: "valid"; readonly identity: ValidatedIdentity }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable"; readonly response: Response }

/**
 * Validate the caller's session cookie against the identity worker's
 * service-token endpoint (the contract's trusted-proxy validation path).
 * Keeps an invalid session distinct from an unavailable identity service so
 * an outage can never be restated as "Sign in".
 */
const validateSession = async (request: Request, env: WorkerEnv): Promise<SessionValidation> => {
  const upstream = env.IDENTITY_UPSTREAM_URL?.trim()
  if (upstream === undefined || upstream === "") return { status: "invalid" }
  const headers: Record<string, string> = { "content-type": "application/json" }
  const cookie = request.headers.get("cookie")
  if (cookie !== null) headers.cookie = cookie
  const serviceToken = env.IDENTITY_SERVICE_TOKEN?.trim()
  if (serviceToken !== undefined && serviceToken !== "") {
    headers["x-smithers-service-token"] = serviceToken
  }
  try {
    const response = await withDeadline(
      "The identity service",
      (signal) =>
        fetch(new URL("/api/identity/validate", upstream).toString(), {
          method: "POST",
          headers,
          body: "{}",
          signal
        }),
      upstreamTimeoutMs(env)
    )
    if (!response.ok) {
      await response.body?.cancel()
      return response.status === 401
        ? { status: "invalid" }
        : {
          status: "unavailable",
          response: json(502, { status: "error", message: `The identity service answered HTTP ${response.status}.` })
        }
    }
    const body = (await response.json().catch(() => undefined)) as {
      login?: unknown
      allowlisted?: unknown
      admin?: unknown
      scopes?: unknown
    } | undefined
    if (body === undefined || typeof body.login !== "string" || body.login === "") {
      return {
        status: "unavailable",
        response: json(502, { status: "error", message: "The identity service returned a malformed session response." })
      }
    }
    return {
      status: "valid",
      identity: {
        login: body.login,
        allowlisted: body.allowlisted === true,
        admin: body.admin === true,
        scopes: Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : []
      }
    }
  } catch (error) {
    return {
      status: "unavailable",
      response: json(error instanceof UpstreamTimeoutError ? 504 : 502, {
        status: "error",
        message: error instanceof UpstreamTimeoutError
          ? `The identity service did not answer within ${Math.round(upstreamTimeoutMs(env) / 1000)}s.`
          : "The identity service is unreachable."
      })
    }
  }
}

/**
 * The turn seam spends the deployment's own model credential and meters real
 * dollars onto the deployment's billing account, so on any deployment that HAS
 * an identity seam it must never answer an anonymous caller. The same-origin
 * guard is not that gate: it only fires for a request that *sends* an `Origin`,
 * so a plain `curl -X POST` sails past it. Wave 7 published this Worker at
 * canary.smithers.sh, where that made `/api/agent/turn` a world-reachable spend.
 *
 * When IDENTITY_UPSTREAM_URL is unset there is no seam that could authenticate
 * anyone (the local dev/stub stack, the e2e), so the gate stays out of the way.
 */
const requireTurnSession = async (
  request: Request,
  env: WorkerEnv
): Promise<Response | ValidatedIdentity | undefined> => {
  const upstream = env.IDENTITY_UPSTREAM_URL?.trim()
  if (upstream === undefined || upstream === "") return undefined
  const validation = await validateSession(request, env)
  if (validation.status === "unavailable") return validation.response
  if (validation.status === "invalid") {
    return json(401, { status: "error", message: "Sign in to run a Smithers turn." })
  }
  const session = validation.identity
  if (!session.allowlisted) {
    return json(403, {
      status: "error",
      message: "This account is not in the closed-alpha allowlist yet."
    })
  }
  return session
}

/**
 * Billing reads dollars for one authenticated account. Wave 13: a SIGNED-IN
 * user reads their OWN account through the wave-5 trusted-caller path — the
 * proxy strips every client-supplied identity claim (a browser must never pick
 * the account), validates the session against identity, and authenticates to
 * billing with `x-smithers-service-token: <BILLING_PRODUCT_SERVICE_TOKEN>` +
 * `x-user-login: <validated login>` (workers/billing keys the account by that
 * login). The deployment-wide bearer is NEVER sent alongside: billing's
 * bearer-wins rule would silently re-key the read to the shared account, which
 * is exactly the D-1/D-2/A-5 defect this path closes.
 *
 * The deployment bearer remains only as the signed-out/native fallback: with no
 * identity seam (local dev, the native shell) there is no session to vouch for,
 * so the bearer authenticates the deployment account it always did. A signed-in
 * request with no service token configured is an honest 501 — never a silent
 * fall back onto the shared account.
 */
const proxyToBilling = async (request: Request, env: WorkerEnv): Promise<Response> => {
  const upstream = env.BILLING_UPSTREAM_URL?.trim()
  if (upstream === undefined || upstream === "") {
    return notConfigured("The billing seam", "BILLING_UPSTREAM_URL is unset. Balance is unavailable")
  }
  const url = new URL(request.url)
  const target = new URL(url.pathname + url.search, upstream)
  const headers = new Headers(request.headers)
  for (const name of STRIPPED_IDENTITY_HEADERS) headers.delete(name)

  const validation = await validateSession(request, env)
  if (validation.status === "unavailable") return validation.response
  if (validation.status === "valid") {
    const session = validation.identity
    const serviceToken = env.BILLING_PRODUCT_SERVICE_TOKEN?.trim()
    if (serviceToken === undefined || serviceToken === "") {
      return notConfigured(
        "The billing seam",
        "BILLING_PRODUCT_SERVICE_TOKEN is unset. A signed-in user's balance reads through the trusted-caller path; without it the seam could only bill the shared deployment account, so it says so instead"
      )
    }
    headers.set("x-smithers-service-token", serviceToken)
    headers.set("x-user-login", session.login)
    headers.set("x-user-id", session.login)
    headers.set("x-user-role", session.admin ? "admin" : "member")
    if (session.scopes.length > 0) headers.set("x-user-scopes", session.scopes.join(" "))
  } else {
    if (env.IDENTITY_UPSTREAM_URL?.trim()) {
      return json(401, {
        status: "error",
        message: "Sign in before reading your balance — the identity service did not validate a session."
      })
    }
    const bearer = env.BILLING_AUTH_TOKEN?.trim()
    if (bearer === undefined || bearer === "") {
      return notConfigured(
        "The billing seam",
        "BILLING_AUTH_TOKEN is unset. Billing authenticates the account with a Smithers Cloud user bearer, and no other credential opens it"
      )
    }
    headers.set("authorization", `Bearer ${bearer}`)
  }
  withProxyOrigin(headers, url)
  return forwardUnderDeadline(
    "The billing service",
    new Request(target.toString(), new Request(request, { headers })),
    upstreamTimeoutMs(env)
  )
}

/*
 * The canonical unknown-route answer. The admin surface is non-enumerable
 * (Launch Checklist §E): a non-admin — or signed-out — caller probing
 * /api/admin/* gets EXACTLY this response, byte-identical to any other
 * unknown /api/* route. Never 401, never 403, never a different shape.
 */
const notFound = (): Response => json(404, { status: "error", message: "Not found." })

/** Forward an admin upstream call, passing the upstream status and body through verbatim. */
const forwardAdminCall = async (
  upstream: string,
  path: string,
  adminToken: string,
  init: { method: string; body?: unknown }
): Promise<Response> => {
  const headers: Record<string, string> = { "x-smithers-admin-token": adminToken }
  if (init.body !== undefined) headers["content-type"] = "application/json"
  let response: Response
  try {
    response = await withDeadline("The admin upstream", (signal) =>
      fetch(new URL(path, upstream).toString(), {
        method: init.method,
        headers,
        signal,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
      }))
  } catch (error) {
    return upstreamUnreachable("The admin upstream", error)
  }
  const text = await response.text()
  return new Response(text, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json", ...ISOLATION_HEADERS }
  })
}

const adminTokenNotConfigured = (name: string, envName: string): Response =>
  notConfigured(name, `${envName} is unset. The admin surface is unavailable on this deployment`)

interface AdminServiceHealth {
  readonly name: string
  readonly status: "ok" | "failed" | "unconfigured"
  readonly detail: string
}

/** One honest per-service line for admin.health — a real healthz read or the truth about why not. */
const readServiceHealth = async (
  name: string,
  upstream: string | undefined,
  envName: string,
  summarize: (body: Record<string, unknown>) => string
): Promise<AdminServiceHealth> => {
  const base = upstream?.trim()
  if (base === undefined || base === "") {
    return { name, status: "unconfigured", detail: `${envName} is unset on this deployment.` }
  }
  let response: Response
  try {
    response = await withDeadline(name, (signal) => fetch(new URL("/healthz", base).toString(), { signal }))
  } catch (error) {
    return {
      name,
      status: "failed",
      detail: error instanceof UpstreamTimeoutError
        ? `healthz did not answer within ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)}s.`
        : `unreachable: ${error instanceof Error ? error.message : "unknown error"}`
    }
  }
  if (!response.ok) {
    await response.body?.cancel()
    return { name, status: "failed", detail: `healthz answered HTTP ${response.status}.` }
  }
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
  if (body === undefined) return { name, status: "failed", detail: "healthz did not return JSON." }
  if (body.ok !== true) return { name, status: "failed", detail: "healthz reported not ok." }
  return { name, status: "ok", detail: summarize(body) }
}

/**
 * "What failed overnight?" v1: compose the health card's facts from real
 * reads — each sibling's /healthz, the billing ledger's charge totals, and
 * the request-access queue depth. A service that cannot be read says so;
 * nothing is invented.
 */
const handleAdminHealth = async (env: WorkerEnv, proxyOrigin: string): Promise<Response> => {
  const summarize = (...fields: ReadonlyArray<string>) => (body: Record<string, unknown>): string => {
    const parts = fields
      .filter((field) => body[field] !== undefined)
      .map((field) => `${field}: ${JSON.stringify(body[field])}`)
    return parts.length === 0 ? "healthz ok." : `healthz ok — ${parts.join(" · ")}`
  }
  const [billing, identity] = await Promise.all([
    readServiceHealth(
      "billing",
      env.BILLING_UPSTREAM_URL,
      "BILLING_UPSTREAM_URL",
      summarize("rateCardVersion", "resources", "unpricedActiveResources")
    ),
    readServiceHealth(
      "identity",
      env.IDENTITY_UPSTREAM_URL,
      "IDENTITY_UPSTREAM_URL",
      summarize("requestedScopes", "admin", "serviceToken")
    )
  ])

  /*
   * Recent charges: the billing ledger's own totals, read with the account
   * bearer — which authenticates the DEPLOYMENT's billing account, not the
   * fleet. Since wave 13 a signed-in user's turn is metered onto that user's
   * own account, so this figure stopped moving and is smaller than a single
   * active user's (repro apps/ui/canary-repros/admin/25.7). Billing keeps one
   * Durable Object per login with no enumeration, so no fleet total can be
   * read from here at all; the answer therefore STATES its scope instead of
   * presenting a deployment figure as a fleet one.
   */
  let charges: {
    chargeCount: number
    lifetimeChargedUsd: string
    scope: string
    scopeDetail: string
  } | null = null
  const billingBase = env.BILLING_UPSTREAM_URL?.trim()
  const bearer = env.BILLING_AUTH_TOKEN?.trim()
  if (billingBase !== undefined && billingBase !== "" && bearer !== undefined && bearer !== "") {
    try {
      // Billing refuses a request that carries no Origin, so the read states
      // this Worker's own — the same seam discipline as the billing proxy.
      const balance = await withDeadline(
        "billing",
        (signal) =>
          fetch(new URL("/api/billing/balance", billingBase).toString(), {
            headers: { authorization: `Bearer ${bearer}`, origin: proxyOrigin },
            signal
          })
      )
      if (balance.ok) {
        const body = (await balance.json()) as {
          balance?: { chargeCount?: unknown; lifetimeChargedUsd?: unknown }
        }
        if (
          typeof body.balance?.chargeCount === "number" &&
          typeof body.balance.lifetimeChargedUsd === "string"
        ) {
          charges = {
            chargeCount: body.balance.chargeCount,
            lifetimeChargedUsd: body.balance.lifetimeChargedUsd,
            scope: "deployment-account",
            scopeDetail:
              "charge rows on the deployment's own billing account. Signed-in users' turns meter onto their own accounts, so this is not a fleet total and it is not a turn count."
          }
        }
      } else {
        await balance.body?.cancel()
      }
    } catch {
      // charges stays null — the card says "no charge read" rather than inventing one.
    }
  }

  // Request-queue depth: the identity admin read, or null when it can't be had.
  let queueDepth: number | null = null
  const identityBase = env.IDENTITY_UPSTREAM_URL?.trim()
  const identityAdmin = env.IDENTITY_ADMIN_TOKEN?.trim()
  if (identityBase !== undefined && identityBase !== "" && identityAdmin !== undefined && identityAdmin !== "") {
    try {
      const queue = await fetch(new URL("/api/identity/admin/requests", identityBase).toString(), {
        headers: { "x-smithers-admin-token": identityAdmin }
      })
      if (queue.ok) {
        const body = (await queue.json()) as { requests?: unknown }
        if (Array.isArray(body.requests)) queueDepth = body.requests.length
      } else {
        await queue.body?.cancel()
      }
    } catch {
      // queueDepth stays null — honest absence, not a zero.
    }
  }

  return json(200, {
    services: [billing, identity],
    charges,
    queueDepth,
    checkedAt: new Date().toISOString()
  })
}

const parseAdminBody = async (request: Request): Promise<Record<string, unknown> | Response> => {
  let body: unknown
  try {
    body = await readTurnBody(request)
  } catch (error) {
    return json(error instanceof BodyTooLargeError ? 413 : 400, {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid request."
    })
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json(400, { status: "error", message: "Body must be a JSON object." })
  }
  return body as Record<string, unknown>
}

/**
 * The admin plugin's server half (Launch Checklist §E). Every /api/admin/*
 * route FIRST validates the session through identity and requires BOTH
 * admin:true and allowlisted:true; anything else gets the canonical 404,
 * byte-identical to an unknown route. Admin writes carry their audit
 * attribution at write time: requester is the admin's own validated login and
 * the timestamp is fresh — the siblings refuse unattributed writes by contract.
 *
 * Allowlisted is part of the gate because removing a login from the
 * closed-alpha allowlist has to revoke something. It did not: `admin` comes
 * from identity's ADMIN_LOGINS var, so a de-allowlisted admin kept the whole
 * surface — including POST /api/admin/allowlist, the door that edits the
 * allowlist itself (repro apps/ui/canary-repros/access/1.5). Identity now
 * withholds the claim from a non-allowlisted login too; this check is the
 * second half of that fix, so the product Worker refuses on its own evidence
 * rather than trusting one upstream field.
 */
const handleAdmin = async (request: Request, env: WorkerEnv, url: URL): Promise<Response> => {
  const validation = await validateSession(request, env)
  if (validation.status === "unavailable") return validation.response
  if (validation.status === "invalid") return notFound()
  const session = validation.identity
  if (!session.admin || !session.allowlisted) return notFound()

  if (url.pathname === ADMIN_ALLOWLIST_PATH && request.method === "POST") {
    const upstream = env.IDENTITY_UPSTREAM_URL?.trim()
    if (upstream === undefined || upstream === "") {
      return notConfigured("The identity seam", "IDENTITY_UPSTREAM_URL is unset. The allowlist is unavailable")
    }
    const token = env.IDENTITY_ADMIN_TOKEN?.trim()
    if (token === undefined || token === "") {
      return adminTokenNotConfigured("The identity admin surface", "IDENTITY_ADMIN_TOKEN")
    }
    const body = await parseAdminBody(request)
    if (body instanceof Response) return body
    const login = typeof body.login === "string" ? body.login.trim() : ""
    const action = body.action
    if (login === "" || (action !== "add" && action !== "remove")) {
      return json(400, { status: "error", message: "Body must be { login, action: \"add\" | \"remove\" }." })
    }
    /*
     * An admin cannot remove its own login. Now that being allowlisted is
     * what carries admin, a self-removal is a one-way door: it revokes the
     * session's admin claim, and the only door that could undo it is this
     * one. The first caller to try it would lock the closed alpha's admin
     * surface out of the product with no in-app way back — the operator's
     * ADMIN_SERVICE_TOKEN would be the only remaining route. Refuse, and
     * name the route that does work.
     */
    if (action === "remove" && login.toLowerCase() === session.login.toLowerCase()) {
      return json(409, {
        status: "error",
        message:
          "You can't remove your own login from the allowlist: it would revoke your admin access through the only door that could restore it. Ask another admin to remove you, or use the identity worker's admin token."
      })
    }
    return forwardAdminCall(upstream, "/api/identity/admin/allowlist", token, {
      method: "POST",
      body: { login, action, requester: session.login, timestamp: new Date().toISOString() }
    })
  }

  if (url.pathname === ADMIN_GRANT_PATH && request.method === "POST") {
    const upstream = env.BILLING_UPSTREAM_URL?.trim()
    if (upstream === undefined || upstream === "") {
      return notConfigured("The billing seam", "BILLING_UPSTREAM_URL is unset. Grants are unavailable")
    }
    const token = env.BILLING_ADMIN_TOKEN?.trim()
    if (token === undefined || token === "") {
      return adminTokenNotConfigured("The billing admin surface", "BILLING_ADMIN_TOKEN")
    }
    const body = await parseAdminBody(request)
    if (body instanceof Response) return body
    const login = typeof body.login === "string" ? body.login.trim() : ""
    const amountUsd = typeof body.amountUsd === "number" ? body.amountUsd : Number.NaN
    if (login === "" || !Number.isFinite(amountUsd) || amountUsd <= 0) {
      return json(400, { status: "error", message: "Body must be { login, amountUsd } with a positive dollar amount." })
    }
    // A fresh grant id per confirmed request; the sibling is idempotent by it.
    const grantId = `admin:product-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
    return forwardAdminCall(upstream, "/api/billing/admin/grants", token, {
      method: "POST",
      body: {
        userId: login,
        grantId,
        amountUsd,
        kind: "promotional",
        requester: session.login,
        timestamp: new Date().toISOString()
      }
    })
  }

  if (url.pathname === ADMIN_REQUESTS_PATH && request.method === "GET") {
    const upstream = env.IDENTITY_UPSTREAM_URL?.trim()
    if (upstream === undefined || upstream === "") {
      return notConfigured("The identity seam", "IDENTITY_UPSTREAM_URL is unset. The request queue is unavailable")
    }
    const token = env.IDENTITY_ADMIN_TOKEN?.trim()
    if (token === undefined || token === "") {
      return adminTokenNotConfigured("The identity admin surface", "IDENTITY_ADMIN_TOKEN")
    }
    return forwardAdminCall(upstream, "/api/identity/admin/requests", token, { method: "GET" })
  }

  if (url.pathname === ADMIN_HEALTH_PATH && request.method === "GET") {
    return handleAdminHealth(env, url.origin)
  }

  // The client-error log, newest first. No upstream and no admin token: the
  // reports are this Worker's own state, so this is a local read, and it
  // answers an empty log honestly rather than 404ing when nothing has broken.
  if (url.pathname === ADMIN_ERRORS_PATH && request.method === "GET") {
    const asked = Number(url.searchParams.get("limit") ?? "")
    const limit = Number.isInteger(asked) && asked > 0 ? asked : undefined
    const log = await readClientErrors(env.CLIENT_ERRORS, limit)
    return json(200, {
      status: "ok",
      total: log.total,
      reports: log.reports,
      ...(env.CLIENT_ERRORS === undefined
        ? { note: "No CLIENT_ERRORS binding on this deployment: nothing is stored, so this log is always empty." }
        : {})
    })
  }

  // An admin-only path this Worker does not implement is still just not found.
  return notFound()
}

/*
 * Wave 11 — "make me a workflow": the per-user gateway seam, live.
 *
 * The browser drives /api/workflow/*; the Worker resolves the caller's
 * session, mints (or reuses) their Smithers Cloud identity through the
 * identity worker's cloud-token door, provisions-or-resumes the workspace
 * gateway for a WATCHED repo (the watched set is the universe — the client
 * routes anything outside it to the chooser), and relays RPC/event calls
 * with the gateway token it alone holds.
 */

/*
 * owner/repo — the shape the Cloud provision route takes; anything else (a dot
 * segment that URL parsing would resolve away included) is refused pre-upstream
 * by `isRelayRepoName`.
 */

/**
 * The workflow seam spends the user's own workspace resources, so on any
 * deployment that HAS an identity seam it requires a validated, allowlisted
 * session — the same gate as a turn. Returns the validated identity or the
 * refusal response.
 */
const requireWorkflowSession = async (
  request: Request,
  env: WorkerEnv
): Promise<ValidatedIdentity | Response> => {
  const upstream = env.IDENTITY_UPSTREAM_URL?.trim()
  if (upstream === undefined || upstream === "") {
    return notConfigured(
      "The workflow seam",
      "IDENTITY_UPSTREAM_URL is unset. The per-user gateway needs a validated session, and no identity service can provide one"
    )
  }
  const validation = await validateSession(request, env)
  if (validation.status === "unavailable") return validation.response
  if (validation.status === "invalid") {
    return json(401, { status: "error", message: "Sign in to run workflows on your workspace." })
  }
  const session = validation.identity
  if (!session.allowlisted) {
    return json(403, {
      status: "error",
      message: "This account is not in the closed-alpha allowlist yet."
    })
  }
  return session
}

/** The typed, non-gateway answers a gateway call can produce, in one place. */
const gatewayCallResponse = (call: Awaited<ReturnType<typeof callGateway>>): Response => {
  if (call.status === "ok") return call.response
  if (call.status === "provisioning") return json(200, { status: "provisioning", message: call.detail })
  if (call.status === "no_capacity") return json(200, { status: "no-capacity", message: call.detail })
  if (call.status === "no_cloud_token") return json(200, { status: "no-cloud-identity", message: call.detail })
  if (call.status === "no_cloud_repo") return json(200, { status: "no-cloud-repo", message: call.detail })
  return json(502, { status: "error", message: call.detail })
}

const parseWorkflowRepo = (value: unknown): string | undefined =>
  typeof value === "string" && isRelayRepoName(value) ? value : undefined

const handleWorkflowProvision = async (request: Request, env: WorkerEnv): Promise<Response> => {
  const session = await requireWorkflowSession(request, env)
  if (session instanceof Response) return session
  let body: unknown
  try {
    body = await readTurnBody(request)
  } catch (error) {
    return json(error instanceof BodyTooLargeError ? 413 : 400, {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid request."
    })
  }
  const repo = typeof body === "object" && body !== null && "repo" in body
    ? parseWorkflowRepo((body as { repo?: unknown }).repo)
    : undefined
  if (repo === undefined) {
    return json(400, { status: "error", message: "Body must be { repo } as owner/repo." })
  }
  const outcome = await ensureGateway(env, session.login, repo)
  switch (outcome.status) {
    case "ready":
      // The token NEVER leaves the server: the answer names the gateway and
      // its re-resolve cadence, nothing more.
      return json(200, {
        status: "ready",
        repo,
        gatewayId: outcome.record.gatewayId,
        expiresAt: new Date(outcome.record.expiresAt).toISOString()
      })
    case "provisioning":
      return json(200, { status: "provisioning", message: outcome.detail })
    case "no_capacity":
      return json(200, { status: "no-capacity", message: outcome.detail })
    case "no_cloud_token":
      return json(200, { status: "no-cloud-identity", message: outcome.detail })
    case "no_cloud_repo":
      // §4: a watched repo with no Cloud counterpart — a state of its own.
      return json(200, { status: "no-cloud-repo", message: outcome.detail })
    default:
      return json(502, { status: "error", message: outcome.detail })
  }
}

const handleWorkflowRpc = async (request: Request, env: WorkerEnv): Promise<Response> => {
  const session = await requireWorkflowSession(request, env)
  if (session instanceof Response) return session
  let body: unknown
  try {
    body = await readTurnBody(request)
  } catch (error) {
    return json(error instanceof BodyTooLargeError ? 413 : 400, {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid request."
    })
  }
  const candidate = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined
  const repo = parseWorkflowRepo(candidate?.repo)
  const method = typeof candidate?.method === "string" ? candidate.method : ""
  if (repo === undefined || method === "") {
    return json(400, { status: "error", message: "Body must be { repo, method, params? }." })
  }
  if (!ALLOWED_GATEWAY_METHODS.includes(method)) {
    return json(400, { status: "error", message: `The workflow seam does not relay ${method}.` })
  }
  const call = await callGateway(env, session.login, repo, `/v1/rpc/${method}`, {
    method: "POST",
    body: candidate?.params ?? {},
    replayable: !NON_REPLAYABLE_GATEWAY_METHODS.includes(method)
  })
  if (call.status !== "ok") return gatewayCallResponse(call)
  // The gateway's own frame passes through verbatim (ok/payload or ok/error).
  const text = await call.response.text()
  return new Response(text, {
    status: call.response.status,
    headers: {
      "content-type": call.response.headers.get("content-type") ?? "application/json",
      ...ISOLATION_HEADERS
    }
  })
}

const handleWorkflowEvents = async (request: Request, env: WorkerEnv, url: URL): Promise<Response> => {
  const session = await requireWorkflowSession(request, env)
  if (session instanceof Response) return session
  const repo = parseWorkflowRepo(url.searchParams.get("repo") ?? undefined)
  const runId = url.searchParams.get("runId") ?? ""
  if (repo === undefined || runId === "") {
    return json(400, { status: "error", message: "Query must carry repo and runId." })
  }
  const afterSeqRaw = url.searchParams.get("afterSeq")
  const afterSeq = afterSeqRaw === null ? undefined : Number(afterSeqRaw)
  if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
    return json(400, { status: "error", message: "afterSeq must be a non-negative integer." })
  }
  const limitRaw = Number(url.searchParams.get("limit") ?? "200")
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 200
  const call = await callGateway(
    env,
    session.login,
    repo,
    `/v1/api/runs/${encodeURIComponent(runId)}/events?limit=${limit}${
      afterSeq === undefined ? "" : `&afterSeq=${afterSeq}`
    }`,
    { method: "GET" }
  )
  if (call.status !== "ok") return gatewayCallResponse(call)
  const text = await call.response.text()
  return new Response(text, {
    status: call.response.status,
    headers: {
      "content-type": call.response.headers.get("content-type") ?? "application/json",
      ...ISOLATION_HEADERS
    }
  })
}

/**
 * The relay SSE change stream, proxied end-to-end (Wave 11 streaming): the
 * Worker holds the token and forwards Last-Event-ID, so a browser EventSource
 * reconnect replays through the relay exactly like a native client. The 600s
 * relay cap makes stream loss ROUTINE — the client treats reconnect as normal.
 */
const handleWorkflowStream = async (request: Request, env: WorkerEnv, url: URL): Promise<Response> => {
  const session = await requireWorkflowSession(request, env)
  if (session instanceof Response) return session
  const repo = parseWorkflowRepo(url.searchParams.get("repo") ?? undefined)
  if (repo === undefined) {
    return json(400, { status: "error", message: "Query must carry repo." })
  }
  const lastEventId = request.headers.get("last-event-id")
  const call = await callGateway(env, session.login, repo, "/v1/api/stream", {
    method: "GET",
    headers: lastEventId === null ? {} : { "last-event-id": lastEventId }
  })
  if (call.status !== "ok") return gatewayCallResponse(call)
  if (call.response.body === null) {
    return json(502, { status: "error", message: "The gateway stream had no body." })
  }
  return new Response(call.response.body, {
    status: call.response.status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      ...ISOLATION_HEADERS
    }
  })
}

interface ApprovalDecisionBody {
  readonly runId: string
  readonly nodeId: string
  readonly iteration: number
  readonly decision: { readonly approved: boolean; readonly note?: string }
  /** Wave 11: the watched repo whose per-user gateway runs the run. */
  readonly repo?: string
}

const parseApprovalDecision = (body: unknown): ApprovalDecisionBody | undefined => {
  if (typeof body !== "object" || body === null) return undefined
  const candidate = body as Record<string, unknown>
  const decision = candidate.decision
  if (
    typeof candidate.runId !== "string" ||
    candidate.runId === "" ||
    typeof candidate.nodeId !== "string" ||
    candidate.nodeId === "" ||
    typeof candidate.iteration !== "number" ||
    !Number.isInteger(candidate.iteration) ||
    candidate.iteration < 0 ||
    typeof decision !== "object" ||
    decision === null ||
    typeof (decision as Record<string, unknown>).approved !== "boolean"
  ) {
    return undefined
  }
  const note = (decision as Record<string, unknown>).note
  return {
    runId: candidate.runId,
    nodeId: candidate.nodeId,
    iteration: candidate.iteration,
    decision: {
      approved: (decision as { approved: boolean }).approved,
      ...(typeof note === "string" ? { note } : {})
    },
    ...(typeof candidate.repo === "string" && isRelayRepoName(candidate.repo)
      ? { repo: candidate.repo }
      : {})
  }
}

/**
 * The approval round trip (Wave 2a): the client's decision forwards to the
 * gateway upstream's submitApproval RPC with the seam's identity injection.
 * The upstream echo is returned verbatim — the client freezes its card from
 * that echo, never from its own optimism.
 */
const handleApprovalDecision = async (request: Request, env: WorkerEnv): Promise<Response> => {
  let body: unknown
  try {
    body = await readTurnBody(request)
  } catch (error) {
    return json(error instanceof BodyTooLargeError ? 413 : 400, {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid request."
    })
  }
  const decision = parseApprovalDecision(body)
  if (decision === undefined) {
    return json(400, {
      status: "error",
      message: "Body must be { runId, nodeId, iteration, decision: { approved, note? } }."
    })
  }

  /*
   * Wave 11: a decision that names its repo round-trips through the
   * caller's per-user gateway (the relay path the run actually lives on).
   * The static GATEWAY_UPSTREAM_URL mode stays for the local stub stack.
   */
  if (decision.repo !== undefined) {
    const session = await requireWorkflowSession(request, env)
    if (session instanceof Response) return session
    const call = await callGateway(env, session.login, decision.repo, "/v1/rpc/submitApproval", {
      method: "POST",
      body: {
        runId: decision.runId,
        nodeId: decision.nodeId,
        iteration: decision.iteration,
        decision: decision.decision
      },
      // Keyed by (runId, nodeId, iteration): the same decision, twice, is
      // the same decision — safe to replay onto a resumed gateway.
      replayable: true
    })
    if (call.status !== "ok") return gatewayCallResponse(call)
    /*
     * The relayed gateway answers the RPC envelope ({ ok, payload }) while
     * this route's contract — the static seam's, which the client freezes
     * the card from — is the flat decision echo ({ runId, nodeId,
     * iteration, approved }). Pass the envelope through untouched and the
     * client reads a top-level `approved` that is never there: the decision
     * IS recorded (a retry proves it with 409 AlreadyDecided), the run
     * resumes, and the card still reports "the engine did not echo the
     * decision" — the live F-6 failure of waves 13b/14b. Unwrap the success
     * frame here so both seams answer the same shape; anything that is not
     * the success frame passes through verbatim.
     */
    const text = await call.response.text()
    let frame: { ok?: unknown; payload?: unknown } | undefined
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === "object" && parsed !== null) {
        frame = parsed as { ok?: unknown; payload?: unknown }
      }
    } catch {
      frame = undefined
    }
    if (
      call.response.status === 200 &&
      frame !== undefined &&
      frame.ok === true &&
      typeof frame.payload === "object" &&
      frame.payload !== null
    ) {
      return json(200, frame.payload)
    }
    return new Response(text, {
      status: call.response.status,
      headers: {
        "content-type": call.response.headers.get("content-type") ?? "application/json",
        ...ISOLATION_HEADERS
      }
    })
  }

  const upstream = env.GATEWAY_UPSTREAM_URL?.trim()
  if (upstream === undefined || upstream === "") return gatewayNotConfigured()
  const identity = gatewayIdentityHeaders(env)
  if (identity instanceof Response) return identity

  let response: Response
  try {
    response = await fetch(new URL("/v1/rpc/submitApproval", upstream).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", ...identity },
      body: JSON.stringify(decision)
    })
  } catch (error) {
    return json(502, {
      status: "error",
      message: `The engine gateway is unreachable: ${error instanceof Error ? error.message : "unknown error"}`
    })
  }
  const text = await response.text()
  return new Response(text, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json", ...ISOLATION_HEADERS }
  })
}

const isApiRoute = (pathname: string): boolean => pathname.startsWith("/api/") || isGatewayRoute(pathname)

/*
 * The browser tool's fetch route (Wave 10, §2d): server-side, hard-guarded
 * (https only, public hosts only after DNS resolution, size cap, timeout, no
 * cookies, declared user-agent). Session-gated exactly like a turn — the
 * deployment's network egress is a resource — and read-tier: it changes
 * nothing upstream.
 */
const handleBrowserFetch = async (request: Request): Promise<Response> => {
  let body: unknown
  try {
    body = await readTurnBody(request)
  } catch (error) {
    return json(error instanceof BodyTooLargeError ? 413 : 400, {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid request."
    })
  }
  const url = typeof body === "object" && body !== null && "url" in body && typeof body.url === "string"
    ? body.url
    : undefined
  if (url === undefined || url.trim() === "") {
    return json(400, { status: "error", message: "Body must be { url }." })
  }
  const outcome = await browserFetch(url.trim(), { resolveHost: resolveHostOverHttps })
  return json(outcome.ok ? 200 : 422, browserFetchResponseBody(outcome))
}

/**
 * Same-origin guard for the API surface. These routes spend the deployment's
 * own credentials — `/api/approvals/decision` submits a decision under the
 * seam's injected identity — and a `text/plain` or form POST from another site
 * is not preflighted, so nothing else would stop a page anywhere from driving
 * them. Requests without an `Origin` (same-origin GETs, top-level OAuth
 * navigation, curl, the e2e) are untouched.
 */
const isCrossOriginRequest = (request: Request, url: URL): boolean => {
  const origin = request.headers.get("origin")
  return origin !== null && origin !== url.origin
}

/*
 * The curated platform proxy (MULTI-ACTIONS-GAP.md Tier 1/2): the browser
 * calls these paths same-origin; the Worker validates the session, mints the
 * user's own Smithers Cloud token (the same per-user door the gateway seam
 * uses), and forwards with that bearer. An ALLOWLIST, never a wildcard —
 * every proxied family is one the product ships commands for. Note
 * /api/billing/checkout|portal are EXACT matches routed to the platform's
 * Stripe seam; the rest of /api/billing/* stays with the product billing
 * worker below.
 */
const PLATFORM_PROXY_RULES: ReadonlyArray<{
  readonly prefix?: string
  readonly exact?: string
  readonly methods: ReadonlyArray<string>
}> = [
  { prefix: "/api/repos/", methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  { prefix: "/api/github/import", methods: ["GET", "POST"] },
  /* Source-only repo metadata (import-readiness fallback): reads only. */
  { prefix: "/api/user/github-repos/", methods: ["GET"] },
  { prefix: "/api/user/byok-keys", methods: ["GET", "POST", "DELETE"] },
  { prefix: "/api/notifications/", methods: ["GET", "PUT"] },
  { exact: "/api/billing/checkout", methods: ["POST"] },
  { exact: "/api/billing/portal", methods: ["POST"] }
]

/*
 * The closed alpha exposes no top-up, checkout, or card-collection flow: every
 * account's balance is comped. Both Stripe routes stayed live anyway, so
 * `/billing.upgrade` on an MVP account fired a real POST and came back the
 * platform's `stripe billing is not configured` (repro
 * apps/ui/canary-repros/money/17.4). A configuration string is not an answer to
 * "upgrade my plan", and a live checkout call is not something an MVP account
 * should be able to make at all.
 *
 * Set BILLING_CHECKOUT_ENABLED=1 on the deployment where paid plans ship; the
 * routes then forward exactly as before.
 */
const CHECKOUT_PATHS: ReadonlyArray<string> = ["/api/billing/checkout", "/api/billing/portal"]

const checkoutEnabled = (env: WorkerEnv): boolean => env.BILLING_CHECKOUT_ENABLED?.trim() === "1"

const PLATFORM_PROXY_MAX_BODY = 256 * 1024

/*
 * Families the Smithers Cloud platform does not implement. The proxy used to
 * forward them anyway and hand the browser the Go router's own plain-text
 * `404 page not found`, which the product rendered verbatim into a user's
 * toast (repro apps/ui/canary-repros/admin/28.5) and to the console as a 404
 * on every ordinary session (repro admin/28.12). Neither told the user
 * anything. An honest 501 that names the state is the contract the rest of
 * this Worker already keeps for a seam it cannot serve.
 *
 * A row here is a statement about the PLATFORM, not about this Worker: delete
 * the row the day the upstream route ships and the forward resumes unchanged.
 */
const PLATFORM_UNIMPLEMENTED: ReadonlyArray<{ readonly prefix: string; readonly message: string }> = [
  {
    prefix: "/api/user/byok-keys",
    message:
      "Bring-your-own provider keys aren't part of this preview. Smithers Cloud has no key store yet, so there is nothing to list, add, or remove — turns run on the included allowance instead."
  }
]

const platformUnimplemented = (pathname: string): string | undefined =>
  PLATFORM_UNIMPLEMENTED.find((rule) => pathname.startsWith(rule.prefix))?.message

/**
 * What to tell a reader when Smithers Cloud refuses. The upstream's own body is
 * used only when it carries prose; a router's plain-text 404 or an HTML error
 * page is replaced by a sentence, never forwarded.
 */
const platformFailureMessage = (status: number, body: string): string => {
  const prose = upstreamProse(body)
  if (prose !== undefined) return prose
  if (status === 404) return "Smithers Cloud doesn't serve that request on this deployment."
  if (status === 401 || status === 403) return "Smithers Cloud refused that request for your account."
  if (status === 429) return "Smithers Cloud is rate-limiting this account right now. Try again in a minute."
  if (status >= 500) return `Smithers Cloud is having trouble right now (HTTP ${status}).`
  return `Smithers Cloud refused that request (HTTP ${status}).`
}

/*
 * Frontend error ingest (multi's /api/client-errors, minimal form): bounded
 * body, per-isolate rate limit, logged to the worker tail — enough to stop
 * flying blind on client crashes in the alpha without storing anything.
 */
const CLIENT_ERRORS_PATH = "/api/client-errors"
const CLIENT_ERROR_MAX_BODY = 16 * 1024
const CLIENT_ERROR_WINDOW_MS = 60_000
const CLIENT_ERROR_WINDOW_MAX = 120
let clientErrorWindow = { start: 0, count: 0 }

const handleClientError = async (request: Request, env: WorkerEnv): Promise<Response> => {
  const now = Date.now()
  if (now - clientErrorWindow.start > CLIENT_ERROR_WINDOW_MS) {
    clientErrorWindow = { start: now, count: 0 }
  }
  clientErrorWindow.count += 1
  if (clientErrorWindow.count > CLIENT_ERROR_WINDOW_MAX) {
    return json(429, { status: "error", message: "Too many error reports." })
  }
  const body = await request.arrayBuffer()
  if (body.byteLength > CLIENT_ERROR_MAX_BODY) {
    return json(413, { status: "error", message: "Error report too large." })
  }
  const text = new TextDecoder().decode(body)
  console.error("client-error:", text)
  // console.error alone lives exactly as long as someone is tailing. The log
  // is what makes an alpha user's crash readable afterwards, through
  // GET /api/admin/errors; it is bounded and it never fails the report.
  const referer = request.headers.get("referer")
  const userAgent = request.headers.get("user-agent")
  await appendClientError(env.CLIENT_ERRORS, {
    at: new Date(now).toISOString(),
    ...(referer === null ? {} : { page: referer }),
    ...(userAgent === null ? {} : { userAgent }),
    report: ((): unknown => {
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    })()
  })
  return json(202, { status: "accepted" })
}

const platformProxyMatch = (pathname: string, method: string): boolean =>
  PLATFORM_PROXY_RULES.some(
    (rule) =>
      rule.methods.includes(method) &&
      (rule.exact !== undefined ? pathname === rule.exact : pathname.startsWith(rule.prefix ?? " "))
  )

const handlePlatformProxy = async (request: Request, env: WorkerEnv, url: URL): Promise<Response> => {
  const gate = await requireTurnSession(request, env)
  if (gate instanceof Response) return gate
  if (gate === undefined) {
    // No identity seam on this deployment (local dev/stub): the honest state,
    // not a 404 — the client renders the message as-is.
    return json(503, {
      status: "error",
      message: "Repository actions need the identity seam, which this deployment does not have."
    })
  }
  if (CHECKOUT_PATHS.includes(url.pathname) && !checkoutEnabled(env)) {
    return json(501, {
      status: "error",
      message:
        "There is nothing to buy during the closed alpha: your balance is comped, so there is no checkout and no billing portal. You'll be told before that changes."
    })
  }
  // A doomed forward is not more honest than a refusal, and it costs the user
  // a raw upstream body they cannot read. Refuse before spending the token.
  const unimplemented = platformUnimplemented(url.pathname)
  if (unimplemented !== undefined) return json(501, { status: "error", message: unimplemented })
  const token = await fetchCloudToken(env, gate.login)
  if (token.status !== "ok") {
    return json(503, {
      status: "error",
      message: `Smithers Cloud isn't reachable for your account right now (${token.status}).`
    })
  }
  let body: ArrayBuffer | undefined
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer()
    if (body.byteLength > PLATFORM_PROXY_MAX_BODY) {
      return json(413, { status: "error", message: "Request body too large." })
    }
  }
  const base = env.SMITHERS_CLOUD_API_BASE_URL?.trim() || DEFAULT_CLOUD_API_BASE_URL
  const headers = new Headers({ authorization: `Bearer ${token.token}` })
  const contentType = request.headers.get("content-type")
  if (contentType !== null) headers.set("content-type", contentType)
  const accept = request.headers.get("accept")
  if (accept !== null) headers.set("accept", accept)
  let upstream: Response
  try {
    upstream = await withDeadline(
      "Smithers Cloud",
      (signal) =>
        fetch(new URL(url.pathname + url.search, base).toString(), {
          method: request.method,
          headers,
          signal,
          ...(body === undefined ? {} : { body })
        }),
      upstreamTimeoutMs(env)
    )
  } catch (error) {
    return upstreamUnreachable("Smithers Cloud", error)
  }
  /*
   * A failure never passes through: the upstream's body is written for its
   * own callers, and the product renders whatever comes back straight to the
   * user. Restate it in the seam's own envelope so a reader always gets a
   * sentence, and the shape matches every other refusal this Worker makes.
   */
  if (upstream.status >= 400) {
    const detail = await upstream.text().catch(() => "")
    return json(upstream.status, { status: "error", message: platformFailureMessage(upstream.status, detail) })
  }
  // Status and body pass through; upstream headers do not (no set-cookie, no
  // upstream CORS) — only the content type survives.
  const out = new Headers()
  const upstreamType = upstream.headers.get("content-type")
  if (upstreamType !== null) out.set("content-type", upstreamType)
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

const START_SESSION_HEADER = "x-smithers-start-session"

/** Replace any client-supplied value with the session resolved for the Start branch. */
export const withStartSessionHandoff = async (request: Request, sessionResponse: Response): Promise<Request> => {
  const sessionEnvelope = encodeURIComponent(
    JSON.stringify({ status: sessionResponse.status, body: await sessionResponse.text() })
  )
  const startHeaders = new Headers(request.headers)
  startHeaders.set(START_SESSION_HEADER, sessionEnvelope)
  return new Request(request, { headers: startHeaders })
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url)
    const gatewayBound = isGatewayRoute(url.pathname) || request.headers.get("upgrade") === "websocket"
    if ((isApiRoute(url.pathname) || gatewayBound) && isCrossOriginRequest(request, url)) {
      return json(403, {
        status: "error",
        message: "This API only answers requests from its own origin."
      })
    }
    if (url.pathname === CANCEL_PATH) {
      if (request.method !== "POST") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      const refusal = await requireTurnSession(request, env)
      if (refusal instanceof Response) return refusal
      return handleCancel(request, env)
    }
    // The two routes that spend a model credential. Both gate on the
    // session first and then on the login's turn ceiling, so a refusal
    // costs one Durable Object read and never reaches an upstream. The
    // cancel route above is deliberately unlimited: killing a turn must
    // always work, and it spends nothing.
    if (url.pathname === TURN_PATH) {
      if (request.method !== "POST") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      const gate = await requireTurnSession(request, env)
      if (gate instanceof Response) return gate
      if (gate !== undefined) {
        const budget = await spendTurn(env.TURN_LIMITS, gate.login)
        if (!budget.allowed) return turnLimitResponse(budget, ISOLATION_HEADERS)
      }
      return handleTurn(request, env, gate)
    }
    if (url.pathname === MODEL_STREAM_PATH) {
      if (request.method !== "POST") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      const gate = await requireTurnSession(request, env)
      if (gate instanceof Response) return gate
      if (gate !== undefined) {
        const budget = await spendTurn(env.TURN_LIMITS, gate.login)
        if (!budget.allowed) return turnLimitResponse(budget, ISOLATION_HEADERS)
      }
      return handleModelStream(request, env, gate)
    }
    if (url.pathname === APPROVAL_DECISION_PATH) {
      if (request.method !== "POST") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      return handleApprovalDecision(request, env)
    }
    if (url.pathname === WORKFLOW_PROVISION_PATH) {
      if (request.method !== "POST") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      return handleWorkflowProvision(request, env)
    }
    if (url.pathname === WORKFLOW_RPC_PATH) {
      if (request.method !== "POST") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      return handleWorkflowRpc(request, env)
    }
    if (url.pathname === WORKFLOW_EVENTS_PATH) {
      if (request.method !== "GET") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      return handleWorkflowEvents(request, env, url)
    }
    if (url.pathname === WORKFLOW_STREAM_PATH) {
      if (request.method !== "GET") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      return handleWorkflowStream(request, env, url)
    }
    if (url.pathname === TOOLS_BROWSER_FETCH_PATH) {
      if (request.method !== "POST") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      const refusal = await requireTurnSession(request, env)
      if (refusal instanceof Response) return refusal
      return handleBrowserFetch(request)
    }
    if (
      (url.pathname === AUTH_SIGN_IN_PATH || url.pathname === AUTH_CALLBACK_PATH) &&
      request.method === "GET"
    ) {
      return handleAuthNavigation(request, env, url.pathname === AUTH_SIGN_IN_PATH ? "start" : "callback")
    }
    if (url.pathname === AUTH_SESSION_PATH && request.method === "GET") {
      return probeAuthSession(request, env)
    }
    if (url.pathname.startsWith(AUTH_ROUTE_PREFIX) || url.pathname.startsWith(IDENTITY_ROUTE_PREFIX)) {
      return proxyToIdentity(request, env)
    }
    if (url.pathname === CLIENT_ERRORS_PATH && request.method === "POST") {
      return handleClientError(request, env)
    }
    if (platformProxyMatch(url.pathname, request.method)) {
      return handlePlatformProxy(request, env, url)
    }
    if (url.pathname.startsWith(BILLING_ROUTE_PREFIX)) {
      return proxyToBilling(request, env)
    }
    if (url.pathname.startsWith(ADMIN_ROUTE_PREFIX)) {
      return handleAdmin(request, env, url)
    }
    if (gatewayBound) return proxyToGateway(request, env)
    // Any other /api/* path is an unknown route: the same canonical 404 the
    // admin surface answers non-admins with, so nothing is enumerable.
    if (url.pathname.startsWith("/api/")) return notFound()
    /*
     * Vite replaces this guarded import in the Cloudflare Start build. Bun's
     * unit tests and a plain Wrangler invocation retain the asset fallback,
     * so the API Worker remains importable without Start's virtual manifest.
     */
    if (typeof __SMITHERS_START__ !== "undefined" && __SMITHERS_START__) {
      const { default: start } = await import("@tanstack/react-start/server-entry")
      // Resolve once at the trusted boundary; the server function reads this
      // request header, and a client-supplied value is always overwritten here.
      const sessionRequest = new Request(new URL(AUTH_SESSION_PATH, request.url), request)
      const sessionResponse = await probeAuthSession(sessionRequest, env)
      const response = await start.fetch(await withStartSessionHandoff(request, sessionResponse))
      return withIsolationHeaders(response)
    }
    return withIsolationHeaders(await env.ASSETS.fetch(request))
  }
}
