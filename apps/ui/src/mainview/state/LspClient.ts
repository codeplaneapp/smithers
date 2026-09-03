/*
 * The code-intel transport (docs/LOCAL-APP.md "/api/lsp/*", docs/code-intel/
 * PLAN.md §3): the three POST routes of the local origin, answered as typed
 * bodies or typed refusals, and one `/ws` subscription per repository on
 * `lsp:<repoId>` carrying the language server's diagnostics publications. The
 * renderer names a repoId, a repository-relative path and a 1-based position;
 * the host owns the binary, its argv and its cwd, so nothing here knows what
 * a TypeScript server is.
 *
 * The socket follows PtyClient.ts / TargetRunClient.ts: it opens on the first
 * subscription, re-subscribes every live topic after a reconnect, and closes
 * with the controller. Frames are validated against the shared schema; an
 * over-cap or malformed frame is dropped, never rendered.
 */
import {
  LSP_DEFINITION_PATH,
  LSP_DIAGNOSTICS_PATH,
  LSP_HOVER_PATH,
  LspDefinitionResponseSchema,
  LspDiagnosticsMessageSchema,
  LspDiagnosticsResponseSchema,
  LspErrorResponseSchema,
  LspHoverResponseSchema,
  lspTopic
} from "@smthrs/rpc/LocalApp"
import type {
  LspDefinitionResponse,
  LspDiagnosticsMessage,
  LspDiagnosticsResponse,
  LspFileRequest,
  LspHoverResponse,
  LspPositionRequest
} from "@smthrs/rpc/LocalApp"
import type { z } from "zod"

/**
 * A refusal as the host typed it (`{ error: { code, message, install? } }`),
 * or the transport's own: `unreachable` when the local app did not answer,
 * `unreadable` when what it answered failed the shared schema.
 */
export interface LspRefusal {
  readonly code: string
  readonly message: string
  /** The install line, verbatim, on `language_server_missing`; the card prints it and nothing installs it. */
  readonly install?: string
}

export type LspAnswer<T> = { readonly ok: T } | { readonly refusal: LspRefusal }

export interface LspClient {
  readonly hover: (request: LspPositionRequest) => Promise<LspAnswer<LspHoverResponse>>
  readonly definition: (request: LspPositionRequest) => Promise<LspAnswer<LspDefinitionResponse>>
  readonly diagnostics: (request: LspFileRequest) => Promise<LspAnswer<LspDiagnosticsResponse>>
  /** Subscribe to one repository's diagnostics publications; the returned function detaches. */
  readonly subscribe: (repoId: string, onDiagnostics: (message: LspDiagnosticsMessage) => void) => () => void
  /** Close the socket and forget every subscription. */
  readonly dispose: () => void
}

export interface LspClientOptions {
  /** The controller's bounded, tapped fetch (SeamContext.http). */
  readonly http: (input: string, init?: RequestInit) => Promise<Response>
  readonly baseUrl: string
  /** The `/ws` URL; undefined where no socket can exist (tests, server render). */
  readonly socketUrl: () => string | undefined
  /** Per-launch local capability carried as a WebSocket subprotocol. */
  readonly socketProtocols?: () => ReadonlyArray<string>
  readonly reconnectMs?: number
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

export const createLspClient = (options: LspClientOptions): LspClient => {
  const post = async <Schema extends z.ZodType>(
    path: string,
    body: LspPositionRequest | LspFileRequest,
    schema: Schema
  ): Promise<LspAnswer<z.infer<Schema>>> => {
    let response: Response
    try {
      response = await options.http(`${options.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      })
    } catch (error) {
      return { refusal: { code: "unreachable", message: `Could not reach the local app's language server: ${errorText(error)}` } }
    }
    const json: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const typed = LspErrorResponseSchema.safeParse(json)
      return {
        refusal: typed.success
          ? typed.data.error
          : { code: `http_${response.status}`, message: `The local app's language server route answered ${response.status}.` }
      }
    }
    const parsed = schema.safeParse(json)
    return parsed.success
      ? { ok: parsed.data as z.infer<Schema> }
      : { refusal: { code: "unreadable", message: "The local app answered the language server request with an unreadable payload." } }
  }

  const listeners = new Map<string, Set<(message: LspDiagnosticsMessage) => void>>()
  let socket: WebSocket | undefined
  let disposed = false
  let reconnect: ReturnType<typeof setTimeout> | undefined

  const scheduleReconnect = (): void => {
    if (disposed || listeners.size === 0 || reconnect !== undefined) return
    reconnect = setTimeout(() => {
      reconnect = undefined
      ensureSocket()
    }, options.reconnectMs ?? 1000)
    ;(reconnect as { unref?: () => void }).unref?.()
  }

  const ensureSocket = (): void => {
    if (disposed || socket !== undefined) return
    const url = options.socketUrl()
    if (url === undefined) return
    const protocols = options.socketProtocols?.() ?? []
    const opened = protocols.length === 0 ? new WebSocket(url) : new WebSocket(url, [...protocols])
    socket = opened
    opened.onopen = () => {
      if (socket !== opened) return
      for (const repoId of listeners.keys()) opened.send(JSON.stringify({ type: "subscribe", topic: lspTopic(repoId) }))
    }
    opened.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        return
      }
      const message = LspDiagnosticsMessageSchema.safeParse(parsed)
      if (!message.success) return
      const set = listeners.get(message.data.repoId)
      if (set === undefined) return
      for (const listener of set) listener(message.data)
    }
    opened.onclose = () => {
      if (socket === opened) socket = undefined
      scheduleReconnect()
    }
    opened.onerror = () => {
      // onclose follows and schedules the reconnect.
    }
  }

  const subscribe: LspClient["subscribe"] = (repoId, onDiagnostics) => {
    const set = listeners.get(repoId) ?? new Set<(message: LspDiagnosticsMessage) => void>()
    const first = set.size === 0
    set.add(onDiagnostics)
    listeners.set(repoId, set)
    if (first) {
      if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "subscribe", topic: lspTopic(repoId) }))
      } else {
        ensureSocket()
      }
    }
    return () => {
      const current = listeners.get(repoId)
      if (current === undefined) return
      current.delete(onDiagnostics)
      if (current.size > 0) return
      listeners.delete(repoId)
      if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "unsubscribe", topic: lspTopic(repoId) }))
      }
    }
  }

  const dispose = (): void => {
    disposed = true
    if (reconnect !== undefined) clearTimeout(reconnect)
    listeners.clear()
    const closing = socket
    socket = undefined
    closing?.close()
  }

  return {
    hover: (request) => post(LSP_HOVER_PATH, request, LspHoverResponseSchema),
    definition: (request) => post(LSP_DEFINITION_PATH, request, LspDefinitionResponseSchema),
    diagnostics: (request) => post(LSP_DIAGNOSTICS_PATH, request, LspDiagnosticsResponseSchema),
    subscribe,
    dispose
  }
}
