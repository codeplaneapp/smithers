import { CLOUD_WS_ROUTE_PREFIX } from "smithers-shared/LocalApp"

/*
 * The cloud-workspace terminal transport (lane citc): one WebSocket per
 * workspace session, through the Bun tunnel at `/api/cloud-ws/` (the local
 * session capability rides the subprotocol, the bearer never reaches the
 * renderer), to plue's terminal socket — binary frames are stdin/stdout,
 * a text JSON frame resizes. Mirrors PtyClient's stance: keystrokes sent
 * before the socket opens are queued, and the socket reconnects while
 * attachments exist.
 */

export interface CloudTerminalAttachment {
  readonly onOutput: (data: string) => void
}

export interface CloudTerminalClient {
  /** Subscribe to one workspace session's output; the returned function detaches. */
  readonly attach: (repo: string, sessionId: string, attachment: CloudTerminalAttachment) => () => void
  /** Text the user typed, forwarded to the session's stdin as a binary frame. */
  readonly input: (sessionId: string, data: string) => void
  /** A resize control frame; a failure is swallowed (the next fit retries). */
  readonly resize: (sessionId: string, cols: number, rows: number) => void
  /** Close every socket and forget every attachment. */
  readonly dispose: () => void
}

export interface CloudTerminalClientOptions {
  /** The tunnel URL for one session; undefined where no socket can exist (tests, server render). */
  readonly socketUrl: (repo: string, sessionId: string) => string | undefined
  /** The local-session capability subprotocol; undefined means no socket opens. */
  readonly socketProtocol: () => string | undefined
  readonly reconnectMs?: number
}

/** Frames queued per session before its socket opens. */
const MAX_PENDING = 256

/** The same-origin tunnel URL of the page, or undefined outside a browser. */
export const pageCloudSocketUrl = (repo: string, sessionId: string): string | undefined => {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return undefined
  const { protocol, host } = window.location
  const [owner = "", name = ""] = repo.split("/")
  return `${protocol === "https:" ? "wss" : "ws"}://${host}${CLOUD_WS_ROUTE_PREFIX}repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/workspace/sessions/${encodeURIComponent(sessionId)}/terminal`
}

interface Connection {
  socket: WebSocket | undefined
  readonly listeners: Set<CloudTerminalAttachment>
  readonly pending: Array<string>
  reconnect: ReturnType<typeof setTimeout> | undefined
  /** A 1011 attach failure is retried once; the second is surfaced. */
  retriedAttach?: boolean
}

export const createCloudTerminalClient = (options: CloudTerminalClientOptions): CloudTerminalClient => {
  const connections = new Map<string, { readonly repo: string; readonly conn: Connection }>()
  let disposed = false

  const decode = (data: unknown): Promise<string | null> => {
    if (typeof data === "string") return Promise.resolve(data)
    if (data instanceof ArrayBuffer) return Promise.resolve(new TextDecoder().decode(data))
    /* Bun's client delivers binary frames as Buffer (a Uint8Array); a browser as Blob/ArrayBuffer. */
    if (typeof Uint8Array !== "undefined" && data instanceof Uint8Array) {
      return Promise.resolve(new TextDecoder().decode(data))
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return data.arrayBuffer().then((buffer) => new TextDecoder().decode(buffer)).catch(() => null)
    }
    return Promise.resolve(null)
  }

  const scheduleReconnect = (sessionId: string, entry: { readonly repo: string; readonly conn: Connection }): void => {
    if (disposed || entry.conn.reconnect !== undefined) return
    entry.conn.reconnect = setTimeout(() => {
      entry.conn.reconnect = undefined
      ensureSocket(sessionId, entry)
    }, options.reconnectMs ?? 1000)
    ;(entry.conn.reconnect as { unref?: () => void }).unref?.()
  }

  const ensureSocket = (sessionId: string, entry: { readonly repo: string; readonly conn: Connection }): void => {
    const { conn } = entry
    if (disposed || conn.socket !== undefined) return
    const url = options.socketUrl(entry.repo, sessionId)
    const protocol = options.socketProtocol()
    if (url === undefined || protocol === undefined) return
    const opened = new WebSocket(url, [protocol])
    conn.socket = opened
    opened.onopen = () => {
      if (conn.socket !== opened) return
      for (const text of conn.pending) opened.send(new TextEncoder().encode(text))
      conn.pending.length = 0
    }
    opened.onmessage = (event: MessageEvent) => {
      void decode(event.data).then((text) => {
        if (text === null) return
        for (const listener of conn.listeners) listener.onOutput(text)
      })
    }
    opened.onclose = (event: CloseEvent) => {
      if (conn.socket === opened) conn.socket = undefined
      /*
       * plue's close codes (internal/routes/workspace_terminal.go): 1001 "terminal
       * client too slow" and an abnormal 1006 drop reconnect; 1011 "failed to
       * attach terminal" retries once; 1008 "access revoked: …" and a normal
       * 1000 are final — the listeners hear the reason once and the 1 Hz retry
       * never starts.
       */
      if (event.code === 1006 || event.code === 1001 || (event.code === 1011 && !conn.retriedAttach)) {
        if (event.code === 1011) conn.retriedAttach = true
        scheduleReconnect(sessionId, entry)
        return
      }
      const note = event.code === 1008 ? `access revoked${event.reason ? `: ${event.reason.replace(/^access revoked:\s*/, "")}` : ""}` : `session closed${event.reason ? `: ${event.reason}` : ""}`
      for (const listener of conn.listeners) listener.onOutput(`\r\n[${note}]\r\n`)
    }
    opened.onerror = () => {
      // onclose follows; the reconnect is its job.
    }
  }

  const attach: CloudTerminalClient["attach"] = (repo, sessionId, attachment) => {
    let entry = connections.get(sessionId)
    if (entry === undefined) {
      entry = { repo, conn: { socket: undefined, listeners: new Set(), pending: [], reconnect: undefined } }
      connections.set(sessionId, entry)
    }
    entry.conn.listeners.add(attachment)
    ensureSocket(sessionId, entry)
    return () => {
      const current = connections.get(sessionId)
      if (current === undefined) return
      current.conn.listeners.delete(attachment)
      if (current.conn.listeners.size > 0) return
      connections.delete(sessionId)
      current.conn.pending.length = 0
      if (current.conn.reconnect !== undefined) {
        clearTimeout(current.conn.reconnect)
        current.conn.reconnect = undefined
      }
      const closing = current.conn.socket
      current.conn.socket = undefined
      closing?.close()
    }
  }

  const input: CloudTerminalClient["input"] = (sessionId, data) => {
    const entry = connections.get(sessionId)
    if (entry === undefined) return
    const socket = entry.conn.socket
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.send(new TextEncoder().encode(data))
      return
    }
    if (entry.conn.pending.length < MAX_PENDING) entry.conn.pending.push(data)
    else ensureSocket(sessionId, entry)
  }

  const resize: CloudTerminalClient["resize"] = (sessionId, cols, rows) => {
    const entry = connections.get(sessionId)
    const socket = entry?.conn.socket
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "resize", cols, rows }))
    }
  }

  const dispose = (): void => {
    disposed = true
    for (const entry of connections.values()) {
      if (entry.conn.reconnect !== undefined) clearTimeout(entry.conn.reconnect)
      entry.conn.pending.length = 0
      entry.conn.socket?.close()
    }
    connections.clear()
  }

  return { attach, input, resize, dispose }
}
