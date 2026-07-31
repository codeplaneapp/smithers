/** Maximum bytes retained for one herdr NDJSON frame (excluding its newline). */
export const DEFAULT_MAX_NDJSON_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Error raised when a peer sends an NDJSON frame larger than the configured
 * bound. Keeping a distinct code lets socket callers turn the framing failure
 * into a protocol error and close the connection immediately.
 */
export class NdjsonFrameTooLargeError extends RangeError {
  /**
   * @param {number} frameBytes
   * @param {number} maxFrameBytes
   */
  constructor(frameBytes, maxFrameBytes) {
    super(`NDJSON frame exceeds ${maxFrameBytes} bytes (received at least ${frameBytes})`);
    this.name = "NdjsonFrameTooLargeError";
    this.code = "ndjson_frame_too_large";
    this.frameBytes = frameBytes;
    this.maxFrameBytes = maxFrameBytes;
  }
}

/**
 * Create a stateful newline-delimited-JSON frame splitter for a socket stream.
 *
 * Feed raw socket chunks (`Buffer`/`Uint8Array` or `string`) via `push()`; it
 * returns every complete line that became available, buffering any partial
 * trailing line until the rest arrives. Frames and unterminated buffered input
 * are bounded by `maxFrameBytes`, measured on the UTF-8 wire bytes rather than
 * JavaScript string length. Blank lines are skipped.
 *
 * Byte chunks are accumulated before UTF-8 decoding, so a multi-byte character
 * split at an arbitrary socket boundary is decoded only after the whole frame is
 * available.
 *
 * @param {{ maxFrameBytes?: number }} [options]
 * @returns {{ push(chunk: Uint8Array | string): string[] }}
 */
export function createNdjsonDecoder(options = {}) {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_NDJSON_FRAME_BYTES;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new RangeError("maxFrameBytes must be a positive safe integer");
  }

  let buffer = Buffer.alloc(0);
  let bufferedBytes = 0;

  /**
   * @param {Buffer} part
   */
  const append = (part) => {
    if (part.byteLength === 0) {
      return;
    }
    const nextBytes = bufferedBytes + part.byteLength;
    if (nextBytes > maxFrameBytes) {
      bufferedBytes = 0;
      throw new NdjsonFrameTooLargeError(nextBytes, maxFrameBytes);
    }
    if (buffer.byteLength < nextBytes) {
      const capacity = Math.min(
        maxFrameBytes,
        Math.max(nextBytes, buffer.byteLength === 0 ? 1024 : buffer.byteLength * 2),
      );
      const grown = Buffer.allocUnsafe(capacity);
      if (bufferedBytes > 0) {
        buffer.copy(grown, 0, 0, bufferedBytes);
      }
      buffer = grown;
    }
    part.copy(buffer, bufferedBytes);
    bufferedBytes = nextBytes;
  };

  return {
    push(chunk) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      /** @type {string[]} */
      const lines = [];
      let start = 0;
      let newline = bytes.indexOf(0x0a, start);
      while (newline >= 0) {
        const part = bytes.subarray(start, newline);
        const frameBytes = bufferedBytes + part.byteLength;
        if (frameBytes > maxFrameBytes) {
          bufferedBytes = 0;
          throw new NdjsonFrameTooLargeError(frameBytes, maxFrameBytes);
        }

        let frame;
        if (bufferedBytes === 0) {
          frame = part.toString("utf8");
        } else {
          append(part);
          frame = buffer.subarray(0, frameBytes).toString("utf8");
        }
        bufferedBytes = 0;
        if (frame.trim() !== "") {
          lines.push(frame);
        }

        start = newline + 1;
        newline = bytes.indexOf(0x0a, start);
      }

      append(bytes.subarray(start));
      return lines;
    },
  };
}
