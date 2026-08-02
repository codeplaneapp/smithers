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
declare function createNdjsonDecoder(options?: {
    maxFrameBytes?: number;
}): {
    push(chunk: Uint8Array | string): string[];
};
/** Maximum bytes retained for one herdr NDJSON frame (excluding its newline). */
declare const DEFAULT_MAX_NDJSON_FRAME_BYTES: number;
/**
 * Error raised when a peer sends an NDJSON frame larger than the configured
 * bound. Keeping a distinct code lets socket callers turn the framing failure
 * into a protocol error and close the connection immediately.
 */
declare class NdjsonFrameTooLargeError extends RangeError {
    /**
     * @param {number} frameBytes
     * @param {number} maxFrameBytes
     */
    constructor(frameBytes: number, maxFrameBytes: number);
    code: string;
    frameBytes: number;
    maxFrameBytes: number;
}

export { DEFAULT_MAX_NDJSON_FRAME_BYTES, NdjsonFrameTooLargeError, createNdjsonDecoder };
