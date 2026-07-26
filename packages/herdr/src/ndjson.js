import { StringDecoder } from "node:string_decoder";

/**
 * Create a stateful newline-delimited-JSON frame splitter for a socket stream.
 *
 * Feed raw socket chunks (`Buffer`/`Uint8Array` or `string`) via `push()`; it
 * returns every complete line that became available, buffering any partial
 * trailing line until the rest arrives. Robust to the three framing hazards on
 * a stream socket:
 *
 * - a single frame split across multiple chunks (accumulated until the `\n`),
 * - multiple frames delivered in one chunk (all returned in order),
 * - a large frame spanning many chunks (accumulated transparently).
 *
 * A `StringDecoder` guards against a multi-byte UTF-8 character being split on
 * a chunk boundary. Blank lines are skipped. The caller parses each returned
 * line as JSON.
 *
 * @returns {{ push(chunk: Uint8Array | string): string[] }}
 */
export function createNdjsonDecoder() {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      /** @type {string[]} */
      const lines = [];
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") {
          lines.push(line);
        }
        newline = buffer.indexOf("\n");
      }
      return lines;
    },
  };
}
