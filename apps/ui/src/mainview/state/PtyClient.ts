import type { FetchLike } from "smithers-shared/NativeAgent"

/*
 * The PTY transport (docs/LOCAL-APP.md "HTTP and WebSocket API"): one
 * WebSocket to `/ws` shared by every terminal and harness tab, plus the
 * resize POST. A tab attaches to its `pty:<sessionId>` topic and receives
 * that session's output and exit; keystrokes go back as `pty.input` frames.
 *
 * The socket opens on the first attachment and reconnects while attachments
 * exist. Frames sent before the socket is open are queued and flushed on
 * open, and every live topic is re-subscribed after a reconnect, so a tab
 * never has to know whether the socket is up.
 */

export interface PtyAttachment {
  readonly onOutput: (data: string) => void
  readonly onExit: (code: number | null) => void
}

export interface PtyClient {
  /** Subscribe to one session's output; the returned function detaches. */
  readonly attach: (sessionId: string, attachment: PtyAttachment) => () => void
  /** Text the user typed, forwarded to the session's stdin. */
  readonly input: (sessionId: string, data: string) => void
  /** `POST /api/pty/:id/resize`; a failure is swallowed (the next fit retries). */
  readonly resize: (sessionId: string, cols: number, rows: number) => Promise<void>
  /** Close the socket and forget every attachment. */
  readonly dispose: () => void
}

export interface PtyClientOptions {
  readonly http: FetchLike
  readonly baseUrl: string
  /** The `/ws` URL; undefined where no socket can exist (tests, server render). */
  readonly socketUrl: () => string | undefined
  /** Per-launch local capability carried as a WebSocket subprotocol. */
  readonly socketProtocols?: () => ReadonlyArray<string>
  readonly reconnectMs?: number
}

type ServerFrame =
  | { readonly type: "pty.output"; readonly sessionId: string; readonly data: string }
  | { readonly type: "pty.exit"; readonly sessionId: string; readonly code: number | null }

const parseFrame = (raw: unknown): ServerFrame | undefined => {
  if (typeof raw !== "string") return undefined
  try {
    const frame: unknown = JSON.parse(raw)
    if (typeof frame !== "object" || frame === null) return undefined
    const { type, sessionId } = frame as { type?: unknown; sessionId?: unknown }
    if (typeof sessionId !== "string") return undefined
    if (type === "pty.output") {
      const { data } = frame as { data?: unknown }
      return typeof data === "string" ? { type, sessionId, data } : undefined
    }
    if (type === "pty.exit") {
      const { code } = frame as { code?: unknown }
      return { type, sessionId, code: typeof code === "number" ? code : null }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** The same-origin `/ws` URL of the page, or undefined outside a browser. */
export const pageSocketUrl = (): string | undefined => {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return undefined
  const { protocol, host } = window.location
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/ws`
}

export const createPtyClient = (options: PtyClientOptions): PtyClient => {
  const attachments = new Map<string, Set<PtyAttachment>>()
  const queue: Array<string> = []
  let socket: WebSocket | undefined
  let disposed = false
  let reconnect: ReturnType<typeof setTimeout> | undefined

  const send = (frame: Record<string, unknown>): void => {
    const text = JSON.stringify(frame)
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.send(text)
      return
    }
    queue.push(text)
    ensureSocket()
  }

  const scheduleReconnect = (): void => {
    if (disposed || attachments.size === 0 || reconnect !== undefined) return
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
      // Every live topic first, so output resumes before queued input goes out.
      for (const sessionId of attachments.keys()) {
        opened.send(JSON.stringify({ type: "subscribe", topic: `pty:${sessionId}` }))
      }
      for (const text of queue.splice(0)) opened.send(text)
    }
    opened.onmessage = (event: MessageEvent) => {
      const frame = parseFrame(event.data)
      if (frame === undefined) return
      const listeners = attachments.get(frame.sessionId)
      if (listeners === undefined) return
      for (const listener of listeners) {
        if (frame.type === "pty.output") listener.onOutput(frame.data)
        else listener.onExit(frame.code)
      }
    }
    opened.onclose = () => {
      if (socket === opened) socket = undefined
      scheduleReconnect()
    }
    opened.onerror = () => {
      // onclose follows; nothing to do here beyond letting it reconnect.
    }
  }

  const attach: PtyClient["attach"] = (sessionId, attachment) => {
    const listeners = attachments.get(sessionId) ?? new Set<PtyAttachment>()
    const first = listeners.size === 0
    listeners.add(attachment)
    attachments.set(sessionId, listeners)
    if (first) {
      if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "subscribe", topic: `pty:${sessionId}` }))
      } else {
        // onopen subscribes every attached topic; only make sure a socket is coming.
        ensureSocket()
      }
    }
    return () => {
      const current = attachments.get(sessionId)
      if (current === undefined) return
      current.delete(attachment)
      if (current.size > 0) return
      attachments.delete(sessionId)
      if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "unsubscribe", topic: `pty:${sessionId}` }))
      }
    }
  }

  const input: PtyClient["input"] = (sessionId, data) => {
    send({ type: "pty.input", sessionId, data })
  }

  const resize: PtyClient["resize"] = async (sessionId, cols, rows) => {
    try {
      await options.http(`${options.baseUrl}/api/pty/${encodeURIComponent(sessionId)}/resize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cols, rows })
      })
    } catch {
      // The next fit sends the geometry again; a missed resize is not an error state.
    }
  }

  const dispose = (): void => {
    disposed = true
    if (reconnect !== undefined) clearTimeout(reconnect)
    attachments.clear()
    queue.length = 0
    const closing = socket
    socket = undefined
    closing?.close()
  }

  return { attach, input, resize, dispose }
}
