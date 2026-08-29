/**
 * One chat session, as a Durable Object.
 *
 * A session is the app's whole persistent state: the transcript, the cards the
 * agent painted, and the flows it promoted with `flows/write-flow`. All three
 * live in this object's SQLite storage, keyed by nothing. The object *is* the
 * key, so a row here can never belong to another session.
 *
 * The same class also plays a second role. A Durable Object namespace cannot
 * be enumerated, so one well-known object (`registry.ts`, `INDEX_SESSION`)
 * holds the session list `GET /api/session` answers, and every other object
 * writes its own row there as a turn starts and settles. Only the `sessions`
 * table is used in that role; only the other three are used in the session
 * role.
 *
 * The engine journal is deliberately NOT here. `@smthrs/database` has no
 * Durable Object SQLite driver yet (TODO.md), so a turn runs on
 * `FlowEngine.layerMemory` and this object persists the app's own state
 * instead. When the driver lands the journal moves in beside these tables and
 * a resumed turn replays rather than restarts.
 */
import { DurableObject } from "cloudflare:workers"
import type { Effect } from "effect"
import type { FlowRunCard } from "@smthrs/create-app/ui"
import type {
  AppCard,
  CancelResponse,
  FlowRunRequest,
  FlowRunResponse,
  FlowSummary,
  Message,
  SessionState,
  SessionSummary,
  TurnRequest
} from "../src/api.ts"
import type { Env } from "./env.ts"
import { INDEX_SESSION, byRecency, indexSession, titleFrom } from "./registry.ts"
import { runTurn } from "./turn.ts"

// ---------------------------------------------------------------------------
// App services
// ---------------------------------------------------------------------------
//
// TODO(tools): re-import these as the `FlowStore`, `CardSink`, and
// `CellHistory` Context.Service classes from `../tools/promote.ts` and
// `../tools/ui.ts` once the tools layer declares them. The shapes below are
// the agreed interfaces, restated here so this file compiles against a tools
// directory that does not exist yet.

/** What `flows/write-flow` writes into. Upstream ships a filesystem one. */
export interface FlowStore {
  readonly write: (id: string, files: Record<string, string>) => Effect.Effect<{ files: Array<string> }>
  readonly list: () => Effect.Effect<Array<FlowSummary>>
}

/** Where `ui/pane` puts a card. The turn stream is the other half. */
export interface CardSink {
  readonly emit: (card: AppCard) => Effect.Effect<void>
  readonly update: (card: AppCard) => Effect.Effect<void>
}

/** The source of every cell the current turn executed. */
export interface CellHistory {
  readonly cells: () => Effect.Effect<ReadonlyArray<{ ordinal: number; source: string }>>
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     role TEXT NOT NULL,
     text TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS cards (
     id TEXT PRIMARY KEY,
     json TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS flows (
     id TEXT PRIMARY KEY,
     description TEXT NOT NULL,
     files_json TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  // Only the registry object has rows here; see the class comment.
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     status TEXT NOT NULL,
     stage TEXT NOT NULL,
     at INTEGER NOT NULL
   )`
] as const

type MessageRow = {
  readonly id: string
  readonly role: string
  readonly text: string
  readonly at: number
}

type CardRow = {
  readonly id: string
  readonly json: string
  readonly at: number
}

type FlowRow = {
  readonly id: string
  readonly description: string
  readonly files_json: string
  readonly at: number
}

type SessionRow = {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly stage: string
  readonly at: number
}

const isStatus = (value: string): value is SessionSummary["status"] =>
  value === "ready" || value === "running" || value === "failed" || value === "idle"

const isRole = (value: string): value is Message["role"] =>
  value === "user" || value === "assistant" || value === "system"

// ---------------------------------------------------------------------------
// The object
// ---------------------------------------------------------------------------

export class AppSession extends DurableObject<Env> {
  /**
   * True while a turn is streaming. Transient on purpose: an eviction ends
   * every stream this object was serving, so a `busy` that survived it would
   * be a lie the next reader could not clear.
   */
  private busy = false

  /**
   * Cancellation, one controller per turn or flow run in flight.
   *
   * workerd forbids one request touching another request's I/O, so `cancel`
   * does not reach into the turn's `fetch`. It aborts a controller the work
   * itself is watching, and the work checks `signal.aborted` between frames.
   * That is the same shape the flows canary settled on for its own server-side
   * turn kill.
   *
   * The set is not keyed by session id: this object is one session, so every
   * controller in it belongs to the session `cancel` names.
   */
  private readonly cancels = new Set<AbortController>()

  /**
   * The id of the flow this session last ran, which is the `stage` the Recent
   * column shows. Transient: it is only read while work this object started is
   * still in flight.
   */
  private stage = ""

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    for (const statement of SCHEMA) ctx.storage.sql.exec(statement)
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql
  }

  // -- transcript ----------------------------------------------------------

  /** Appends one transcript row and returns it. */
  appendMessage(role: Message["role"], text: string): Message {
    const message: Message = { id: crypto.randomUUID(), role, text, at: Date.now() }
    this.sql.exec(
      "INSERT INTO messages (id, role, text, at) VALUES (?, ?, ?, ?)",
      message.id,
      message.role,
      message.text,
      message.at
    )
    return message
  }

  /** Persists a card, replacing any earlier version with the same id. */
  appendCard(card: AppCard): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO cards (id, json, at) VALUES (?, ?, ?)",
      card.id,
      JSON.stringify(card),
      Date.now()
    )
  }

  private messages(): Array<Message> {
    return this.sql
      .exec<MessageRow>("SELECT id, role, text, at FROM messages ORDER BY at ASC")
      .toArray()
      .flatMap((row) => (isRole(row.role) ? [{ id: row.id, role: row.role, text: row.text, at: row.at }] : []))
  }

  private cards(): Array<AppCard> {
    return this.sql
      .exec<CardRow>("SELECT id, json, at FROM cards ORDER BY at ASC")
      .toArray()
      .map((row) => JSON.parse(row.json) as AppCard)
  }

  // -- API -----------------------------------------------------------------

  /** `GET /api/session?id=` — everything the shell needs to redraw. */
  state(id: string): SessionState {
    return { id, messages: this.messages(), cards: this.cards(), busy: this.busy }
  }

  /**
   * `POST /api/agent/turn` — one turn, streamed as NDJSON.
   *
   * A second turn on a busy session is refused rather than queued: two turns
   * writing one transcript is a race the shell has no way to render.
   */
  turn(request: TurnRequest): Response {
    if (this.busy) {
      return Response.json(
        { error: "A turn is already streaming for this session." },
        { status: 409 }
      )
    }
    const controller = new AbortController()
    this.cancels.add(controller)
    this.busy = true
    this.stage = request.flowId
    this.register(request.sessionId, request.message, "running")

    const body = runTurn({
      env: this.env,
      session: {
        appendMessage: (role, text) => this.appendMessage(role, text),
        appendCard: (card) => this.appendCard(card),
        writeFlow: (id, description, files) => this.writeFlow(id, description, files),
        listFlows: () => this.listFlows(),
        settle: (status) => this.register(request.sessionId, request.message, status)
      },
      request,
      signal: controller.signal
    })

    // The flag and the controller belong to this stream, so they are cleared
    // where the stream ends rather than where the request returns.
    const tracked = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, out) => out.enqueue(chunk),
        flush: () => {
          this.busy = false
          this.cancels.delete(controller)
        }
      })
    )

    return new Response(tracked, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        // Frames must reach the shell as they are written, not when a proxy
        // decides the body is big enough.
        "x-content-type-options": "nosniff"
      }
    })
  }

  /**
   * `POST /api/agent/turn/cancel` — asks everything in flight to stop.
   *
   * `cancelled` reports whether there was anything to abort, so a shell that
   * pressed Esc after the turn already ended learns that rather than assuming
   * it killed a live turn.
   */
  cancel(sessionId: string): CancelResponse {
    const controllers = [...this.cancels]
    this.cancels.clear()
    for (const controller of controllers) controller.abort()
    if (controllers.length === 0) return { cancelled: false }
    this.register(sessionId, "", "idle")
    return { cancelled: true }
  }

  // -- flows ---------------------------------------------------------------

  /** The flows this session saved, newest first. File flows come from the router. */
  listFlows(): Array<FlowSummary> {
    return this.sql
      .exec<FlowRow>("SELECT id, description, files_json, at FROM flows ORDER BY at DESC")
      .toArray()
      .map((row) => ({
        id: row.id,
        description: row.description,
        source: "saved" as const,
        chat: false
      }))
  }

  /** The `FlowStore.write` half: `flows/write-flow` lands here. */
  writeFlow(id: string, description: string, files: Record<string, string>): { readonly files: Array<string> } {
    const names = Object.keys(files).sort()
    this.sql.exec(
      "INSERT OR REPLACE INTO flows (id, description, files_json, at) VALUES (?, ?, ?, ?)",
      id,
      description,
      JSON.stringify(files),
      Date.now()
    )
    return { files: names }
  }

  /** The source of a saved flow, or `undefined` when this session never saved it. */
  flowFiles(id: string): Record<string, string> | undefined {
    const rows = this.sql
      .exec<FlowRow>("SELECT id, description, files_json, at FROM flows WHERE id = ?", id)
      .toArray()
    const row = rows[0]
    return row === undefined ? undefined : (JSON.parse(row.files_json) as Record<string, string>)
  }

  /**
   * `POST /api/flows/run` — starts one pipeline flow and reports its id.
   *
   * The response carries the execution id and nothing else. The run itself
   * outlives the request: it writes a `flow-run` card immediately, keeps
   * replacing that card as steps settle, and the shell reads the latest
   * version through `GET /api/session?id=`. `ctx.waitUntil` is what keeps the
   * object alive for the writes that land after the response was sent.
   *
   * The router has already refused an unrouted flow and a chat flow
   * (`worker/router.ts`, `flowRunRefusal`), so this only has to run it.
   */
  runFlow(request: FlowRunRequest): FlowRunResponse {
    const executionId = crypto.randomUUID()
    this.appendCard({
      kind: "flow-run",
      id: executionId,
      flowId: request.flowId,
      executionId,
      phase: "running",
      steps: []
    })
    this.stage = request.flowId
    this.register(request.sessionId, request.flowId, "running")
    const controller = new AbortController()
    this.cancels.add(controller)
    this.ctx.waitUntil(this.driveFlow(request, executionId, controller))
    return { executionId }
  }

  /** The half of {@link runFlow} that outlives the response. */
  private async driveFlow(
    request: FlowRunRequest,
    executionId: string,
    controller: AbortController
  ): Promise<void> {
    let phase: FlowRunCard["phase"] = "failed"
    try {
      // Lazy for the reason `turn.ts` is lazy: the flow runtime performs I/O
      // as it loads, and a Worker may not do that in module scope.
      const { runFlowRun } = await import("./flowRunImpl.ts")
      phase = await runFlowRun({
        env: this.env,
        request,
        executionId,
        signal: controller.signal,
        emit: (frame) => {
          if (frame.type === "card" || frame.type === "card.update") this.appendCard(frame.card)
        }
      })
    } catch (cause) {
      // A run that threw still has to leave a settled card behind: a card left
      // on `running` is a spinner the shell has no way to end.
      this.appendCard({
        kind: "flow-run",
        id: executionId,
        flowId: request.flowId,
        executionId,
        phase: "failed",
        steps: [{ name: request.flowId, status: "failed" }],
        error: cause instanceof Error ? cause.message : String(cause)
      })
    } finally {
      this.cancels.delete(controller)
      this.register(request.sessionId, request.flowId, phaseStatus(phase))
    }
  }

  // -- the registry role ---------------------------------------------------

  /**
   * Writes this session's row into the registry object.
   *
   * Fire and forget through `ctx.waitUntil`: the Recent column being one turn
   * stale is a cosmetic loss, and making a turn wait on a second object before
   * its first frame is not. `fallbackTitle` is used only until the session has
   * a user message of its own.
   */
  private register(sessionId: string, fallbackTitle: string, status: SessionSummary["status"]): void {
    if (sessionId === INDEX_SESSION) return
    const summary: SessionSummary = {
      id: sessionId,
      title: this.title(fallbackTitle),
      status,
      stage: this.stage,
      at: Date.now()
    }
    this.ctx.waitUntil(indexSession(this.env).recordSession(summary))
  }

  /** The session's first user message, which is what the Recent column shows. */
  private title(fallback: string): string {
    const rows = this.sql
      .exec<{ text: string }>("SELECT text FROM messages WHERE role = 'user' ORDER BY at ASC LIMIT 1")
      .toArray()
    return titleFrom(rows[0]?.text ?? fallback)
  }

  /**
   * Registry role: records one session's row.
   *
   * The title is written once. A session's first user message names it, and a
   * later turn must not rename a row the user is reading.
   */
  recordSession(summary: SessionSummary): void {
    const existing = this.sql
      .exec<SessionRow>("SELECT id, title, status, stage, at FROM sessions WHERE id = ?", summary.id)
      .toArray()[0]
    this.sql.exec(
      "INSERT OR REPLACE INTO sessions (id, title, status, stage, at) VALUES (?, ?, ?, ?, ?)",
      summary.id,
      existing?.title ?? summary.title,
      summary.status,
      summary.stage,
      summary.at
    )
  }

  /**
   * Registry role: `GET /api/session` with no id.
   *
   * A row is what its session last reported. An object evicted mid-turn never
   * reports the settle, so a `running` row can outlive its turn; the shell
   * learns the truth from `GET /api/session?id=`, which reads the session
   * object itself.
   */
  sessions(): ReadonlyArray<SessionSummary> {
    const rows = this.sql
      .exec<SessionRow>("SELECT id, title, status, stage, at FROM sessions ORDER BY at DESC")
      .toArray()
      .flatMap((row) =>
        isStatus(row.status)
          ? [{ id: row.id, title: row.title, status: row.status, stage: row.stage, at: row.at }]
          : []
      )
    return byRecency(rows)
  }
}

/** What a settled run means for the session's row in the Recent column. */
const phaseStatus = (phase: FlowRunCard["phase"]): SessionSummary["status"] => {
  switch (phase) {
    case "completed":
      return "ready"
    case "failed":
      return "failed"
    case "cancelled":
      return "idle"
    default:
      return "running"
  }
}
