import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Framing from "../src/Framing.ts"

const encoder = new TextEncoder()

const split = (input: Uint8Array, size: number): ReadonlyArray<Uint8Array> => {
  const chunks: Array<Uint8Array> = []
  for (let index = 0; index < input.length; index += size) chunks.push(input.slice(index, index + size))
  return chunks
}

const decodeWith = (framing: Framing.Framing<string>) => (input: string, size: number) =>
  Effect.runPromise(
    Stream.runCollect(framing.frame(Stream.fromIterable(split(encoder.encode(input), size))))
  ).then(Array.from)

const decode = decodeWith(Framing.sse)
const decodeNdjson = decodeWith(Framing.ndjson)

describe("Framing.sse", () => {
  const fixture =
    ": keepalive\r\nid: event-1\r\nevent: message\r\ndata: first\r\ndata: second\r\n\r\nevent: unicode\ndata: café\n\n"
  const expected = ["first\nsecond", "café"]

  it.each([1, 3, 7, 4096])("decodes byte-split SSE at chunk size %s", async (size) => {
    await expect(decode(fixture, size)).resolves.toEqual(expected)
  })

  it("drops the terminal sentinel before protocol JSON decoding", async () => {
    await expect(decode("data: [DONE]\n\n", 1)).resolves.toEqual([])
  })

  it("drops a truncated final frame without failing the stream", async () => {
    await expect(decode("data: complete\n\ndata: incomplete", 3)).resolves.toEqual(["complete"])
  })

  it("deliberately ignores retry directives", async () => {
    await expect(decode("data: before\n\nretry: 100\n\ndata: after\n\n", 2)).resolves.toEqual(["before", "after"])
  })
})

describe("Framing.ndjson", () => {
  const fixture = "{\"type\":\"delta\",\"text\":\"one\"}\n{\"type\":\"delta\",\"text\":\"café\"}\n{\"type\":\"done\"}\n"
  const expected = [
    "{\"type\":\"delta\",\"text\":\"one\"}",
    "{\"type\":\"delta\",\"text\":\"café\"}",
    "{\"type\":\"done\"}"
  ]

  it.each([1, 3, 7, 4096])("decodes byte-split NDJSON at chunk size %s", async (size) => {
    await expect(decodeNdjson(fixture, size)).resolves.toEqual(expected)
  })

  it("frames a producer that omits the trailing newline identically", async () => {
    await expect(decodeNdjson("{\"a\":1}\n{\"b\":2}", 4)).resolves.toEqual(["{\"a\":1}", "{\"b\":2}"])
  })

  it("discards blank lines rather than emitting empty frames", async () => {
    await expect(decodeNdjson("\n{\"a\":1}\n\n\n{\"b\":2}\n\n", 5)).resolves.toEqual(["{\"a\":1}", "{\"b\":2}"])
  })

  it("emits a truncated final record so protocol decoding can reject it", async () => {
    // A cut record is a failure to report, not a record to drop silently.
    await expect(decodeNdjson("{\"a\":1}\n{\"b\":", 3)).resolves.toEqual(["{\"a\":1}", "{\"b\":"])
  })
})
