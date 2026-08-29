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
 * from, and the user agent. No session lookup: identifying the reporter would
 * mean an identity round-trip on a route that must stay cheap enough to absorb
 * an error storm, and the report itself is what needs reading.
 */

/** Reports kept. At the route's own ceiling of 120/minute this is a couple of minutes of a storm. */
export const CLIENT_ERROR_LOG_LIMIT = 200

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

export interface ClientErrorStorage {
  readonly get: <T>(key: string) => Promise<T | undefined>
  readonly put: (key: string, value: unknown) => Promise<void>
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
  /** Exactly what the client posted, parsed when it was JSON and raw text when it was not. */
  readonly report: unknown
}

const LOG_KEY = "reports"

/*
 * Real UTF-8 bytes, not JSON characters. The store measures bytes and
 * JSON.stringify leaves non-ASCII literal, so a message in a language that
 * is not English costs up to three bytes a character — counting characters
 * would under-measure exactly the reports written by the users hardest to
 * support.
 */
const encoder = new TextEncoder()
const sizeOf = (value: unknown): number => encoder.encode(JSON.stringify(value) ?? "").length

/** One report, cut to its byte budget. The truncation is stated, never silent. */
export const capRecord = (record: ClientErrorRecord): ClientErrorRecord => {
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
 * Each record is measured once and the budget accumulated, rather than
 * re-serializing the whole log per eviction — during a storm this runs on
 * every append.
 */
export const bounded = (records: ReadonlyArray<ClientErrorRecord>): Array<ClientErrorRecord> => {
  const kept: Array<ClientErrorRecord> = []
  // Two bytes of array framing per record ("[", "]", and the commas between).
  let used = 2
  for (const record of records.slice(0, CLIENT_ERROR_LOG_LIMIT)) {
    const cost = sizeOf(record) + 1
    // The newest report is kept whatever it costs: a log that answers
    // nothing because one report was too big has failed at its only job.
    if (kept.length > 0 && used + cost > CLIENT_ERROR_LOG_MAX_BYTES) break
    kept.push(record)
    used += cost
  }
  return kept
}

/** Every deployment shares one log; the name is fixed so any request finds it. */
export const CLIENT_ERROR_LOG_NAME = "client-errors"

export class ClientErrorLog {
  constructor(private readonly ctx: { readonly storage: ClientErrorStorage }) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const stored = (await this.ctx.storage.get<ReadonlyArray<ClientErrorRecord>>(LOG_KEY)) ?? []
    switch (url.pathname) {
      case "/append": {
        const record = (await request.json().catch(() => undefined)) as ClientErrorRecord | undefined
        if (record === undefined) return new Response("bad record", { status: 400 })
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
 * Record one report. Never throws and never blocks the answer to the client:
 * a browser that just hit an error is not helped by the report failing too.
 * With no namespace bound (local dev, the stub stack) this is a no-op and the
 * handler's `console.error` remains the only trace, as it always was.
 */
export const appendClientError = async (
  logs: ClientErrorNamespace | undefined,
  record: ClientErrorRecord
): Promise<void> => {
  if (logs === undefined) return
  const stub = logs.get(logs.idFromName(CLIENT_ERROR_LOG_NAME))
  await stub
    .fetch(new Request("https://client-errors.internal/append", { method: "POST", body: JSON.stringify(record) }))
    .catch(() => undefined)
}

/** The stored reports, newest first. */
export const readClientErrors = async (
  logs: ClientErrorNamespace | undefined,
  limit?: number
): Promise<{ readonly total: number; readonly reports: ReadonlyArray<ClientErrorRecord> }> => {
  if (logs === undefined) return { total: 0, reports: [] }
  const stub = logs.get(logs.idFromName(CLIENT_ERROR_LOG_NAME))
  const query = limit === undefined ? "" : `?limit=${limit}`
  const response = await stub.fetch(new Request(`https://client-errors.internal/read${query}`))
  const body = (await response.json().catch(() => undefined)) as
    | { readonly total: number; readonly reports: ReadonlyArray<ClientErrorRecord> }
    | undefined
  return body ?? { total: 0, reports: [] }
}
