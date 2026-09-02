/**
 * Host-backed Language Server Protocol client over the permission-checked
 * process spawner.
 *
 * LSP is framed JSON-RPC over ordinary stdio pipes, so the client spawns
 * through `@smthrs/kernel`'s `ChildProcessSpawner`; a terminal is never
 * involved.
 *
 * Governing plan:
 * `docs/specs/Research/Agent Ecosystem Plan 2026-07-28.md`.
 *
 * @since 0.1.0
 */
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Deferred, Effect, Layer, Queue, type Scope, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { pathToFileURL } from "node:url"
import * as LanguageServer from "./LanguageServer.ts"
import * as StdError from "./StdError.ts"

/**
 * One host language-server process.
 *
 * Response headers may contain at most 8 KiB, and response bodies may contain
 * at most 8 MiB.
 *
 * @category models
 * @since 0.1.0
 */
export interface Config {
  readonly command: string
  readonly args?: ReadonlyArray<string> | undefined
  readonly cwd: string
  readonly environment?: Readonly<Record<string, string>> | undefined
  readonly timeoutMs?: number | undefined
}

interface JsonRpcMessage {
  readonly id?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

interface FrameDecoder {
  readonly push: (chunk: Uint8Array) => ReadonlyArray<FrameEvent>
}

type FrameEvent =
  | { readonly _tag: "Message"; readonly value: unknown }
  | { readonly _tag: "Failure"; readonly error: StdError.StdError; readonly id?: number | undefined }

const failure = (code: StdError.Code, message: string): StdError.StdError => new StdError.StdError({ code, message })

const maximumHeaderBytes = 8 * 1024
const maximumFrameBytes = 8 * 1024 * 1024
const headerEnd = new Uint8Array([13, 10, 13, 10])
const contentLengthPrefix = new TextEncoder().encode("Content-Length:")

const concatenate = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const combined = new Uint8Array(left.length + right.length)
  combined.set(left)
  combined.set(right, left.length)
  return combined
}

interface ChunkBuffer {
  readonly length: number
  readonly push: (chunk: Uint8Array) => void
  readonly indexOf: (needle: Uint8Array) => number
  readonly take: (length: number) => Uint8Array
  readonly discard: (length: number) => void
}

const makeChunkBuffer = (): ChunkBuffer => {
  let chunks: Array<Uint8Array> = []
  let head = 0
  let headOffset = 0
  let length = 0

  const compact = (): void => {
    if (head === chunks.length) {
      chunks = []
      head = 0
      headOffset = 0
    } else if (head >= 64 && head * 2 >= chunks.length) {
      chunks = chunks.slice(head)
      head = 0
    }
  }

  const consume = (count: number, output?: Uint8Array): void => {
    let remaining = count
    let outputOffset = 0
    while (remaining > 0) {
      const chunk = chunks[head]
      if (chunk === undefined) throw new RangeError("Chunk buffer underflow")
      const available = chunk.byteLength - headOffset
      const consumed = Math.min(available, remaining)
      if (output !== undefined) {
        output.set(chunk.subarray(headOffset, headOffset + consumed), outputOffset)
        outputOffset += consumed
      }
      headOffset += consumed
      length -= consumed
      remaining -= consumed
      if (headOffset === chunk.byteLength) {
        head++
        headOffset = 0
      }
    }
    compact()
  }

  return {
    get length() {
      return length
    },
    push: (chunk) => {
      if (chunk.byteLength === 0) return
      chunks.push(chunk)
      length += chunk.byteLength
    },
    indexOf: (needle) => {
      let absolute = 0
      let matched = 0
      for (let chunkIndex = head; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex]
        if (chunk === undefined) continue
        const start = chunkIndex === head ? headOffset : 0
        for (let index = start; index < chunk.byteLength; index++) {
          const byte = chunk[index]
          if (byte === needle[matched]) matched++
          else matched = byte === needle[0] ? 1 : 0
          if (matched === needle.byteLength) return absolute - needle.byteLength + 1
          absolute++
        }
      }
      return -1
    },
    take: (count) => {
      if (count < 0 || count > length) throw new RangeError("Chunk buffer underflow")
      const output = new Uint8Array(count)
      consume(count, output)
      return output
    },
    discard: (count) => {
      if (count < 0 || count > length) throw new RangeError("Chunk buffer underflow")
      consume(count)
    }
  }
}

const malformedId = (body: string): number | undefined => {
  const match = /"id"\s*:\s*(\d+)/.exec(body)
  if (match === null) return undefined
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : undefined
}

const makeFrameDecoder = (): FrameDecoder => {
  const pending = makeChunkBuffer()
  let bodyLength: number | undefined
  let resynchronizing = false
  return {
    push: (chunk) => {
      pending.push(chunk)
      const events: Array<FrameEvent> = []
      while (pending.length > 0 || bodyLength === 0) {
        if (resynchronizing) {
          const nextHeader = pending.indexOf(contentLengthPrefix)
          if (nextHeader < 0) {
            pending.discard(Math.max(0, pending.length - contentLengthPrefix.byteLength + 1))
            break
          }
          pending.discard(nextHeader)
          resynchronizing = false
        }
        if (bodyLength !== undefined) {
          if (pending.length < bodyLength) break
          const body = new TextDecoder().decode(pending.take(bodyLength))
          bodyLength = undefined
          try {
            events.push({ _tag: "Message", value: JSON.parse(body) as unknown })
          } catch {
            events.push({
              _tag: "Failure",
              error: failure("request_failed", "Language server returned malformed JSON"),
              id: malformedId(body)
            })
          }
          continue
        }
        const delimiter = pending.indexOf(headerEnd)
        if (delimiter < 0) {
          if (pending.length > maximumHeaderBytes) {
            events.push({
              _tag: "Failure",
              error: failure(
                "request_failed",
                `Language server frame header exceeded ${maximumHeaderBytes} bytes`
              )
            })
            pending.discard(1)
            resynchronizing = true
            continue
          }
          break
        }
        if (delimiter > maximumHeaderBytes) {
          events.push({
            _tag: "Failure",
            error: failure("request_failed", `Language server frame header exceeded ${maximumHeaderBytes} bytes`)
          })
          pending.discard(delimiter + headerEnd.byteLength)
          resynchronizing = true
          continue
        }
        const header = new TextDecoder().decode(pending.take(delimiter))
        pending.discard(headerEnd.byteLength)
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(header)
        if (match === null) {
          events.push({
            _tag: "Failure",
            error: failure("request_failed", "Language server frame omitted Content-Length")
          })
          resynchronizing = true
          continue
        }
        const length = Number(match[1])
        if (!Number.isSafeInteger(length) || length < 0 || length > maximumFrameBytes) {
          events.push({
            _tag: "Failure",
            error: failure("request_failed", `Language server frame exceeded ${maximumFrameBytes} bytes`)
          })
          resynchronizing = true
          continue
        }
        bodyLength = length
      }
      return events
    }
  }
}

const asMessage = (value: unknown): JsonRpcMessage | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined

const frame = (message: unknown): Uint8Array => {
  const body = new TextEncoder().encode(JSON.stringify(message))
  const header = new TextEncoder().encode(`Content-Length: ${body.byteLength}\r\n\r\n`)
  return concatenate(header, body)
}

const positionParams = (position: LanguageServer.Position) => ({
  textDocument: { uri: pathToFileURL(position.path).href },
  position: { line: position.line, character: position.character }
})

const firstCallHierarchyItem = (value: unknown): unknown | undefined => Array.isArray(value) ? value[0] : undefined

/**
 * Constructs one scoped host language-server client.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  config: Config
): Effect.Effect<
  LanguageServer.LanguageServer,
  StdError.StdError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // The process's stdin is fed from this queue for the client's lifetime, so
    // each request is one offered frame and the pipe never closes between them.
    const input = yield* Queue.unbounded<Uint8Array>()
    const handle = yield* spawner.spawn(
      ChildProcess.make(config.command, config.args ?? [], {
        cwd: config.cwd,
        ...(config.environment === undefined ? {} : { env: config.environment }),
        stdin: { stream: Stream.fromQueue(input), endOnDone: false }
      })
    ).pipe(
      Effect.mapError(() => failure("provider_unavailable", "Language server process could not be started"))
    )
    const pending = new Map<number, Deferred.Deferred<unknown, StdError.StdError>>()
    const decoder = makeFrameDecoder()
    let nextId = 1
    let terminalError: StdError.StdError | undefined

    const failPending = (error: StdError.StdError): Effect.Effect<void> =>
      Effect.flatMap(
        Effect.sync(() => {
          const deferreds = [...pending.values()]
          pending.clear()
          return deferreds
        }),
        (deferreds) => Effect.forEach(deferreds, (deferred) => Deferred.fail(deferred, error), { discard: true })
      )

    const failRequest = (id: number, error: StdError.StdError): Effect.Effect<void> => {
      const deferred = pending.get(id)
      if (deferred === undefined) return Effect.void
      pending.delete(id)
      return Deferred.fail(deferred, error).pipe(Effect.asVoid)
    }

    const closeWith = (error: StdError.StdError): Effect.Effect<void> =>
      Effect.flatMap(
        Effect.sync(() => {
          terminalError ??= error
          return terminalError
        }),
        failPending
      )

    const receive = (value: unknown): Effect.Effect<void> => {
      const message = asMessage(value)
      if (message === undefined || typeof message.id !== "number") return Effect.void
      const deferred = pending.get(message.id)
      if (deferred === undefined) return Effect.void
      pending.delete(message.id)
      return message.error === undefined
        ? Deferred.succeed(deferred, message.result)
        : Deferred.fail(deferred, failure("request_failed", "Language server returned a JSON-RPC error"))
    }

    const receiveFrame = (event: FrameEvent): Effect.Effect<void> =>
      event._tag === "Message"
        ? receive(event.value)
        // A rejected frame has no trustworthy response id. Failing every
        // waiter prevents another request from hanging behind corrupt framing.
        : event.id === undefined
        ? failPending(event.error)
        : failRequest(event.id, event.error)

    yield* handle.stdout.pipe(
      Stream.runForEach((chunk) => Effect.forEach(decoder.push(chunk), receiveFrame, { discard: true })),
      Effect.matchEffect({
        onFailure: () => closeWith(failure("request_failed", "Language server output stream failed")),
        onSuccess: () => closeWith(failure("request_failed", "Language server output stream closed"))
      }),
      Effect.forkScoped({ startImmediately: true })
    )

    yield* handle.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        closeWith(failure("request_failed", `Language server process exited with code ${exitCode}`))
      ),
      Effect.catch(() => closeWith(failure("request_failed", "Language server process exited"))),
      Effect.forkScoped({ startImmediately: true })
    )

    // Unconsumed stderr would eventually stall a chatty server on pipe
    // backpressure; the diagnostics channel for failures is the JSON-RPC
    // response, so stderr is drained and discarded.
    yield* handle.stderr.pipe(
      Stream.runDrain,
      Effect.catch((cause) => Effect.logWarning("Language server stderr stream failed", cause)),
      Effect.forkScoped({ startImmediately: true })
    )

    const send = (message: unknown): Effect.Effect<void, StdError.StdError> =>
      Effect.suspend(() =>
        terminalError === undefined
          ? Queue.offer(input, frame(message)).pipe(Effect.asVoid)
          : Effect.fail(terminalError)
      )

    const request = (
      method: string,
      params: unknown
    ): Effect.Effect<unknown, StdError.StdError> =>
      Effect.gen(function*() {
        const id = nextId++
        const deferred = yield* Deferred.make<unknown, StdError.StdError>()
        const closed = yield* Effect.sync(() => {
          if (terminalError !== undefined) return terminalError
          pending.set(id, deferred)
          return undefined
        })
        if (closed !== undefined) return yield* Effect.fail(closed)
        yield* send({ jsonrpc: "2.0", id, method, params })
        return yield* Deferred.await(deferred).pipe(
          Effect.timeout(config.timeoutMs ?? 30_000),
          Effect.mapError((cause) =>
            cause instanceof StdError.StdError
              ? cause
              : failure("timeout", `Language server request timed out: ${method}`)
          ),
          Effect.ensuring(
            Effect.sync(() => {
              pending.delete(id)
            })
          )
        )
      })

    const notify = (method: string, params: unknown): Effect.Effect<void, StdError.StdError> =>
      send({ jsonrpc: "2.0", method, params })

    yield* request("initialize", {
      processId: null,
      rootUri: pathToFileURL(config.cwd).href,
      capabilities: {}
    })
    yield* notify("initialized", {})

    const prepareCallHierarchy = (position: LanguageServer.Position) =>
      request("textDocument/prepareCallHierarchy", positionParams(position))
    const callHierarchy = (
      method: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
      position: LanguageServer.Position
    ): Effect.Effect<unknown, StdError.StdError> =>
      prepareCallHierarchy(position).pipe(
        Effect.flatMap((prepared) => {
          const item = firstCallHierarchyItem(prepared)
          return item === undefined ? Effect.succeed([]) : request(method, { item })
        })
      )

    return LanguageServer.make({
      hover: (position) => request("textDocument/hover", positionParams(position)),
      definition: (position) => request("textDocument/definition", positionParams(position)),
      references: (position) =>
        request("textDocument/references", {
          ...positionParams(position),
          context: { includeDeclaration: true }
        }),
      implementation: (position) => request("textDocument/implementation", positionParams(position)),
      documentSymbols: (path) =>
        request("textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(path).href } }),
      workspaceSymbols: (query) => request("workspace/symbol", { query }),
      prepareCallHierarchy,
      callHierarchyIncoming: (position) => callHierarchy("callHierarchy/incomingCalls", position),
      callHierarchyOutgoing: (position) => callHierarchy("callHierarchy/outgoingCalls", position),
      diagnostics: (path) => request("textDocument/diagnostic", { textDocument: { uri: pathToFileURL(path).href } })
    })
  })

/**
 * Provides a scoped host language-server implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  config: Config
): Layer.Layer<LanguageServer.LanguageServer, StdError.StdError, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(LanguageServer.LanguageServer, make(config))
