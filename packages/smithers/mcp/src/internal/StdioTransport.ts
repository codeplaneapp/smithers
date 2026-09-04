/**
 * Newline-delimited JSON-RPC transport over a spawned MCP server's stdio.
 *
 * This module owns exactly the connection lifecycle and request/reply
 * correlation an MCP session needs: spawn once, write frames in, read frames
 * out, match replies to the request that asked for them. It knows nothing
 * about `initialize`, `tools/list`, or `tools/call`. {@link McpClient} is
 * the layer that speaks MCP; this one only speaks JSON-RPC-over-lines.
 *
 * Server-initiated notifications are received and dropped. A future caller
 * that needs `notifications/*` (for example a progress stream) is the reason
 * to add a subscription surface here rather than threading one more parameter
 * through every constructor now.
 *
 * @since 1.0.0-rc.0
 */
import * as ChildProcessEnvironment from "@smthrs/kernel/ChildProcessEnvironment"
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
 * @since 1.0.0-rc.0
 */
export interface Transport {
  /** Sends a request and resolves with its `result`, or fails with the server's `error`. */
  readonly request: (method: string, params?: unknown, timeoutMs?: number) => Effect.Effect<unknown, McpError>
  /** Sends a notification, bounding queue admission by the optional positive-integer deadline. */
  readonly notify: (method: string, params?: unknown, timeoutMs?: number) => Effect.Effect<void, McpError>
}

/**
 * Options accepted by {@link connect}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ConnectOptions {
  /** The name this server is known by, for error messages only. */
  readonly server: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string | undefined
  /** Values merged into the bootstrap allowlist rather than the full host environment. */
  readonly env?: Record<string, string | undefined> | undefined
  /** Default deadline for a request/reply exchange. See {@link defaultRequestTimeoutMs}. */
  readonly requestTimeoutMs?: number | undefined
  /** Maximum number of frames waiting to be written. See {@link defaultQueueCapacity}. */
  readonly queueCapacity?: number | undefined
  /** Maximum UTF-8 bytes accepted in one inbound JSON-RPC frame. See {@link defaultMaxFrameBytes}. */
  readonly maxFrameBytes?: number | undefined
  /** Maximum UTF-8 bytes emitted in one JSON-RPC frame. See {@link defaultMaxOutboundFrameBytes}. */
  readonly maxOutboundFrameBytes?: number | undefined
  /** Maximum diagnostic stderr bytes retained in memory. See {@link defaultMaxStderrBytes}. */
  readonly maxStderrBytes?: number | undefined
}

/**
 * Default request deadline.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultRequestTimeoutMs = 120_000

/**
 * Default number of outbound frames allowed to wait in memory.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultQueueCapacity = 64

/**
 * Default maximum inbound JSON-RPC frame size (one MiB).
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxFrameBytes = 1024 * 1024

/**
 * Default maximum outbound JSON-RPC frame size (one MiB).
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxOutboundFrameBytes = 1024 * 1024

/**
 * Default maximum child-stderr tail retained for connection diagnostics.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxStderrBytes = 2048

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

const diagnosticErrorCodes: ReadonlySet<string> = new Set(["spawn_failed", "timeout", "connection_closed"])
const cancellationReason = "request no longer awaited"

type Pending = {
  readonly deferred: Deferred.Deferred<unknown, McpError>
  readonly method: string
}

type ConnectionState = {
  readonly _tag: "Open"
  readonly pending: HashMap.HashMap<number, Pending>
} | {
  readonly _tag: "Closed"
  readonly error: McpError
}

const positiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0

const limitError = (server: string, name: string): McpError =>
  protocol(server, `MCP option "${name}" must be a positive integer`)

const replyError = (
  server: string,
  method: string,
  reply: Extract<Rpc.Reply, { readonly _tag: "Error" }>
): McpError => {
  const scalar = ["string", "number", "boolean"].includes(typeof reply.data) ? String(reply.data) : undefined
  const suffix = scalar !== undefined && scalar.length <= 120 ? ` [data: ${scalar}]` : ""
  // Servers do not standardize unknown-tool prose, so this heuristic stays
  // limited to the two MCP error codes and an explicit tool plus absence phrase.
  const remoteUnknownTool = (reply.code === -32_601 || reply.code === -32_602) &&
    /\btool\b/i.test(reply.message) &&
    /\b(?:unknown|unrecognized|no such|not found)\b/i.test(reply.message)
  return new McpError({
    code: method === "tools/call"
      ? remoteUnknownTool ? "tool_not_found" : "tool_failed"
      : "protocol_error",
    message: `MCP server "${server}" failed ${method} (${reply.code}): ${reply.message}${suffix}`,
    server
  })
}

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
 * Stdout that does not claim JSON-RPC is ignored because servers commonly log
 * there. Once an object carries its own `jsonrpc` property, a malformed version
 * or reply closes the connection with `protocol_error`.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const connect = (
  options: ConnectOptions
): Effect.Effect<Transport, McpError, ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function*() {
    const requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs
    const queueCapacity = options.queueCapacity ?? defaultQueueCapacity
    const maxFrameBytes = options.maxFrameBytes ?? defaultMaxFrameBytes
    const maxOutboundFrameBytes = options.maxOutboundFrameBytes ?? defaultMaxOutboundFrameBytes
    const maxStderrBytes = options.maxStderrBytes ?? defaultMaxStderrBytes
    const invalidLimit = [
      ["requestTimeoutMs", requestTimeoutMs],
      ["queueCapacity", queueCapacity],
      ["maxFrameBytes", maxFrameBytes],
      ["maxOutboundFrameBytes", maxOutboundFrameBytes],
      ["maxStderrBytes", maxStderrBytes]
    ].find(([, value]) => !positiveInteger(value as number))
    if (invalidLimit !== undefined) {
      return yield* Effect.fail(limitError(options.server, invalidLimit[0] as string))
    }

    const handle = yield* ChildProcess.make(options.command, options.args, {
      cwd: options.cwd,
      env: ChildProcessEnvironment.make(process.env, options.env),
      extendEnv: false,
      stdin: "pipe",
      stdout: "pipe",
      // Stderr is diagnostic only: a scoped drainer below retains at most the
      // configured byte tail, and stderr failure never fails the connection.
      stderr: "pipe"
    }).pipe(
      Effect.mapError((error) =>
        new McpError({
          code: "spawn_failed",
          message: `Failed to start MCP server "${options.server}": ${error.message}`,
          server: options.server
        })
      )
    )

    const stderrTail = yield* Ref.make<Uint8Array>(new Uint8Array())
    yield* handle.stderr.pipe(
      Stream.runForEach((chunk) =>
        Ref.update(stderrTail, (current) => {
          const tail = chunk.byteLength >= maxStderrBytes
            ? chunk.slice(chunk.byteLength - maxStderrBytes)
            : chunk
          const headLength = Math.min(current.byteLength, maxStderrBytes - tail.byteLength)
          const next = new Uint8Array(headLength + tail.byteLength)
          next.set(current.subarray(current.byteLength - headLength))
          next.set(tail, headLength)
          return next
        })
      ),
      Effect.ignore,
      Effect.forkScoped
    )

    const withStderr = (error: McpError): Effect.Effect<McpError> => {
      if (!diagnosticErrorCodes.has(error.code)) return Effect.succeed(error)
      return Effect.map(Ref.get(stderrTail), (bytes) => {
        const rendered = new TextDecoder().decode(bytes).replace(/\s+/g, " ").trim()
        return rendered === ""
          ? error
          : new McpError({ code: error.code, message: `${error.message} (stderr: ${rendered})`, server: error.server })
      })
    }

    const nextId = yield* Ref.make(0)
    const outbound = yield* Queue.bounded<Uint8Array>(queueCapacity)
    const state = yield* Ref.make<ConnectionState>({ _tag: "Open", pending: HashMap.empty() })

    /** Closes once, fails every waiter, and rejects all future traffic. */
    const closeWith = (baseError: McpError) =>
      Effect.uninterruptible(Effect.gen(function*() {
        const error = yield* withStderr(baseError)
        const waiters = yield* Ref.modify(state, (current) =>
          current._tag === "Closed"
            ? [undefined, current] as const
            : [Array.from(HashMap.values(current.pending)), { _tag: "Closed", error }] as const)
        if (waiters === undefined) return
        // Wake blocked offers first, then settle every registered request.
        // No caller can leave the connection scope before this cleanup has
        // completed because the request deferreds are the terminal signal.
        yield* Queue.shutdown(outbound)
        yield* Effect.forEach(waiters, (pending) => Deferred.fail(pending.deferred, error), {
          discard: true
        })
      }))

    // Scope closure tears down the child, so no remote process remains to
    // receive per-request cancellations from this connection finalizer.
    yield* Effect.addFinalizer(() => closeWith(closed(options.server, "connection scope closed")))

    // Writer: drains outbound frames into the process's stdin for the life of
    // the connection scope. A write failure is the same "connection is gone"
    // fact the reader loop reports, so it collapses pending requests too.
    yield* Stream.fromQueue(outbound).pipe(
      Stream.run(handle.stdin),
      Effect.ensuring(closeWith(closed(options.server, "stdin closed"))),
      Effect.forkScoped
    )

    // Reader: one line of stdout is one JSON-RPC message. A validated reply
    // resolves its pending request by id; malformed tagged messages close the
    // whole connection, while stdout noise, notifications, and unknown ids drop.
    yield* frames(options.server, maxFrameBytes, handle.stdout).pipe(
      Stream.runForEach((line) =>
        Effect.gen(function*() {
          const message = Rpc.parse(line)
          if (message === undefined) return
          const reply = Rpc.classify(message)
          if (reply._tag === "Notification") return
          if (reply._tag === "Malformed") {
            return yield* Effect.fail(
              protocol(
                options.server,
                `MCP server "${options.server}" sent a malformed JSON-RPC reply: ${reply.reason}`
              )
            )
          }
          const pending = yield* Ref.modify(state, (current) => {
            if (current._tag === "Closed") return [Option.none<Pending>(), current] as const
            return [
              HashMap.get(current.pending, reply.id),
              { ...current, pending: HashMap.remove(current.pending, reply.id) }
            ] as const
          })
          if (Option.isNone(pending)) return
          if (reply._tag === "Error") {
            yield* Deferred.fail(
              pending.value.deferred,
              replyError(options.server, pending.value.method, reply)
            )
          } else {
            yield* Deferred.succeed(pending.value.deferred, reply.result)
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

    const takePending = (id: number): Effect.Effect<boolean> =>
      Ref.modify(state, (current) => {
        if (current._tag === "Closed") return [false, current]
        const present = HashMap.has(current.pending, id)
        return [present, { ...current, pending: HashMap.remove(current.pending, id) }]
      })

    const enqueue = (frame: Uint8Array): Effect.Effect<void, McpError> =>
      Effect.flatMap(Queue.offer(outbound, frame), (offered) =>
        offered
          ? Effect.void
          : Effect.flatMap(withStderr(closed(options.server, "outbound queue closed")), Effect.fail))

    const frameOf = (method: string, message: Rpc.Outbound): Effect.Effect<Uint8Array, McpError> =>
      Effect.try({
        try: () => Rpc.encode(message),
        catch: () => protocol(options.server, `MCP server "${options.server}" could not encode a ${method} frame`)
      }).pipe(
        Effect.flatMap((frame) =>
          frame.byteLength <= maxOutboundFrameBytes
            ? Effect.succeed(frame)
            : Effect.fail(
              protocol(
                options.server,
                `MCP server "${options.server}" tried to send a ${method} frame larger than ${maxOutboundFrameBytes} bytes`
              )
            )
        )
      )

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
        const frame = yield* frameOf(method, { jsonrpc: "2.0", id, method, params })
        let sent = false
        return yield* Effect.gen(function*() {
          const registration = yield* Ref.modify(state, (current) =>
            current._tag === "Closed"
              ? [current.error, current] as const
              : [undefined, {
                ...current,
                pending: HashMap.set(current.pending, id, { deferred, method })
              }] as const)
          if (registration !== undefined) return yield* Effect.fail(registration)
          yield* enqueue(frame)
          sent = true
          return yield* Deferred.await(deferred)
        }).pipe(
          Effect.ensuring(Effect.gen(function*() {
            const pending = yield* takePending(id)
            if (!sent || !pending || method === "initialize") return
            yield* frameOf("notifications/cancelled", {
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: id, reason: cancellationReason }
            }).pipe(
              // Best-effort cancellation cannot delay the deadline it reports.
              Effect.flatMap((frame) => Effect.sync(() => Queue.offerUnsafe(outbound, frame))),
              Effect.ignore
            )
          })),
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.flatMap(withStderr(timeout(options.server, method, timeoutMs)), Effect.fail)
          })
        )
      })

    const notify = (
      method: string,
      params?: unknown,
      timeoutMs = requestTimeoutMs
    ): Effect.Effect<void, McpError> => {
      if (!positiveInteger(timeoutMs)) {
        return Effect.fail(protocol(options.server, "MCP notification timeout must be a positive integer"))
      }
      return Effect.gen(function*() {
        const current = yield* Ref.get(state)
        if (current._tag === "Closed") return yield* Effect.fail(current.error)
        const frame = yield* frameOf(method, { jsonrpc: "2.0", method, params })
        yield* enqueue(frame)
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.flatMap(withStderr(timeout(options.server, method, timeoutMs)), Effect.fail)
        })
      )
    }

    return { request, notify }
  })
