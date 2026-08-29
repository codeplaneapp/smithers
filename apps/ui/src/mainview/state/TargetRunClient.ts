import type { TargetRunFrame } from "smithers-shared/LocalApp"
import { TargetRunMessageSchema } from "smithers-shared/LocalApp"

/*
 * The target-run transport (docs/LOCAL-APP.md "HTTP and WebSocket API"):
 * one WebSocket to `/ws` shared by every run card. Attaching to a run
 * subscribes its `target-run:<runId>` topic and announces the attachment
 * (`target-run.attach`), which is what starts the child on the server, so no
 * frame is published before anyone listens. Frames sent before the socket is
 * open wait for it; every live topic is re-subscribed after a reconnect.
 */

export interface TargetRunClient {
  /** Subscribe to one run's frames; the returned function detaches. */
  readonly attach: (runId: string, onFrame: (frame: TargetRunFrame) => void) => () => void
  readonly dispose: () => void
}

export interface TargetRunClientOptions {
  /** The `/ws` URL; undefined where no socket can exist (tests, server render). */
  readonly socketUrl: () => string | undefined
  /** Per-launch local capability carried as a WebSocket subprotocol. */
  readonly socketProtocols?: () => ReadonlyArray<string>
  readonly reconnectMs?: number
}

export const createTargetRunClient = (options: TargetRunClientOptions): TargetRunClient => {
  const listeners = new Map<string, Set<(frame: TargetRunFrame) => void>>()
  let socket: WebSocket | undefined
  let disposed = false
  let reconnect: ReturnType<typeof setTimeout> | undefined

  const announce = (target: WebSocket, runId: string): void => {
    target.send(JSON.stringify({ type: "subscribe", topic: `target-run:${runId}` }))
    target.send(JSON.stringify({ type: "target-run.attach", runId }))
  }

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
      for (const runId of listeners.keys()) announce(opened, runId)
    }
    opened.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        return
      }
      const message = TargetRunMessageSchema.safeParse(parsed)
      if (!message.success) return
      const set = listeners.get(message.data.runId)
      if (set === undefined) return
      for (const listener of set) listener(message.data.frame)
    }
    opened.onclose = () => {
      if (socket === opened) socket = undefined
      scheduleReconnect()
    }
    opened.onerror = () => {
      // onclose follows and schedules the reconnect.
    }
  }

  const attach: TargetRunClient["attach"] = (runId, onFrame) => {
    const set = listeners.get(runId) ?? new Set<(frame: TargetRunFrame) => void>()
    const first = set.size === 0
    set.add(onFrame)
    listeners.set(runId, set)
    if (first) {
      if (socket !== undefined && socket.readyState === WebSocket.OPEN) announce(socket, runId)
      else ensureSocket()
    }
    return () => {
      const current = listeners.get(runId)
      if (current === undefined) return
      current.delete(onFrame)
      if (current.size > 0) return
      listeners.delete(runId)
      if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "unsubscribe", topic: `target-run:${runId}` }))
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

  return { attach, dispose }
}
