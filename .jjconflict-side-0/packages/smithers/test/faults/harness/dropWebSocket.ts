/**
 * Dropping the WebSocket a control client is streaming over.
 *
 * `@smthrs/control`'s `ControlClient` takes its socket from
 * `Socket.WebSocketConstructor`, the same seam `@smthrs/cli` uses to attach a
 * bearer credential. Handing it {@link trackingWebSocketConstructor} keeps the
 * real `ws` client and only records the instances, so a fault suite can reach
 * the live socket and cut it the way a network does.
 *
 * @since 1.0.0
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket"

/**
 * How a socket is taken away.
 *
 * `abrupt` destroys the TCP connection without a close frame, so the peer
 * learns about it from a read error — the shape a lost network gives. `close`
 * sends a normal closing handshake.
 *
 * @since 1.0.0
 * @category models
 */
export type DropMode = "abrupt" | "close"

/** The half of the `ws` client surface this harness drives. */
export interface DroppableSocket {
  readonly readyState: number
  close: (code?: number) => void
  terminate?: () => void
  once: (event: "close", listener: () => void) => unknown
}

const CLOSED = 3

/**
 * Drops one socket and resolves when it reports closed.
 *
 * @since 1.0.0
 * @category constructors
 */
export const dropWebSocket = async (socket: DroppableSocket, mode: DropMode = "abrupt"): Promise<void> => {
  if (socket.readyState === CLOSED) return
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => resolve())
  })
  if (mode === "close") socket.close(1000)
  else if (typeof socket.terminate === "function") socket.terminate()
  else socket.close(1006)
  await closed
}

/**
 * A tracked `Socket.WebSocketConstructor`.
 *
 * @since 1.0.0
 * @category models
 */
export interface TrackedWebSockets {
  /** The value to provide as `Socket.WebSocketConstructor`. */
  readonly construct: (address: string, protocols?: string | ReadonlyArray<string>) => globalThis.WebSocket
  /** Every socket constructed so far, oldest first. */
  readonly sockets: ReadonlyArray<DroppableSocket>
  /** How many sockets have been constructed. A reconnect is a second one. */
  readonly opened: () => number
  /** Drops the most recently constructed socket. */
  readonly dropLatest: (mode?: DropMode) => Promise<void>
}

/**
 * Builds a WebSocket constructor that keeps every socket it makes.
 *
 * `credential` is attached as a bearer header, matching what the CLI's remote
 * transport does, so a tracked client authenticates exactly like a real one.
 *
 * @since 1.0.0
 * @category constructors
 */
export const trackingWebSocketConstructor = (credential?: string): TrackedWebSockets => {
  const sockets: Array<DroppableSocket> = []
  const construct = (address: string, protocols?: string | ReadonlyArray<string>): globalThis.WebSocket => {
    const socket = new NodeSocket.NodeWS.WebSocket(
      address,
      protocols as string | Array<string> | undefined,
      credential === undefined ? {} : { headers: { authorization: `Bearer ${credential}` } }
    )
    sockets.push(socket as unknown as DroppableSocket)
    return socket as unknown as globalThis.WebSocket
  }
  return {
    construct,
    sockets,
    opened: () => sockets.length,
    dropLatest: async (mode: DropMode = "abrupt") => {
      const socket = sockets[sockets.length - 1]
      if (socket === undefined) throw new Error("dropLatest: no socket has been constructed yet")
      await dropWebSocket(socket, mode)
    }
  }
}
