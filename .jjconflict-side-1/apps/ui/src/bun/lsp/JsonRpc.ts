/*
 * JSON-RPC 2.0 over a child's stdio with the LSP base protocol's
 * `Content-Length` framing (LSP 3.17 "Base Protocol"). No dependency: one
 * reader loop over stdout, one writer on stdin, ids and timeouts here.
 * Notifications from the server go to `onNotification`; the server's own
 * requests (`workspace/configuration`, `client/registerCapability`) are
 * answered by `onRequest`, `null` when it declines.
 */

export type JsonRpcErrorKind = "timeout" | "closed" | "busy" | "response"

export class JsonRpcError extends Error {
  constructor(
    readonly kind: JsonRpcErrorKind,
    message: string,
    /** The server's error code when `kind` is "response". */
    readonly code?: number
  ) {
    super(message)
    this.name = "JsonRpcError"
  }
}

/** The stdio pair of a `Bun.spawn({ stdin: "pipe", stdout: "pipe" })` child. */
export interface JsonRpcIo {
  readonly stdin: { write(chunk: string): number | Promise<number>; flush(): number | Promise<number>; end(): unknown }
  readonly stdout: ReadableStream<Uint8Array>
}

export interface JsonRpcOptions {
  readonly onNotification: (method: string, params: unknown) => void
  /** The answer to a server→client request; undefined answers `null`. */
  readonly onRequest?: (method: string, params: unknown) => unknown
  /** Requests pending past this many reject with kind "busy". */
  readonly maxInFlight?: number
  readonly log?: (line: string) => void
}

export interface JsonRpc {
  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T>
  notify(method: string, params: unknown): void
  /** Rejects every pending request and stops reading. The child is the caller's to end. */
  close(): void
  /** Settles when stdout ends or `close` runs. */
  readonly closed: Promise<void>
}

interface Pending {
  readonly resolve: (value: never) => void
  readonly reject: (error: JsonRpcError) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const HEADER_END = "\r\n\r\n"
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8")

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

export const createJsonRpc = (io: JsonRpcIo, options: JsonRpcOptions): JsonRpc => {
  const log = options.log ?? (() => {})
  const maxInFlight = options.maxInFlight ?? 8
  const pending = new Map<number, Pending>()
  let seq = 0
  let closed = false
  let resolveClosed: () => void = () => {}
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  const send = (message: Record<string, unknown>): void => {
    if (closed) return
    const body = JSON.stringify({ jsonrpc: "2.0", ...message })
    try {
      void io.stdin.write(`Content-Length: ${encoder.encode(body).byteLength}${HEADER_END}${body}`)
      void io.stdin.flush()
    } catch (error) {
      log(`json-rpc write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const settle = (id: number): Pending | undefined => {
    const entry = pending.get(id)
    if (entry === undefined) return undefined
    pending.delete(id)
    clearTimeout(entry.timer)
    return entry
  }

  const dispatch = (message: Record<string, unknown>): void => {
    const { id, method } = message
    if (typeof method === "string") {
      if (id === undefined || id === null) {
        options.onNotification(method, message.params)
        return
      }
      let result: unknown = null
      try {
        result = options.onRequest?.(method, message.params) ?? null
      } catch (error) {
        send({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
        return
      }
      send({ id, result })
      return
    }
    if (typeof id !== "number") return
    const entry = settle(id)
    if (entry === undefined) return
    if (isRecord(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : undefined
      const text = typeof message.error.message === "string" ? message.error.message : "The language server answered an error."
      entry.reject(new JsonRpcError("response", text, code))
      return
    }
    entry.resolve(message.result as never)
  }

  const read = async (): Promise<void> => {
    const reader = io.stdout.getReader()
    let buffer = new Uint8Array(0)
    try {
      while (!closed) {
        const { value, done } = await reader.read()
        if (done) break
        const joined = new Uint8Array(buffer.byteLength + value.byteLength)
        joined.set(buffer)
        joined.set(value, buffer.byteLength)
        buffer = joined
        while (true) {
          const headerEnd = indexOf(buffer, HEADER_END)
          if (headerEnd < 0) break
          const header = decoder.decode(buffer.subarray(0, headerEnd))
          const match = /content-length:\s*(\d+)/i.exec(header)
          if (match === null) {
            buffer = buffer.subarray(headerEnd + HEADER_END.length)
            continue
          }
          const length = Number(match[1])
          const bodyStart = headerEnd + HEADER_END.length
          if (buffer.byteLength < bodyStart + length) break
          const body = decoder.decode(buffer.subarray(bodyStart, bodyStart + length))
          buffer = buffer.subarray(bodyStart + length)
          let parsed: unknown
          try {
            parsed = JSON.parse(body)
          } catch {
            log("json-rpc: a frame was not JSON")
            continue
          }
          if (isRecord(parsed)) dispatch(parsed)
        }
      }
    } catch (error) {
      if (!closed) log(`json-rpc read failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      reader.releaseLock()
      close()
    }
  }

  const close = (): void => {
    if (closed) return
    closed = true
    for (const [id, entry] of pending) {
      pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(new JsonRpcError("closed", "The language server closed."))
    }
    try {
      void io.stdin.end()
    } catch {
      // Already closed with the child.
    }
    resolveClosed()
  }

  void read()

  return {
    request: <T>(method: string, params: unknown, timeoutMs: number): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (closed) {
          reject(new JsonRpcError("closed", "The language server closed."))
          return
        }
        if (pending.size >= maxInFlight) {
          reject(new JsonRpcError("busy", `At most ${maxInFlight} language-server requests may be in flight.`))
          return
        }
        const id = ++seq
        const timer = setTimeout(() => {
          if (settle(id) === undefined) return
          send({ method: "$/cancelRequest", params: { id } })
          reject(new JsonRpcError("timeout", `The language server did not answer ${method} within ${timeoutMs} ms.`))
        }, timeoutMs)
        pending.set(id, { resolve: resolve as (value: never) => void, reject, timer })
        send({ id, method, params })
      }),
    notify: (method, params) => send({ method, params }),
    close,
    closed: closedPromise
  }
}

/** The byte offset of an ASCII needle in the buffer, or -1. */
const indexOf = (haystack: Uint8Array, needle: string): number => {
  const first = needle.charCodeAt(0)
  outer: for (let index = 0; index <= haystack.byteLength - needle.length; index += 1) {
    if (haystack[index] !== first) continue
    for (let offset = 1; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle.charCodeAt(offset)) continue outer
    }
    return index
  }
  return -1
}
