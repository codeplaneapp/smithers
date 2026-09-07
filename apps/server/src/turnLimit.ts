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

/**
 * A ceiling: how many model calls one bucket may start per window, and whose
 * bucket it is. The kind picks the refusal's wording, because a login that
 * trips its ceiling has hit a bug, a visitor who trips theirs has reached
 * the end of what exploring offers, and a visitor refused by the
 * deployment-wide bucket has done nothing at all.
 */
export interface TurnCeiling {
  /**
   * `recommend` is the command recommender's ceiling (recommend.ts): the
   * same counter, spent on a route that costs a small model call and that
   * chat never depends on, so its refusal says suggestions paused and
   * nothing else.
   */
  readonly kind: "login" | "anonymous" | "anonymous-all" | "recommend"
  readonly max: number
  readonly windowMs: number
}

/** The per-login ceiling above. */
export const LOGIN_CEILING: TurnCeiling = { kind: "login", max: TURN_WINDOW_MAX, windowMs: TURN_WINDOW_MS }

/**
 * Turns one signed-out visitor may start per day while exploring a public
 * catalog repository (smithers.sh/smithersai/smithers, PUBLIC-REPOSITORIES.md).
 *
 * An anonymous turn spends the deployment's own model credential and is never
 * attributed to an account, so unlike the login ceiling this is a COST cap,
 * not an abuse guard: twenty questions is a real look at a codebase, and the
 * refusal names sign-in as the way to keep going. The bucket is a salted hash
 * of the client IP (`anonymousTurnKey`): a visitor cannot name their own
 * bucket, and the store never holds a raw address.
 */
export const ANONYMOUS_TURN_MAX = 20

/** The anonymous window: one day. */
export const ANONYMOUS_TURN_WINDOW_MS = 24 * 60 * 60 * 1000

export const ANONYMOUS_CEILING: TurnCeiling = {
  kind: "anonymous",
  max: ANONYMOUS_TURN_MAX,
  windowMs: ANONYMOUS_TURN_WINDOW_MS
}

/**
 * Turns ALL signed-out visitors together may start per day.
 *
 * The per-address bucket alone is not a cost cap: an IPv6 visitor holds a
 * whole /64 and a pool of IPv4 proxies is cheap, so a caller who rotates
 * addresses gets a fresh twenty each time. This second bucket
 * (`ANONYMOUS_ALL_KEY`) is spent beside the per-address one on every
 * anonymous turn and bounds what exploring can cost the deployment in a day
 * no matter how many addresses ask. Three hundred is fifteen full visitors'
 * worth, or about a dollar at the alpha's rate card.
 */
export const ANONYMOUS_ALL_TURN_MAX = 300

/**
 * The deployment-wide anonymous bucket. `all` is never a hex digest, so it
 * cannot collide with a per-address key.
 */
export const ANONYMOUS_ALL_KEY = "anonymous:all"

export const ANONYMOUS_ALL_CEILING: TurnCeiling = {
  kind: "anonymous-all",
  max: ANONYMOUS_ALL_TURN_MAX,
  windowMs: ANONYMOUS_TURN_WINDOW_MS
}

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

/** A positive integer ceiling parameter, or the default when absent or malformed. */
const ceilingParam = (url: URL, name: string, fallback: number): number => {
  const value = Number(url.searchParams.get(name))
  return Number.isInteger(value) && value > 0 ? value : fallback
}

export class TurnRateLimiter {
  constructor(private readonly ctx: { readonly storage: TurnLimitStorage }) {}

  async fetch(request: Request): Promise<Response> {
    const now = Date.now()
    const url = new URL(request.url)
    // The caller names the ceiling with each request; the login ceiling is
    // the default so an unadorned call keeps its old meaning. One bucket
    // only ever sees one ceiling, because the key already says whose it is.
    const max = ceilingParam(url, "max", TURN_WINDOW_MAX)
    const windowMs = ceilingParam(url, "windowMs", TURN_WINDOW_MS)
    const stored = await this.ctx.storage.get<TurnLimitWindow>(WINDOW_KEY)
    const open = stored !== undefined && now - stored.start < windowMs ? stored : { start: now, count: 0 }
    const answer = (body: TurnBudget): Response =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

    switch (url.pathname) {
      case "/spend": {
        if (open.count >= max) {
          // Refused turns do not extend the window: a client that keeps
          // hammering cannot push its own reset further away.
          return answer({ allowed: false, remaining: 0, retryAt: open.start + windowMs })
        }
        const next = { start: open.start, count: open.count + 1 }
        await this.ctx.storage.put(WINDOW_KEY, next)
        return answer({ allowed: true, remaining: max - next.count })
      }
      case "/peek":
        return answer({
          allowed: open.count < max,
          remaining: Math.max(0, max - open.count),
          ...(open.count >= max ? { retryAt: open.start + windowMs } : {})
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
  key: string,
  ceiling: TurnCeiling = LOGIN_CEILING
): Promise<TurnBudget> => {
  if (limits === undefined) return { allowed: true, remaining: ceiling.max }
  const stub = limits.get(limits.idFromName(key))
  const response = await stub.fetch(
    new Request(`https://turn-limit.internal/spend?max=${ceiling.max}&windowMs=${ceiling.windowMs}`, { method: "POST" })
  )
  const budget = (await response.json().catch(() => undefined)) as TurnBudget | undefined
  // An unreadable answer from our own Durable Object is an infrastructure
  // fault, not a signal about this user: admit the turn and let it be seen in
  // the logs rather than locking a real person out of the alpha.
  return budget ?? { allowed: true, remaining: ceiling.max }
}

/**
 * The part of a client address that names its bucket. An IPv4 address is
 * its own bucket. An IPv6 visitor normally holds a whole /64, so the bucket
 * is the /64 prefix: the first four hextets, expanded so `2001:db8::1` and
 * `2001:0db8:0:0::2` land in the same bucket. Anything unparseable is
 * bucketed as written rather than refused.
 */
export const anonymousBucketAddress = (ip: string): string => {
  const address = ip.trim().toLowerCase()
  if (!address.includes(":")) return address
  // An IPv4-mapped address (`::ffff:198.51.100.9`) is an IPv4 visitor.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped !== null) return mapped[1]!
  const [head = "", tail = ""] = address.split("::", 2)
  const heads = head === "" ? [] : head.split(":")
  const tails = tail === "" ? [] : tail.split(":")
  const hextets = [...heads, ...Array(Math.max(0, 8 - heads.length - tails.length)).fill("0"), ...tails]
  return `${hextets.slice(0, 4).map((hextet) => hextet.replace(/^0+(?=.)/, "")).join(":")}::/64`
}

/**
 * The bucket an anonymous turn spends from: a salted SHA-256 of the client
 * address Cloudflare reports (`anonymousBucketAddress`, so one IPv6 /64 is
 * one bucket). The `anonymous:` prefix can never collide with a GitHub
 * login, so a visitor's bucket is never a user's. `salt` is the
 * deployment's ANONYMOUS_TURN_SALT secret; without one the hash is still
 * not an address, only linkable across deployments that also have none.
 */
export const anonymousTurnKey = async (request: Request, salt: string | undefined): Promise<string> => {
  const ip = anonymousBucketAddress(request.headers.get("cf-connecting-ip") ?? "")
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt ?? ""}\n${ip}`))
  return `anonymous:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

const waitLabel = (seconds: number): string =>
  seconds >= 2 * 60 * 60 ? `${Math.ceil(seconds / 3600)} hours` : `${Math.ceil(seconds / 60)} minutes`

/**
 * The refusal a spent budget answers with. For a login: a bug report, never a
 * sales pitch. For a visitor: the end of exploring, and the one way on. For
 * a visitor refused by the deployment-wide bucket: the same way on, and that
 * they did nothing wrong.
 */
export const turnLimitResponse = (
  budget: TurnBudget,
  isolationHeaders: Record<string, string>,
  ceiling: TurnCeiling = LOGIN_CEILING
): Response => {
  const retryAt = budget.retryAt ?? Date.now() + ceiling.windowMs
  const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))
  return new Response(
    JSON.stringify({
      status: "error",
      code: "turn_rate_limited",
      message: ceiling.kind === "recommend"
        ? `Command suggestions have reached their daily limit. Chat keeps working; suggestions come back in about ${
          waitLabel(seconds)
        }. Nothing was charged.`
        : ceiling.kind === "anonymous"
        ? `That is ${ceiling.max} turns today without signing in, which is as far as exploring goes. Sign in with GitHub to keep going, or come back in about ${
          waitLabel(seconds)
        }. Nothing was charged.`
        : ceiling.kind === "anonymous-all"
        ? `Exploring without signing in has reached its daily limit for everyone, not just you. Sign in with GitHub to keep going, or come back in about ${
          waitLabel(seconds)
        }. Nothing was charged.`
        : `That is more than ${ceiling.max} model calls in an hour, which no conversation reaches by hand — something is looping. Chat resumes on its own in about ${
          waitLabel(seconds)
        }. Nothing was charged and your balance is untouched.`,
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
