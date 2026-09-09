/**
 * A readable record of what broke in a user's browser.
 *
 * The client already posts its errors to `/api/client-errors`. Until now the
 * handler ran `console.error` and stopped, which means the report survived only
 * as long as someone happened to be running `wrangler tail`. During a private
 * alpha that is the same as having no report at all: the first anyone learns of
 * a broken flow is the user mentioning it, if they bother.
 *
 * So the last reports are kept in one Durable Object — a ring buffer, newest
 * first — and read back through `GET /api/admin/errors`, behind the same admin
 * validation as every other admin route. Deliberately not a log service: no new
 * vendor, no new secret, no egress, and it is bounded, so it cannot grow into a
 * cost of its own.
 *
 * What is stored is what the page sent plus when it arrived, the URL it came
 * from, the user agent, and whether the request carried a session cookie. No
 * session lookup: identifying the reporter would mean an identity round-trip
 * on a route that must stay cheap enough to absorb an error storm, and the
 * report itself is what needs reading.
 *
 * The route is unauthenticated by design (a crash before or during sign-in
 * must still be recorded), so the throttle is the only thing between an
 * anonymous flood and the log. It lives HERE, in the one Durable Object every
 * report reaches, and not in the Worker: a counter in Worker module state is
 * per isolate, workerd runs many isolates and recycles them, and so a counter
 * there bounds nothing. The window is global, one source gets a small share
 * of it, and a report that came with a session cookie is never evicted to
 * make room for one that did not.
 */

/** Reports kept. At the window ceiling of 120/minute this is a couple of minutes of a storm. */
export const CLIENT_ERROR_LOG_LIMIT = 200

/** The throttle window, and the most reports it admits from everyone together. */
export const CLIENT_ERROR_WINDOW_MS = 60_000
export const CLIENT_ERROR_WINDOW_MAX = 120

/**
 * The most reports one source (one client address, an IPv6 /64) may add per
 * window. A browser in an error loop says everything it has to say in its
 * first twenty reports; a flood from one address stops there.
 */
export const CLIENT_ERROR_SOURCE_WINDOW_MAX = 20

/** The source a report is counted against when the request carried no client address. */
export const CLIENT_ERROR_UNKNOWN_SOURCE = "unknown"

/**
 * The whole log lives under one Durable Object storage key, and a stored value
 * may not exceed 128 KiB. The route accepts a report of up to 16 KiB, so a
 * count alone is not a bound: two hundred large ones would be megabytes, the
 * `put` would throw, and — because appending must never fail the report — the
 * throw would be swallowed and the log would silently stop recording. Which is
 * the exact failure this module exists to end.
 *
 * So the real constraint is bytes. The budget is set well under the limit to
 * leave room for the key and the store's own framing.
 */
export const CLIENT_ERROR_LOG_MAX_BYTES = 96 * 1024

/**
 * The most one report may occupy. A stack trace is worth keeping and a 16 KiB
 * blob is not worth evicting fifty other reports for, so an oversized one is
 * truncated rather than dropped: what broke is usually in the first lines.
 */
export const CLIENT_ERROR_RECORD_MAX_BYTES = 4 * 1024

/**
 * The most the page URL or the user agent may occupy. Both come from request
 * headers the client controls, and only the report used to be truncated, so a
 * record could outgrow its budget through its headers alone.
 */
export const CLIENT_ERROR_TEXT_MAX_BYTES = 512

export interface ClientErrorStorage {
  readonly get: <T>(key: string) => Promise<T | undefined>
  readonly put: (key: string, value: unknown) => Promise<void>
}

/** The Durable Object's state, plus the clock the throttle reads (the real one, unless a test says otherwise). */
export interface ClientErrorContext {
  readonly storage: ClientErrorStorage
  readonly now?: () => number
}

export interface ClientErrorStub {
  readonly fetch: (request: Request) => Promise<Response>
}

export interface ClientErrorNamespace {
  readonly idFromName: (name: string) => unknown
  readonly get: (id: unknown) => ClientErrorStub
}

export interface ClientErrorRecord {
  /** When the Worker received it, ISO 8601. */
  readonly at: string
  /** The page that reported, when the request carried a referer. */
  readonly page?: string
  readonly userAgent?: string
  /**
   * The request carried a session cookie. Not validated (that would cost the
   * identity round-trip this route refuses to pay), but an anonymous flood
   * carries none, and that is enough to keep it from evicting these.
   */
  readonly signedIn?: boolean
  /** Exactly what the client posted, parsed when it was JSON and raw text when it was not. */
  readonly report: unknown
}

/** What became of one report offered to the log. */
export type ClientErrorAppendOutcome = "stored" | "throttled" | "unbound" | "failed"

const LOG_KEY = "reports"

/** The internal header that names the source a report counts against. */
export const CLIENT_ERROR_SOURCE_HEADER = "x-client-error-source"

/*
 * Real UTF-8 bytes, not JSON characters. The store measures bytes and
 * JSON.stringify leaves non-ASCII literal, so a message in a language that
 * is not English costs up to three bytes a character — counting characters
 * would under-measure exactly the reports written by the users hardest to
 * support.
 */
const encoder = new TextEncoder()
const sizeOf = (value: unknown): number => encoder.encode(JSON.stringify(value) ?? "").length

/*
 * A header value cut to its byte budget. String.slice counts characters and
 * the budget counts bytes, so shrink until it actually fits.
 */
const capText = (text: string, maxBytes: number): string => {
  if (encoder.encode(text).length <= maxBytes) return text
  let head = text.slice(0, maxBytes)
  while (head.length > 0 && encoder.encode(`${head}…`).length > maxBytes) {
    head = head.slice(0, Math.floor(head.length * 0.75))
  }
  return `${head}…`
}

/** One report, cut to its byte budget. The truncation is stated, never silent. */
export const capRecord = (posted: ClientErrorRecord): ClientErrorRecord => {
  const record: ClientErrorRecord = {
    ...posted,
    ...(posted.page === undefined ? {} : { page: capText(posted.page, CLIENT_ERROR_TEXT_MAX_BYTES) }),
    ...(posted.userAgent === undefined ? {} : { userAgent: capText(posted.userAgent, CLIENT_ERROR_TEXT_MAX_BYTES) })
  }
  if (sizeOf(record) <= CLIENT_ERROR_RECORD_MAX_BYTES) return record
  const text = typeof record.report === "string" ? record.report : (JSON.stringify(record.report) ?? "")
  const withHead = (head: string): ClientErrorRecord => ({
    ...record,
    report: `${head}… [truncated from ${text.length} characters]`
  })
  /*
   * String.slice counts characters and the budget counts bytes, so a first
   * guess in characters overshoots by up to 3x on non-ASCII text. Shrink
   * geometrically until it actually fits — a handful of iterations, and
   * correct for any alphabet rather than for English only.
   */
  let head = text.slice(0, CLIENT_ERROR_RECORD_MAX_BYTES)
  while (head.length > 0 && sizeOf(withHead(head)) > CLIENT_ERROR_RECORD_MAX_BYTES) {
    head = head.slice(0, Math.floor(head.length * 0.75))
  }
  return withHead(head)
}

/**
 * The newest reports that fit, both bounds enforced: count and bytes.
 *
 * Signed-in reports are admitted first, then anonymous ones fill what is
 * left, each newest first. So an anonymous flood evicts anonymous reports
 * only: a signed-in user's crash stays readable until signed-in reports
 * alone fill the log. The result keeps the log's order, newest first.
 *
 * Each record is measured once and the budget accumulated, rather than
 * re-serializing the whole log per eviction — during a storm this runs on
 * every append.
 */
export const bounded = (records: ReadonlyArray<ClientErrorRecord>): Array<ClientErrorRecord> => {
  const kept = new Set<number>()
  // Two bytes of array framing per record ("[", "]", and the commas between).
  let used = 2
  for (const tier of [true, false]) {
    for (const [index, record] of records.entries()) {
      if ((record.signedIn === true) !== tier) continue
      if (kept.size >= CLIENT_ERROR_LOG_LIMIT) break
      const cost = sizeOf(record) + 1
      // The first report admitted is kept whatever it costs: a log that
      // answers nothing because one report was too big has failed at its
      // only job.
      if (kept.size > 0 && used + cost > CLIENT_ERROR_LOG_MAX_BYTES) break
      kept.add(index)
      used += cost
    }
  }
  return records.filter((_, index) => kept.has(index))
}

interface ThrottleWindow {
  readonly start: number
  count: number
  readonly sources: Map<string, number>
}

/**
 * The window is Durable Object memory, not storage: a flood keeps the object
 * alive, and a quiet minute that lets it go is a window that has passed
 * anyway. What matters is that there is exactly one of it.
 */
const admit = (window: ThrottleWindow, source: string): boolean => {
  if (window.count >= CLIENT_ERROR_WINDOW_MAX) return false
  const fromSource = window.sources.get(source) ?? 0
  if (fromSource >= CLIENT_ERROR_SOURCE_WINDOW_MAX) return false
  window.count += 1
  window.sources.set(source, fromSource + 1)
  return true
}

/** Every deployment shares one log; the name is fixed so any request finds it. */
export const CLIENT_ERROR_LOG_NAME = "client-errors"

export class ClientErrorLog {
  private window: ThrottleWindow = { start: 0, count: 0, sources: new Map() }

  constructor(private readonly ctx: ClientErrorContext) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    switch (url.pathname) {
      case "/append": {
        // The body is read to completion BEFORE the log is, and nothing but
        // storage is awaited between the read and the write. A Durable Object
        // only defers concurrent events while a storage operation is pending,
        // so an await on request I/O in the middle of a read-modify-write lets
        // a second append load the same snapshot and overwrite the first one's
        // put. During a storm, which is the only time this log is read, that
        // silently drops reports.
        const record = (await request.json().catch(() => undefined)) as ClientErrorRecord | undefined
        if (record === undefined) return new Response("bad record", { status: 400 })
        const now = (this.ctx.now ?? Date.now)()
        if (now - this.window.start > CLIENT_ERROR_WINDOW_MS) {
          this.window = { start: now, count: 0, sources: new Map() }
        }
        const source = request.headers.get(CLIENT_ERROR_SOURCE_HEADER) ?? CLIENT_ERROR_UNKNOWN_SOURCE
        if (!admit(this.window, source)) {
          return new Response(JSON.stringify({ status: "throttled" }), {
            status: 429,
            headers: { "content-type": "application/json" }
          })
        }
        const stored = (await this.ctx.storage.get<ReadonlyArray<ClientErrorRecord>>(LOG_KEY)) ?? []
        // Newest first, oldest evicted: a storm never buries the report
        // that is being read right now.
        const next = bounded([capRecord(record), ...stored])
        await this.ctx.storage.put(LOG_KEY, next)
        return new Response(JSON.stringify({ status: "ok", kept: next.length }), {
          headers: { "content-type": "application/json" }
        })
      }
      case "/read": {
        const asked = Number(url.searchParams.get("limit") ?? CLIENT_ERROR_LOG_LIMIT)
        const limit = Number.isInteger(asked) && asked > 0
          ? Math.min(asked, CLIENT_ERROR_LOG_LIMIT)
          : CLIENT_ERROR_LOG_LIMIT
        const stored = (await this.ctx.storage.get<ReadonlyArray<ClientErrorRecord>>(LOG_KEY)) ?? []
        return new Response(
          JSON.stringify({ status: "ok", total: stored.length, reports: stored.slice(0, limit) }),
          { headers: { "content-type": "application/json" } }
        )
      }
      default:
        return new Response("not found", { status: 404 })
    }
  }
}

/**
 * Record one report, counted against `source`. Never throws: a browser that
 * just hit an error is not helped by the report failing too, so a log that
 * cannot be reached answers "failed" and the caller still accepts the report.
 * "throttled" is the one outcome the caller refuses on. With no namespace
 * bound (local dev, the stub stack) this is a no-op and the handler's
 * `console.error` remains the only trace, as it always was.
 */
export const appendClientError = async (
  logs: ClientErrorNamespace | undefined,
  record: ClientErrorRecord,
  source: string = CLIENT_ERROR_UNKNOWN_SOURCE
): Promise<ClientErrorAppendOutcome> => {
  if (logs === undefined) return "unbound"
  const stub = logs.get(logs.idFromName(CLIENT_ERROR_LOG_NAME))
  const response = await stub
    .fetch(
      new Request("https://client-errors.internal/append", {
        method: "POST",
        headers: { [CLIENT_ERROR_SOURCE_HEADER]: source },
        body: JSON.stringify(record)
      })
    )
    .catch(() => undefined)
  if (response === undefined) return "failed"
  if (response.status === 429) return "throttled"
  return response.ok ? "stored" : "failed"
}

/** The stored reports, newest first. An unavailable log returns no reports and an explanatory note. */
export const readClientErrors = async (
  logs: ClientErrorNamespace | undefined,
  limit?: number
): Promise<{ readonly total: number; readonly reports: ReadonlyArray<ClientErrorRecord>; readonly note?: string }> => {
  if (logs === undefined) return { total: 0, reports: [] }
  try {
    const stub = logs.get(logs.idFromName(CLIENT_ERROR_LOG_NAME))
    const query = limit === undefined ? "" : `?limit=${limit}`
    const response = await stub.fetch(new Request(`https://client-errors.internal/read${query}`))
    const body = (await response.json()) as
      | { readonly total: number; readonly reports: ReadonlyArray<ClientErrorRecord> }
      | undefined
    return body ?? { total: 0, reports: [] }
  } catch (error) {
    console.error("client-error log read failed:", error)
    return { total: 0, reports: [], note: "The client-error log is unavailable right now. Try again in a moment." }
  }
}
