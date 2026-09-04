/**
 * Byte-stream framing, chosen independently of the protocol that interprets
 * the frames. Server-sent events are one framing; a provider that ships
 * newline-delimited JSON is another, over the same protocol decoder.
 *
 * @since 0.1.0
 */
import * as Stream from "effect/Stream"
import * as Sse from "effect/unstable/encoding/Sse"

/**
 * A byte-stream framing strategy selected independently of a protocol.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Framing<Frame> {
  readonly id: string
  readonly frame: <E, R>(stream: Stream.Stream<Uint8Array, E, R>) => Stream.Stream<Frame, E | Sse.SseError, R>
}

/**
 * Incrementally decodes UTF-8 Server-Sent Events over arbitrary byte chunk
 * boundaries. Empty frames, the `[DONE]` sentinel, and incomplete trailing
 * frames are deliberately discarded before protocol JSON decoding.
 *
 * @since 0.1.0
 * @category framing
 * @slop
 */
export const sse: Framing<string> = {
  id: "sse",
  frame: (stream) =>
    stream.pipe(
      Stream.decodeText,
      // Give the decoder one final non-SSE line so it drains a final complete
      // event without turning an unterminated trailing line into a frame.
      Stream.concat(Stream.make("\u0000")),
      Stream.splitLines,
      Stream.map((line) => `${line}\n`),
      Stream.pipeThroughChannel(Sse.decode()),
      // Retry directives are connection-level metadata. This framing boundary
      // deliberately ignores them; request execution owns reconnection policy.
      Stream.catchTag("Retry", () => Stream.empty),
      Stream.filter((frame) => frame._tag === "Event" && frame.data !== "" && frame.data !== "[DONE]"),
      Stream.map((frame) => frame.data)
    )
}

/**
 * Newline-delimited JSON: one complete JSON document per line. Blank lines are
 * discarded, so a producer that separates records with a trailing newline
 * frames identically to one that does not.
 *
 * A stream cut mid-line yields that partial line as a frame, where protocol
 * decoding rejects it as invalid provider output. That is deliberate: a
 * truncated record is a failure to report, not a record to silently drop.
 *
 * @since 0.1.0
 * @category framing
 * @slop
 */
export const ndjson: Framing<string> = {
  id: "ndjson",
  frame: (stream) =>
    stream.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line.trim() !== "")
    )
}
