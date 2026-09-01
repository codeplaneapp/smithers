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
  readonly push: (chunk: Uint8Array) => ReadonlyArray<unknown>
}

const failure = (code: StdError.Code, message: string): StdError.StdError => new StdError.StdError({ code, message })

const indexOfHeaderEnd = (bytes: Uint8Array): number => {
  for (let index = 0; index <= bytes.length - 4; index++) {
    if (
      bytes[index] === 13
      && bytes[index + 1] === 10
      && bytes[index + 2] === 13
      && bytes[index + 3] === 10
    ) return index
  }
  return -1
}

const append = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const combined = new Uint8Array(left.length + right.length)
  combined.set(left)
  combined.set(right, left.length)
  return combined
}

const makeFrameDecoder = (): FrameDecoder => {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array()
  return {
    push: (chunk) => {
      pending = append(pending, chunk)
      const messages: Array<unknown> = []
      while (pending.length > 0) {
        const headerEnd = indexOfHeaderEnd(pending)
        if (headerEnd < 0) break
        const header = new TextDecoder().decode(pending.slice(0, headerEnd))
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(header)
        if (match === null) {
          pending = pending.slice(headerEnd + 4)
          continue
        }
        const length = Number(match[1])
        const bodyStart = headerEnd + 4
        if (!Number.isSafeInteger(length) || length < 0 || pending.length < bodyStart + length) break
        const body = pending.slice(bodyStart, bodyStart + length)
        pending = pending.slice(bodyStart + length)
        try {
          messages.push(JSON.parse(new TextDecoder().decode(body)) as unknown)
        } catch {
          // Invalid server frames are ignored; the matching request times out
          // with the stable request failure below.
        }
      }
      return messages
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
  return append(header, body)
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

    const failPending = (error: StdError.StdError): Effect.Effect<void> =>
      Effect.forEach(
        pending.values(),
        (deferred) => Deferred.fail(deferred, error),
        { discard: true }
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

    yield* handle.stdout.pipe(
      Stream.runForEach((chunk) => Effect.forEach(decoder.push(chunk), receive, { discard: true })),
      Effect.catch(() => failPending(failure("request_failed", "Language server output stream failed"))),
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
      Queue.offer(input, frame(message)).pipe(Effect.asVoid)

    const request = (
      method: string,
      params: unknown
    ): Effect.Effect<unknown, StdError.StdError> =>
      Effect.gen(function*() {
        const id = nextId++
        const deferred = yield* Deferred.make<unknown, StdError.StdError>()
        pending.set(id, deferred)
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
