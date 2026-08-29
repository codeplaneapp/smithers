/**
 * A per-login ceiling on model calls, because every one of them spends model
 * dollars.
 *
 * The unit is ONE CALL TO A MODEL-SPENDING ROUTE, not one thing the user typed.
 * That distinction became load-bearing when the browser Agent Chain became the
 * only chat backend: the loop runs in the page and authors a fresh link over
 * `/api/model/stream` for each step of a turn, bounded at 32 links, so one
 * message can spend many units where the old server-side turn spent exactly
 * one. The ceiling below is sized in those units.
 *
 * Chat is complimentary during the alpha (DESIGN.md §1): a $0 balance never
 * pauses the composer, and the zero-balance guard in the client covers workflow
 * launch, not chat. That is a deliberate product decision and this module does
 * not touch it. What it adds is the thing a comped seam has no other defence
 * against: a runaway client, a stuck retry loop, or a lifted session cookie can
 * post turns as fast as the network allows, and the first anyone would know is
 * the invoice.
 *
 * So this is an ABUSE ceiling, not a billing pause. It sits far above what a
 * person chatting hard reaches in an hour, and its refusal says so — an alpha
 * user who trips it has hit a bug, not a paywall, and must never be told to go
 * buy something.
 *
 * The state is one Durable Object per login, keyed by the validated login only:
 * a client cannot name its own bucket. Fixed windows, not a rolling log — the
 * ceiling is loose enough that the boundary effect (up to 2x across a window
 * edge) does not matter, and one counter is far cheaper than a timestamp list.
 */

/**
 * Model calls one login may start per window.
 *
 * A heavy hour of conversation is about sixty messages, and a chain turn
 * authors a handful of links for each — so sixteen calls a message is already a
 * pessimistic reading of a hard hour. A thousand keeps the same ten-times
 * headroom the ceiling has always had, and still stops a lifted cookie posting
 * as fast as the network allows: at the alpha's rate card a spent window is
 * about a dollar, which is a bug someone notices rather than an invoice nobody
 * saw coming.
 */
export const TURN_WINDOW_MAX = 1000

/** The window the ceiling applies over. */
export const TURN_WINDOW_MS = 60 * 60 * 1000

export interface TurnLimitStorage {
  readonly get: <T>(key: string) => Promise<T | undefined>
  readonly put: (key: string, value: unknown) => Promise<void>
}

export interface TurnLimitStub {
  readonly fetch: (request: Request) => Promise<Response>
}

export interface TurnLimitNamespace {
  readonly idFromName: (name: string) => unknown
  readonly get: (id: unknown) => TurnLimitStub
}

interface TurnLimitWindow {
  /** When the current window opened. */
  readonly start: number
  /** Turns admitted since it opened. */
  readonly count: number
}

const WINDOW_KEY = "window"

/** What a spend check answered. `retryAt` is set only when refused. */
export interface TurnBudget {
  readonly allowed: boolean
  readonly remaining: number
  readonly retryAt?: number
}

export class TurnRateLimiter {
  constructor(private readonly ctx: { readonly storage: TurnLimitStorage }) {}

  async fetch(request: Request): Promise<Response> {
    const now = Date.now()
    const stored = await this.ctx.storage.get<TurnLimitWindow>(WINDOW_KEY)
    const open = stored !== undefined && now - stored.start < TURN_WINDOW_MS ? stored : { start: now, count: 0 }
    const answer = (body: TurnBudget): Response =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

    switch (new URL(request.url).pathname) {
      case "/spend": {
        if (open.count >= TURN_WINDOW_MAX) {
          // Refused turns do not extend the window: a client that keeps
          // hammering cannot push its own reset further away.
          return answer({ allowed: false, remaining: 0, retryAt: open.start + TURN_WINDOW_MS })
        }
        const next = { start: open.start, count: open.count + 1 }
        await this.ctx.storage.put(WINDOW_KEY, next)
        return answer({ allowed: true, remaining: TURN_WINDOW_MAX - next.count })
      }
      case "/peek":
        return answer({
          allowed: open.count < TURN_WINDOW_MAX,
          remaining: Math.max(0, TURN_WINDOW_MAX - open.count),
          ...(open.count >= TURN_WINDOW_MAX ? { retryAt: open.start + TURN_WINDOW_MS } : {})
        })
      default:
        return new Response("not found", { status: 404 })
    }
  }
}

/**
 * Spend one turn from `login`'s budget.
 *
 * Fails OPEN when no namespace is bound. A deployment without the binding is
 * local dev or a stub stack, where there is no real model credential to
 * protect; refusing every turn there would break the e2e suites to guard
 * nothing. The binding is declared in `wrangler.jsonc`, so the deployed Worker
 * always has it.
 */
export const spendTurn = async (
  limits: TurnLimitNamespace | undefined,
  login: string
): Promise<TurnBudget> => {
  if (limits === undefined) return { allowed: true, remaining: TURN_WINDOW_MAX }
  const stub = limits.get(limits.idFromName(login))
  const response = await stub.fetch(new Request("https://turn-limit.internal/spend", { method: "POST" }))
  const budget = (await response.json().catch(() => undefined)) as TurnBudget | undefined
  // An unreadable answer from our own Durable Object is an infrastructure
  // fault, not a signal about this user: admit the turn and let it be seen in
  // the logs rather than locking a real person out of the alpha.
  return budget ?? { allowed: true, remaining: TURN_WINDOW_MAX }
}

/** The refusal a spent budget answers with: a bug report, never a sales pitch. */
export const turnLimitResponse = (budget: TurnBudget, isolationHeaders: Record<string, string>): Response => {
  const retryAt = budget.retryAt ?? Date.now() + TURN_WINDOW_MS
  const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))
  return new Response(
    JSON.stringify({
      status: "error",
      code: "turn_rate_limited",
      message:
        `That is more than ${TURN_WINDOW_MAX} model calls in an hour, which no conversation reaches by hand — something is looping. Chat resumes on its own in about ${
          Math.ceil(seconds / 60)
        } minutes. Nothing was charged and your balance is untouched.`,
      retryAt: new Date(retryAt).toISOString()
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(seconds),
        ...isolationHeaders
      }
    }
  )
}
