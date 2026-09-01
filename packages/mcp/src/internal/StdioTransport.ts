/**
 * Newline-delimited JSON-RPC transport over a spawned MCP server's stdio.
 *
 * This module owns exactly the connection lifecycle and request/reply
 * correlation an MCP session needs: spawn once, write frames in, read frames
 * out, match replies to the request that asked for them. It knows nothing
 * about `initialize`, `tools/list`, or `tools/call` — {@link McpClient} is
 * the layer that speaks MCP; this one only speaks JSON-RPC-over-lines.
 *
 * Server-initiated notifications (`isReply` false) are received and dropped.
 * A future caller that needs `notifications/*` (for example a progress
 * stream) is the reason to add a subscription surface here rather than
 * threading one more parameter through every constructor now.
 *
 * @since 0.1.0
 */
import { Deferred, Effect, HashMap, Option, Queue, Ref, Stream } from "effect"
import type { Scope } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { McpError } from "../McpError.ts"
import * as Rpc from "./Rpc.ts"

/**
 * One live connection to a spawned MCP server.
 *
 * @category models
 * @since 0.1.0
 */
export interface Transport {
  /** Sends a request and resolves with its `result`, or fails with the server's `error`. */
  readonly request: (method: string, params?: unknown, timeoutMs?: number) => Effect.Effect<unknown, McpError>
  /** Sends a notification. The server never replies, so this never waits on one. */
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void, McpError>
}

/**
 * Options accepted by {@link connect}.
 *
 * @category models
 * @since 0.1.0
 */
export interface ConnectOptions {
  /** The name this server is known by, for error messages only. */
  readonly server: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
  /** Default deadline for a request/reply exchange. */
  readonly requestTimeoutMs?: number | undefined
  /** Maximum number of frames waiting to be written. */
  readonly queueCapacity?: number | undefined
  /** Maximum UTF-8 bytes accepted in one inbound JSON-RPC frame. */
  readonly maxFrameBytes?: number | undefined
}

/**
 * Default request deadline.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultRequestTimeoutMs = 120_000

/**
 * Default number of outbound frames allowed to wait in memory.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultQueueCapacity = 64

/**
 * Default maximum inbound JSON-RPC frame size (one MiB).
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultMaxFrameBytes = 1024 * 1024

const closed = (server: string, reason: string): McpError =>
  new McpError({ code: "connection_closed", message: `MCP server "${server}" ${reason}`, server })

const timeout = (server: string, method: string, timeoutMs: number): McpError =>
  new McpError({
    code: "timeout",
    message: `MCP server "${server}" did not answer ${method} within ${timeoutMs}ms`,
    server
  })

const protocol = (server: string, message: string): McpError =>
  new McpError({ code: "protocol_error", message, server })

type Reply = Deferred.Deferred<unknown, McpError>

type ConnectionState = {
  readonly _tag: "Open"
  readonly pending: HashMap.HashMap<number, Reply>
} | {
  readonly _tag: "Closed"
  readonly error: McpError
}

const positiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0

/** Splits stdout without ever retaining more than one bounded partial frame. */
const frames = (
  server: string,
  maxFrameBytes: number,
  stream: Stream.Stream<Uint8Array, unknown>
): Stream.Stream<string, unknown | McpError> => {
  const encoder = new TextEncoder()
  const check = (line: string): Effect.Effect<string, McpError> =>
    encoder.encode(line).byteLength <= maxFrameBytes
      ? Effect.succeed(line)
      : Effect.fail(protocol(server, `MCP frame exceeded ${maxFrameBytes} bytes`))
  return stream.pipe(
    Stream.decodeText(),
    Stream.mapAccumEffect(
      () => "",
      (partial, chunk) => {
        const pieces = `${partial}${chunk}`.split("\n")
        // `split` always returns at least one member.
        const tail = pieces.pop()!
        return Effect.gen(function*() {
          yield* check(tail)
          const complete = yield* Effect.forEach(
            pieces,
            (line) => check(line.endsWith("\r") ? line.slice(0, -1) : line)
          )
          return [tail, complete] as const
        })
      },
      { onHalt: (partial) => partial === "" ? [] : [partial.endsWith("\r") ? partial.slice(0, -1) : partial] }
    ),
    Stream.filter((line) => line.trim() !== "")
  )
}

/**
 * Spawns an MCP server over stdio and returns a live {@link Transport}.
 *
 * The connection is scoped: the writer and reader loops are daemon fibers
 * forked into the calling scope, and closing that scope tears the process
 * down with it. Every request pending when the connection closes fails with
 * `connection_closed` instead of hanging forever.
 *
 * @category constructors
 * @since 0.1.0
 */
export const connect = (
  options: ConnectOptions
): Effect.Effect<Transport, McpError, ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function*() {
    const requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs
    const queueCapacity = options.queueCapacity ?? defaultQueueCapacity
    const maxFrameBytes = options.maxFrameBytes ?? defaultMaxFrameBytes
    if (!positiveInteger(requestTimeoutMs) || !positiveInteger(queueCapacity) || !positiveInteger(maxFrameBytes)) {
      return yield* Effect.fail(protocol(options.server, "MCP transport limits must be positive integers"))
    }

    const handle = yield* ChildProcess.make(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      // A server's diagnostic logging on stderr is not this transport's
      // concern yet; draining it into a second reader is the reason to add
      // one later rather than buffer output nobody reads today.
      stderr: "ignore"
    }).pipe(
      Effect.mapError((error) =>
        new McpError({
          code: "spawn_failed",
          message: `Failed to start MCP server "${options.server}": ${error.message}`,
          server: options.server
        })
      )
    )

    const nextId = yield* Ref.make(0)
    const outbound = yield* Queue.bounded<Uint8Array>(queueCapacity)
    const state = yield* Ref.make<ConnectionState>({ _tag: "Open", pending: HashMap.empty() })

    /** Closes once, fails every waiter, and rejects all future traffic. */
    const closeWith = (error: McpError) =>
      Effect.uninterruptible(Effect.gen(function*() {
        const waiters = yield* Ref.modify(state, (current) =>
          current._tag === "Closed"
            ? [undefined, current] as const
            : [Array.from(HashMap.values(current.pending)), { _tag: "Closed", error }] as const)
        if (waiters === undefined) return
        // Wake blocked offers first, then settle every registered request.
        // No caller can leave the connection scope before this cleanup has
        // completed because the request deferreds are the terminal signal.
        yield* Queue.shutdown(outbound)
        yield* Effect.forEach(waiters, (deferred) => Deferred.fail(deferred, error), {
          discard: true
        })
      }))

    yield* Effect.addFinalizer(() => closeWith(closed(options.server, "connection scope closed")))

    // Writer: drains outbound frames into the process's stdin for the life of
    // the connection scope. A write failure is the same "connection is gone"
    // fact the reader loop reports, so it collapses pending requests too.
    yield* Stream.fromQueue(outbound).pipe(
      Stream.run(handle.stdin),
      Effect.ensuring(closeWith(closed(options.server, "stdin closed"))),
      Effect.forkScoped
    )

    // Reader: one line of stdout is one JSON-RPC message. A reply resolves
    // its pending deferred by id; anything else — a malformed line, a
    // notification, a reply to an id nobody is waiting on — is dropped.
    yield* frames(options.server, maxFrameBytes, handle.stdout).pipe(
      Stream.runForEach((line) =>
        Effect.gen(function*() {
          const message = Rpc.parse(line)
          if (message === undefined) return
          if (!Rpc.isReply(message)) return
          const deferred = yield* Ref.modify(state, (current) => {
            if (current._tag === "Closed") return [Option.none<Reply>(), current] as const
            return [
              HashMap.get(current.pending, message.id),
              { ...current, pending: HashMap.remove(current.pending, message.id) }
            ] as const
          })
          if (Option.isNone(deferred)) return
          if (message.error !== undefined) {
            yield* Deferred.fail(
              deferred.value,
              new McpError({ code: "tool_failed", message: message.error.message, server: options.server })
            )
          } else {
            yield* Deferred.succeed(deferred.value, message.result)
          }
        })
      ),
      Effect.matchEffect({
        onFailure: (error) =>
          closeWith(
            error instanceof McpError ? error : closed(options.server, "stdout failed")
          ),
        // A clean EOF is still a closed MCP connection. Node reports an
        // ordinary child exit by ending stdout successfully.
        onSuccess: () => closeWith(closed(options.server, "stdout closed"))
      }),
      Effect.forkScoped
    )

    // Some process implementations expose exit before stdout observes EOF.
    // Treat either signal as the same terminal transition.
    yield* handle.exitCode.pipe(
      Effect.flatMap((exitCode) => closeWith(closed(options.server, `exited with code ${exitCode}`))),
      Effect.catch(() => closeWith(closed(options.server, "process exited"))),
      Effect.forkScoped
    )

    const removePending = (id: number) =>
      Ref.update(state, (current) =>
        current._tag === "Closed"
          ? current
          : { ...current, pending: HashMap.remove(current.pending, id) })

    const enqueue = (frame: Uint8Array): Effect.Effect<void, McpError> =>
      Effect.flatMap(Queue.offer(outbound, frame), (offered) =>
        offered
          ? Effect.void
          : Effect.fail(closed(options.server, "outbound queue closed")))

    const request = (
      method: string,
      params?: unknown,
      timeoutMs = requestTimeoutMs
    ): Effect.Effect<unknown, McpError> =>
      Effect.gen(function*() {
        if (!positiveInteger(timeoutMs)) {
          return yield* Effect.fail(protocol(options.server, "MCP request timeout must be a positive integer"))
        }
        const id = yield* Ref.updateAndGet(nextId, (n) => n + 1)
        const deferred = yield* Deferred.make<unknown, McpError>()
        return yield* Effect.gen(function*() {
          const registration = yield* Ref.modify(state, (current) =>
            current._tag === "Closed"
              ? [current.error, current] as const
              : [undefined, { ...current, pending: HashMap.set(current.pending, id, deferred) }] as const)
          if (registration !== undefined) return yield* Effect.fail(registration)
          yield* enqueue(Rpc.encode({ jsonrpc: "2.0", id, method, params }))
          return yield* Deferred.await(deferred)
        }).pipe(
          Effect.ensuring(removePending(id)),
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.fail(timeout(options.server, method, timeoutMs))
          })
        )
      })

    const notify = (method: string, params?: unknown): Effect.Effect<void, McpError> =>
      Effect.gen(function*() {
        const current = yield* Ref.get(state)
        if (current._tag === "Closed") return yield* Effect.fail(current.error)
        yield* enqueue(Rpc.encode({ jsonrpc: "2.0", method, params }))
      }).pipe(
        Effect.timeoutOrElse({
          duration: requestTimeoutMs,
          orElse: () => Effect.fail(timeout(options.server, method, requestTimeoutMs))
        })
      )

    return { request, notify }
  })
