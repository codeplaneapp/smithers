/**
 * The command recommender: which `/command` should this user run next?
 *
 * The browser posts the tail of the current chat and every command the user
 * can invoke right now, and this route asks a small, fast model (Cerebras)
 * for an ordered list of up to five of those commands. The client renders
 * them as pills under the composer. The route works for a signed-out visitor
 * as well as a login, because the pills are how a visitor learns what the
 * product can do.
 *
 * Every recommendation is a row in a bounded log (one Durable Object for the
 * deployment), and when the user runs a command next the client posts the
 * outcome under the recommendation's id. That pair is the whole eval: a hit
 * is an outcome that was on the list, a top-1 is an outcome that was first.
 * The log never holds the chat text, only a digest of it, so a scorer can
 * tell two tails apart without reading either.
 *
 * Honesty rules the answers. A hallucinated command name is dropped, never
 * shown. A missing key, a slow model, or an unreadable answer is a 503, never
 * a made-up list: the client's rule-based fallback is the client's business,
 * and the log must only ever hold what the model actually said.
 */
import {
  ANONYMOUS_TURN_WINDOW_MS,
  anonymousTurnKey,
  spendTurn,
  turnLimitResponse
} from "./turnLimit"
import type { TurnCeiling, TurnLimitNamespace } from "./turnLimit"

/** The most tail messages a request may carry; the client truncates first. */
export const RECOMMEND_TAIL_MAX_ENTRIES = 12
/** The most characters of tail text, summed over every entry. */
export const RECOMMEND_TAIL_MAX_CHARS = 4000
/** The most commands a request may offer. */
export const RECOMMEND_COMMANDS_MAX = 300
/** The most names an answer carries. */
export const RECOMMEND_ANSWER_MAX = 5
/** Rows the log keeps: a ring of the newest. */
export const RECOMMEND_LOG_LIMIT = 5000
/** How long the model gets, in ms. Pills that arrive after the user has moved on are noise. */
export const RECOMMEND_TIMEOUT_MS = 6000
/** The model the deployment asks unless `CEREBRAS_MODEL` says otherwise. */
export const RECOMMEND_DEFAULT_MODEL = "gpt-oss-120b"
export const CEREBRAS_CHAT_COMPLETIONS_URL = "https://api.cerebras.ai/v1/chat/completions"

/**
 * The request body's byte cap, checked before parsing. The tail is at most
 * 4000 characters and the command list at most 300 short lines, so a body
 * past this is not a client that forgot to truncate.
 */
export const RECOMMEND_BODY_MAX_BYTES = 256 * 1024

/**
 * Recommendations one address, or one login, may ask for per day. A pill
 * refresh follows each turn, and a hard day of chatting is about a hundred
 * turns, so three hundred is headroom, not a ration.
 */
export const RECOMMEND_ADDRESS_MAX = 300
/** Recommendations the whole deployment may ask for per day. */
export const RECOMMEND_ALL_MAX = 5000

export const RECOMMEND_CEILING: TurnCeiling = {
  kind: "recommend",
  max: RECOMMEND_ADDRESS_MAX,
  windowMs: ANONYMOUS_TURN_WINDOW_MS
}

export const RECOMMEND_ALL_CEILING: TurnCeiling = {
  kind: "recommend",
  max: RECOMMEND_ALL_MAX,
  windowMs: ANONYMOUS_TURN_WINDOW_MS
}

/**
 * The deployment-wide bucket. The `recommend:` prefix keeps every recommend
 * bucket apart from the turn buckets, which are a bare login or an
 * `anonymous:` digest, because one bucket only ever sees one ceiling.
 */
export const RECOMMEND_ALL_KEY = "recommend:all"

export interface RecommendTailMessage {
  readonly role: "user" | "assistant" | "system"
  readonly text: string
}

export interface RecommendCommand {
  readonly name: string
  readonly summary: string
}

export interface RecommendRequest {
  readonly repo: string | null
  readonly tail: ReadonlyArray<RecommendTailMessage>
  readonly commands: ReadonlyArray<RecommendCommand>
}

/** What the scorer reads: one row per recommendation, the tail digested. */
export interface RecommendLogRow {
  readonly id: string
  /** ISO 8601, when the recommendation was made. */
  readonly at: string
  readonly repo: string | null
  /** SHA-256 hex of the tail text. The text itself is never stored. */
  readonly tailDigest: string
  /** How many commands the request offered. */
  readonly commandCount: number
  /** The answer, best first. */
  readonly commands: ReadonlyArray<string>
  readonly model: string
  /** The command the user ran next, once the client reports it. */
  readonly outcome: { readonly command: string; readonly at: string } | null
}

/** The subset of Durable Object storage the log uses. */
export interface RecommendLogStorage {
  readonly get: <T>(key: string) => Promise<T | undefined>
  readonly put: (key: string, value: unknown) => Promise<void>
  readonly delete: (key: string) => Promise<boolean>
  readonly list: <T>(
    options: { readonly prefix: string; readonly reverse: boolean; readonly limit: number }
  ) => Promise<Map<string, T>>
}

export interface RecommendLogStub {
  readonly fetch: (request: Request) => Promise<Response>
}

export interface RecommendLogNamespace {
  readonly idFromName: (name: string) => unknown
  readonly get: (id: unknown) => RecommendLogStub
}

/** The environment the routes read. `WorkerEnv` carries all of it. */
export interface RecommendEnv {
  /** The Cerebras key. Unset = the route answers 503 and the client keeps its fallback. */
  readonly CEREBRAS_API_KEY?: string
  /** Overrides {@link RECOMMEND_DEFAULT_MODEL}. */
  readonly CEREBRAS_MODEL?: string
  readonly RECOMMEND_LOG?: RecommendLogNamespace
  readonly TURN_LIMITS?: TurnLimitNamespace
  readonly ANONYMOUS_TURN_SALT?: string
}

/* ------------------------------------------------------------------------ */
/* The log                                                                   */
/* ------------------------------------------------------------------------ */

/** Every deployment shares one log; the name is fixed so any request finds it. */
export const RECOMMEND_LOG_NAME = "recommendations"

const SEQ_KEY = "seq"
const ROW_PREFIX = "row:"
/** Wide enough that lexical key order is numeric order for the life of the log. */
const SEQ_WIDTH = 12

const rowKey = (seq: number): string => `${ROW_PREFIX}${String(seq).padStart(SEQ_WIDTH, "0")}`

/**
 * An id names its row: the sequence number is its head, so an outcome finds
 * its row with one storage read, and the random tail is what stops a caller
 * from recording outcomes against ids it never received.
 */
const mintId = (seq: number): string => {
  const random = crypto.getRandomValues(new Uint8Array(8))
  return `${seq.toString(36)}-${[...random].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

const seqOf = (id: string): number | undefined => {
  const head = id.split("-", 1)[0] ?? ""
  if (!/^[0-9a-z]+$/.test(head)) return undefined
  const seq = parseInt(head, 36)
  return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined
}

export class RecommendLog {
  constructor(private readonly ctx: { readonly storage: RecommendLogStorage }) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const answer = (status: number, body: unknown): Response =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
      })
    switch (url.pathname) {
      case "/append": {
        // The body is read before any storage call, so nothing but storage is
        // awaited between the sequence read and the writes: a Durable Object
        // defers concurrent events only while a storage operation is pending,
        // and two appends that both read the same sequence would share a key.
        const row = (await request.json().catch(() => undefined)) as Omit<RecommendLogRow, "id"> | undefined
        if (row === undefined) return answer(400, { status: "error", message: "bad row" })
        const seq = ((await this.ctx.storage.get<number>(SEQ_KEY)) ?? 0) + 1
        const id = mintId(seq)
        await this.ctx.storage.put(SEQ_KEY, seq)
        await this.ctx.storage.put(rowKey(seq), { ...row, id })
        // A ring: the row that fell off the far end goes with each append.
        if (seq > RECOMMEND_LOG_LIMIT) await this.ctx.storage.delete(rowKey(seq - RECOMMEND_LOG_LIMIT))
        return answer(200, { id })
      }
      case "/outcome": {
        const body = (await request.json().catch(() => undefined)) as
          | { readonly id?: unknown; readonly command?: unknown; readonly at?: unknown }
          | undefined
        if (
          body === undefined || typeof body.id !== "string" || typeof body.command !== "string" ||
          typeof body.at !== "string"
        ) return answer(400, { status: "error", message: "bad outcome" })
        const seq = seqOf(body.id)
        if (seq === undefined) return answer(404, { status: "error", message: "unknown id" })
        const row = await this.ctx.storage.get<RecommendLogRow>(rowKey(seq))
        if (row === undefined || row.id !== body.id) return answer(404, { status: "error", message: "unknown id" })
        if (row.outcome !== null) return answer(409, { status: "error", message: "outcome already recorded" })
        await this.ctx.storage.put(rowKey(seq), { ...row, outcome: { command: body.command, at: body.at } })
        return answer(204, undefined)
      }
      case "/read": {
        const asked = Number(url.searchParams.get("limit") ?? "")
        const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, RECOMMEND_LOG_LIMIT) : RECOMMEND_LOG_LIMIT
        const rows = await this.ctx.storage.list<RecommendLogRow>({ prefix: ROW_PREFIX, reverse: true, limit })
        return answer(200, { rows: [...rows.values()] })
      }
      default:
        return answer(404, { status: "error", message: "not found" })
    }
  }
}

const logStub = (logs: RecommendLogNamespace): RecommendLogStub => logs.get(logs.idFromName(RECOMMEND_LOG_NAME))

/**
 * Append one row and answer its id. With no log bound (local dev, the stub
 * stack) the recommendation still answers, under an id that no outcome can
 * ever match: the eval is a deployment concern, the pills are not.
 */
const appendRow = async (
  logs: RecommendLogNamespace | undefined,
  row: Omit<RecommendLogRow, "id">
): Promise<string> => {
  if (logs === undefined) return `unlogged-${crypto.randomUUID()}`
  const response = await logStub(logs).fetch(
    new Request("https://recommend-log.internal/append", { method: "POST", body: JSON.stringify(row) })
  )
  const body = (await response.json().catch(() => undefined)) as { readonly id?: unknown } | undefined
  return typeof body?.id === "string" ? body.id : `unlogged-${crypto.randomUUID()}`
}

/** The newest rows, for the scorer. */
export const readRecommendLog = async (
  logs: RecommendLogNamespace | undefined,
  limit?: number
): Promise<ReadonlyArray<RecommendLogRow>> => {
  if (logs === undefined) return []
  const query = limit === undefined ? "" : `?limit=${limit}`
  const response = await logStub(logs).fetch(new Request(`https://recommend-log.internal/read${query}`))
  const body = (await response.json().catch(() => undefined)) as { readonly rows?: unknown } | undefined
  return Array.isArray(body?.rows) ? (body.rows as ReadonlyArray<RecommendLogRow>) : []
}

/* ------------------------------------------------------------------------ */
/* The request                                                               */
/* ------------------------------------------------------------------------ */

const ROLES: ReadonlyArray<string> = ["user", "assistant", "system"]

/** What reading a body decided: a request, or the status the refusal carries. */
type Parsed = { readonly ok: true; readonly body: RecommendRequest } | { readonly ok: false; readonly status: 400 | 413; readonly message: string }

const isTailMessage = (value: unknown): value is RecommendTailMessage =>
  typeof value === "object" && value !== null &&
  typeof (value as { role?: unknown }).role === "string" && ROLES.includes((value as { role: string }).role) &&
  typeof (value as { text?: unknown }).text === "string"

const isCommand = (value: unknown): value is RecommendCommand =>
  typeof value === "object" && value !== null &&
  typeof (value as { name?: unknown }).name === "string" && (value as { name: string }).name !== "" &&
  typeof (value as { summary?: unknown }).summary === "string"

/** Read and validate the body. Malformed is 400; well-formed but too big is 413. */
export const parseRecommendRequest = async (request: Request): Promise<Parsed> => {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > RECOMMEND_BODY_MAX_BYTES) return { ok: false, status: 413, message: "The recommendation request is too large." }
  const text = await request.text().catch(() => undefined)
  if (text === undefined) return { ok: false, status: 400, message: "The recommendation request could not be read." }
  if (new TextEncoder().encode(text).byteLength > RECOMMEND_BODY_MAX_BYTES) {
    return { ok: false, status: 413, message: "The recommendation request is too large." }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, status: 400, message: "The recommendation request is not JSON." }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, status: 400, message: "The recommendation request must be a JSON object." }
  }
  const { repo, tail, commands } = value as { repo?: unknown; tail?: unknown; commands?: unknown }
  if (repo !== null && typeof repo !== "string") {
    return { ok: false, status: 400, message: "repo must be \"owner/name\" or null." }
  }
  if (!Array.isArray(tail) || !tail.every(isTailMessage)) {
    return { ok: false, status: 400, message: "tail must be a list of { role, text } messages." }
  }
  if (!Array.isArray(commands) || !commands.every(isCommand)) {
    return { ok: false, status: 400, message: "commands must be a list of { name, summary } entries." }
  }
  if (tail.length > RECOMMEND_TAIL_MAX_ENTRIES) {
    return { ok: false, status: 413, message: `tail may carry at most ${RECOMMEND_TAIL_MAX_ENTRIES} messages.` }
  }
  if (tail.reduce((sum, message) => sum + message.text.length, 0) > RECOMMEND_TAIL_MAX_CHARS) {
    return { ok: false, status: 413, message: `tail may carry at most ${RECOMMEND_TAIL_MAX_CHARS} characters of text.` }
  }
  if (commands.length > RECOMMEND_COMMANDS_MAX) {
    return { ok: false, status: 413, message: `commands may carry at most ${RECOMMEND_COMMANDS_MAX} entries.` }
  }
  return { ok: true, body: { repo: repo ?? null, tail, commands } }
}

/** The text the digest is over: one line per message, role first. */
export const tailText = (tail: ReadonlyArray<RecommendTailMessage>): string =>
  tail.map((message) => `${message.role}: ${message.text}`).join("\n")

export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/* ------------------------------------------------------------------------ */
/* The model                                                                 */
/* ------------------------------------------------------------------------ */

export const RECOMMEND_SYSTEM_PROMPT =
  "You are choosing the next command for a user of Smithers, a product where a coding agent works on a repository. " +
  "You are given the recent conversation, newest last, and then every command the user can run right now, one per line as `name: summary`. " +
  `Answer with up to ${RECOMMEND_ANSWER_MAX} command names, best first, as JSON of the form {"commands": ["name", ...]}. ` +
  "Use only names from the command list, exactly as written. Prefer commands that continue what the user is doing; when the conversation is empty, prefer commands that start something."

/** The messages the model reads. Exported so the prompt is testable and the client can mirror it. */
export const recommendMessages = (body: RecommendRequest): ReadonlyArray<{ role: "system" | "user"; content: string }> => {
  const conversation = body.tail.length === 0
    ? "(no messages yet)"
    : body.tail.map((message) => `${message.role}: ${message.text}`).join("\n")
  const commands = body.commands.map((command) => `${command.name}: ${command.summary}`).join("\n")
  return [
    { role: "system", content: RECOMMEND_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Repository: ${body.repo ?? "(none selected)"}\n\nConversation:\n${conversation}\n\nCommands:\n${commands}`
    }
  ]
}

const ANSWER_SCHEMA = {
  type: "object",
  properties: { commands: { type: "array", items: { type: "string" } } },
  required: ["commands"],
  additionalProperties: false
} as const

/**
 * The names in a model answer, read defensively: the strict JSON the schema
 * asks for, a JSON object buried in prose, or a bare JSON array. Anything
 * else is `undefined`, which the route reports as the model failing rather
 * than as an empty recommendation.
 */
export const parseAnswer = (content: string): ReadonlyArray<string> | undefined => {
  const candidates = [content.trim()]
  const object = content.match(/\{[\s\S]*\}/)
  if (object !== null) candidates.push(object[0])
  const array = content.match(/\[[\s\S]*\]/)
  if (array !== null) candidates.push(array[0])
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate)
      const list = Array.isArray(value) ? value : (value as { commands?: unknown } | null)?.commands
      if (Array.isArray(list)) return list.filter((entry): entry is string => typeof entry === "string")
    } catch {
      // Try the next reading.
    }
  }
  return undefined
}

/** Keep only offered names, first mention wins, at most the answer cap. */
export const filterAnswer = (
  names: ReadonlyArray<string>,
  offered: ReadonlyArray<RecommendCommand>
): ReadonlyArray<string> => {
  const known = new Set(offered.map((command) => command.name))
  const kept: Array<string> = []
  for (const name of names) {
    const trimmed = name.trim()
    if (known.has(trimmed) && !kept.includes(trimmed)) kept.push(trimmed)
    if (kept.length === RECOMMEND_ANSWER_MAX) break
  }
  return kept
}

/** The one shape of fetch the model call uses; tests pass a stub. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

type ModelAnswer =
  | { readonly ok: true; readonly commands: ReadonlyArray<string>; readonly model: string }
  | { readonly ok: false; readonly message: string }

/**
 * One Cerebras chat completion under the deadline. The strict JSON schema is
 * asked for first; a provider that refuses the format (HTTP 400) is asked
 * once more without it and its prose is parsed defensively.
 */
const askModel = async (
  body: RecommendRequest,
  apiKey: string,
  model: string,
  fetchImpl: FetchLike
): Promise<ModelAnswer> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RECOMMEND_TIMEOUT_MS)
  const call = (strict: boolean): Promise<Response> =>
    fetchImpl(CEREBRAS_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 256,
        messages: recommendMessages(body),
        ...(strict
          ? { response_format: { type: "json_schema", json_schema: { name: "recommendation", strict: true, schema: ANSWER_SCHEMA } } }
          : {})
      }),
      signal: controller.signal
    })
  try {
    let response = await call(true)
    if (response.status === 400) {
      await response.body?.cancel().catch(() => undefined)
      response = await call(false)
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { ok: false, message: `The recommender answered HTTP ${response.status}.` }
    }
    const answer = (await response.json().catch(() => undefined)) as
      | { readonly model?: unknown; readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: unknown } }> }
      | undefined
    const content = answer?.choices?.[0]?.message?.content
    const names = typeof content === "string" ? parseAnswer(content) : undefined
    if (names === undefined) return { ok: false, message: "The recommender did not answer with a command list." }
    return { ok: true, commands: filterAnswer(names, body.commands), model: typeof answer?.model === "string" ? answer.model : model }
  } catch {
    return {
      ok: false,
      message: controller.signal.aborted
        ? `The recommender did not answer within ${Math.round(RECOMMEND_TIMEOUT_MS / 1000)}s.`
        : "The recommender is unreachable."
    }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------------ */
/* The routes                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The bucket a recommendation spends from: the login when the session is
 * known, else the same salted address digest the anonymous turn ceiling
 * uses, both under a `recommend:` prefix so no turn bucket is ever shared.
 */
export const recommendKey = async (request: Request, login: string | undefined, salt: string | undefined): Promise<string> =>
  login === undefined ? `recommend:${await anonymousTurnKey(request, salt)}` : `recommend:login:${login}`

const jsonWith = (status: number, body: unknown, headers: Record<string, string>): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

/**
 * POST /api/recommend. `login` is the validated session's login when the
 * caller has one; the router resolves it and passes `undefined` for a
 * visitor. Order: the body first (a refusal there costs nothing), then the
 * key (a deployment without one spends no ceiling), then both ceilings,
 * then the model.
 */
export const handleRecommend = async (
  request: Request,
  env: RecommendEnv,
  login: string | undefined,
  headers: Record<string, string>,
  fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init)
): Promise<Response> => {
  const parsed = await parseRecommendRequest(request)
  if (!parsed.ok) return jsonWith(parsed.status, { status: "error", message: parsed.message }, headers)
  const apiKey = env.CEREBRAS_API_KEY?.trim()
  if (apiKey === undefined || apiKey === "") {
    return jsonWith(503, {
      status: "error",
      message: "CEREBRAS_API_KEY is unset. Command suggestions are unavailable on this deployment."
    }, headers)
  }
  const own = await spendTurn(env.TURN_LIMITS, await recommendKey(request, login, env.ANONYMOUS_TURN_SALT), RECOMMEND_CEILING)
  if (!own.allowed) return turnLimitResponse(own, headers, RECOMMEND_CEILING)
  const shared = await spendTurn(env.TURN_LIMITS, RECOMMEND_ALL_KEY, RECOMMEND_ALL_CEILING)
  if (!shared.allowed) return turnLimitResponse(shared, headers, RECOMMEND_ALL_CEILING)
  const model = env.CEREBRAS_MODEL?.trim() || RECOMMEND_DEFAULT_MODEL
  const answer = await askModel(parsed.body, apiKey, model, fetchImpl)
  if (!answer.ok) return jsonWith(503, { status: "error", message: answer.message }, headers)
  const id = await appendRow(env.RECOMMEND_LOG, {
    at: new Date().toISOString(),
    repo: parsed.body.repo,
    tailDigest: await sha256Hex(tailText(parsed.body.tail)),
    commandCount: parsed.body.commands.length,
    commands: answer.commands,
    model: answer.model,
    outcome: null
  })
  return jsonWith(200, { id, commands: answer.commands, model: answer.model }, headers)
}

/** POST /api/recommend/outcome: 204 once per id, 404 for an id the log never minted, 409 for a second outcome. */
export const handleRecommendOutcome = async (
  request: Request,
  env: RecommendEnv,
  headers: Record<string, string>
): Promise<Response> => {
  const body = (await request.json().catch(() => undefined)) as { readonly id?: unknown; readonly command?: unknown } | undefined
  if (body === undefined || typeof body.id !== "string" || body.id === "" || typeof body.command !== "string" || body.command === "") {
    return jsonWith(400, { status: "error", message: "An outcome is { id, command }, both strings." }, headers)
  }
  if (env.RECOMMEND_LOG === undefined) {
    return jsonWith(404, { status: "error", message: "No recommendation log on this deployment: no recommendation has that id." }, headers)
  }
  const response = await logStub(env.RECOMMEND_LOG).fetch(
    new Request("https://recommend-log.internal/outcome", {
      method: "POST",
      body: JSON.stringify({ id: body.id, command: body.command, at: new Date().toISOString() })
    })
  )
  switch (response.status) {
    case 204:
      return new Response(null, { status: 204, headers })
    case 409:
      return jsonWith(409, { status: "error", message: "An outcome is already recorded for that recommendation." }, headers)
    case 404:
      return jsonWith(404, { status: "error", message: "No recommendation has that id." }, headers)
    default:
      return jsonWith(500, { status: "error", message: "The recommendation log did not record the outcome." }, headers)
  }
}
