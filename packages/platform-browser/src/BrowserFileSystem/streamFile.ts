/**
 * Bounded-chunk file streaming over a ZenFS file handle.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as PlatformError from "effect/PlatformError"
import * as Stream from "effect/Stream"
import { platformError } from "./platformError.ts"
import type { ZenFsPromisesLike } from "./ZenFsPromisesLike.ts"

/**
 * Streams a file in bounded file-handle chunks rather than loading the whole
 * file, honouring `offset`, `bytesToRead`, and `chunkSize`.
 *
 * @private
 * @since 0.1.0
 * @slop
 */
export const streamFile = (
  fs: ZenFsPromisesLike,
  path: string,
  options?: {
    readonly bytesToRead?: FileSystem.SizeInput | undefined
    readonly chunkSize?: FileSystem.SizeInput | undefined
    readonly offset?: FileSystem.SizeInput | undefined
  }
): Stream.Stream<Uint8Array, PlatformError.PlatformError> =>
  Stream.unwrap(
    Effect.map(
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => fs.open(path, "r"),
          catch: platformError("stream", path)
        }),
        (handle) =>
          Effect.orDie(
            Effect.tryPromise({
              try: () => handle.close(),
              catch: platformError("stream.close", path)
            })
          )
      ),
      (handle) => {
        const start = Math.max(0, Number(options?.offset ?? 0))
        const bytesToRead = options?.bytesToRead === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(0, Number(options.bytesToRead))
        const chunkSize = Math.max(1, Number(options?.chunkSize ?? 64 * 1024))
        return Stream.unfold(
          { position: start, remaining: bytesToRead },
          ({ position, remaining }) => {
            if (remaining === 0) return Effect.succeed(undefined)
            const size = Math.min(chunkSize, remaining)
            const buffer = new Uint8Array(size)
            return Effect.tryPromise({
              try: () => handle.read(buffer, 0, size, position),
              catch: platformError("stream.read", path)
            }).pipe(
              Effect.map(({ bytesRead }) =>
                bytesRead === 0
                  ? undefined
                  : [
                    bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead),
                    {
                      position: position + bytesRead,
                      remaining: remaining - bytesRead
                    }
                  ] as const
              )
            )
          }
        )
      }
    )
  )
