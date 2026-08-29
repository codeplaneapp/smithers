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
  readonly request: (method: string, params?: unknown) => Effect.Effect<unknown, McpError>
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
}

const closed = (server: string, reason: string): McpError =>
  new McpError({ code: "connection_closed", message: `MCP server "${server}" ${reason}`, server })

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
    const pending = yield* Ref.make(HashMap.empty<number, Deferred.Deferred<unknown, McpError>>())
    const outbound = yield* Queue.unbounded<Uint8Array>()

    /** Fails and forgets every request still waiting on a reply. */
    const rejectPending = (error: McpError) =>
      Effect.gen(function*() {
        const map = yield* Ref.getAndSet(pending, HashMap.empty())
        yield* Effect.forEach(HashMap.values(map), (deferred) => Deferred.fail(deferred, error), {
          discard: true
        })
      })

    // Writer: drains outbound frames into the process's stdin for the life of
    // the connection scope. A write failure is the same "connection is gone"
    // fact the reader loop reports, so it collapses pending requests too.
    yield* Stream.fromQueue(outbound).pipe(
      Stream.run(handle.stdin),
      Effect.mapError(() => closed(options.server, "stdin closed")),
      Effect.tapError(rejectPending),
      Effect.ignore,
      Effect.forkScoped
    )

    // Reader: one line of stdout is one JSON-RPC message. A reply resolves
    // its pending deferred by id; anything else — a malformed line, a
    // notification, a reply to an id nobody is waiting on — is dropped.
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.gen(function*() {
          const message = Rpc.parse(line)
          if (message === undefined || !Rpc.isReply(message)) return
          const map = yield* Ref.get(pending)
          const deferred = HashMap.get(map, message.id)
          if (Option.isNone(deferred)) return
          yield* Ref.update(pending, HashMap.remove(message.id))
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
      // A clean EOF is still a closed MCP connection. Node reports an
      // ordinary child exit by ending stdout successfully, so only handling
      // stream failures would leave an in-flight request waiting forever.
      Effect.ensuring(rejectPending(closed(options.server, "stdout closed"))),
      Effect.ignore,
      Effect.forkScoped
    )

    const request = (method: string, params?: unknown): Effect.Effect<unknown, McpError> =>
      Effect.gen(function*() {
        const id = yield* Ref.updateAndGet(nextId, (n) => n + 1)
        const deferred = yield* Deferred.make<unknown, McpError>()
        yield* Ref.update(pending, HashMap.set(id, deferred))
        yield* Queue.offer(outbound, Rpc.encode({ jsonrpc: "2.0", id, method, params }))
        return yield* Deferred.await(deferred)
      })

    const notify = (method: string, params?: unknown): Effect.Effect<void, McpError> =>
      Effect.asVoid(Queue.offer(outbound, Rpc.encode({ jsonrpc: "2.0", method, params })))

    return { request, notify }
  })
