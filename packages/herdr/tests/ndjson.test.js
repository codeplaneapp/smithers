import { describe, expect, test } from "bun:test";
import { createNdjsonDecoder, NdjsonFrameTooLargeError } from "../src/ndjson.js";

describe("createNdjsonDecoder", () => {
  test("splits multiple frames in a single chunk", () => {
    const decoder = createNdjsonDecoder();
    expect(decoder.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("buffers a frame split across chunks", () => {
    const decoder = createNdjsonDecoder();
    expect(decoder.push('{"a"')).toEqual([]);
    expect(decoder.push(":1")).toEqual([]);
    expect(decoder.push("}\n")).toEqual(['{"a":1}']);
  });

  test("holds an incomplete trailing frame until its newline arrives", () => {
    const decoder = createNdjsonDecoder();
    expect(decoder.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(decoder.push(":2}\n")).toEqual(['{"b":2}']);
  });

  test("skips blank lines", () => {
    const decoder = createNdjsonDecoder();
    expect(decoder.push('\n\n{"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  test("reassembles a large frame spanning many chunks", () => {
    const decoder = createNdjsonDecoder();
    const big = "x".repeat(200000);
    const payload = JSON.stringify({ big });
    let out = [];
    for (let i = 0; i < payload.length; i += 4096) {
      out = out.concat(decoder.push(payload.slice(i, i + 4096)));
    }
    expect(out).toEqual([]);
    out = decoder.push("\n");
    expect(out.length).toBe(1);
    expect(JSON.parse(out[0]).big).toBe(big);
  });

  test("decodes Buffer chunks, including a multi-byte char split on a chunk boundary", () => {
    const decoder = createNdjsonDecoder();
    const line = `${JSON.stringify({ s: "café-\u{1F600}" })}\n`;
    const bytes = Buffer.from(line, "utf8");
    // split at an arbitrary byte that lands inside a multi-byte sequence
    const cut = bytes.length - 3;
    expect(decoder.push(bytes.subarray(0, cut))).toEqual([]);
    const rest = decoder.push(bytes.subarray(cut));
    expect(rest.length).toBe(1);
    expect(JSON.parse(rest[0]).s).toBe("café-\u{1F600}");
  });

  test("rejects an oversized completed frame using UTF-8 byte length", () => {
    const decoder = createNdjsonDecoder({ maxFrameBytes: 4 });
    expect(decoder.push("éé\n")).toEqual(["éé"]);
    expect(() => decoder.push("ééx\n")).toThrow(NdjsonFrameTooLargeError);
  });

  test("bounds newline-free buffered bytes", () => {
    const decoder = createNdjsonDecoder({ maxFrameBytes: 8 });
    expect(decoder.push("1234")).toEqual([]);
    expect(decoder.push("5678")).toEqual([]);
    expect(() => decoder.push("9")).toThrow(
      expect.objectContaining({ code: "ndjson_frame_too_large", maxFrameBytes: 8 }),
    );
  });
});
