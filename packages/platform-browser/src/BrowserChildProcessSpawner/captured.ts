/**
 * Replay of captured interpreter output under the caller's disposition.
 *
 * @since 0.1.0
 */
import type * as PlatformError from "effect/PlatformError"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"

/**
 * Shared encoder for turning captured interpreter text back into bytes.
 *
 * @private
 */
const encoder = new TextEncoder()

/**
 * Captured output as a stream of at most one chunk, with the caller's
 * disposition for that stream applied.
 *
 * The dispositions mean here what they mean under `NodeChildProcessSpawner`.
 * Node only hands back a readable for `"pipe"`; `"inherit"` and `"ignore"`
 * leave `childProcess.stdout` null, which that implementation turns into
 * `Stream.empty` — so they do the same here, even though the interpreter has
 * already captured the text either way. A `Sink` is transduced through, the way
 * Node transduces the readable it wrapped.
 *
 * @private
 * @since 0.1.0
 * @slop
 */
export const captured = (
  text: string,
  option: ChildProcess.CommandOutput | { readonly stream?: ChildProcess.CommandOutput | undefined } | undefined
): Stream.Stream<Uint8Array, PlatformError.PlatformError> => {
  const disposition = option === undefined || typeof option === "string" || Sink.isSink(option)
    ? option
    : option.stream
  const stream: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.fromArray(
    text === "" ? [] : [encoder.encode(text)]
  )
  if (disposition === undefined || disposition === "pipe" || disposition === "overlapped") return stream
  if (Sink.isSink(disposition)) return Stream.transduce(stream, disposition)
  return Stream.empty
}
