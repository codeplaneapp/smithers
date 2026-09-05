import { describe, expect, it } from "vitest"
import * as OutputStream from "../src/OutputStream.ts"

describe("bounded live subprocess output", () => {
  it("reassembles UTF-8 and split credentials before redacting", () => {
    const lines: Array<string> = []
    const observer = OutputStream.make({
      write: (stream, text) => lines.push(`${stream}: ${text}`),
      environment: { API_TOKEN: "private-value" }
    })
    observer.onStdout(Buffer.from("hello private-"))
    expect(lines).toEqual([])
    observer.onStdout(Buffer.from("value\nBearer abcd"))
    observer.onStdout(Buffer.from("efghijkl\n"))
    const encoded = Buffer.from("🦊\n")
    observer.onStderr(encoded.subarray(0, 2))
    observer.onStderr(encoded.subarray(2))
    observer.close()
    expect(lines.join("")).toContain("[REDACTED]")
    expect(lines.join("")).toContain("[REDACTED_TOKEN]")
    expect(lines.join("")).toContain("🦊")
    expect(lines.join("")).not.toContain("private-value")
    expect(lines.join("")).not.toContain("abcdefghijkl")
  })

  it("removes terminal injection, bounds lines, and flushes final fragments once", () => {
    const lines: Array<string> = []
    const observer = OutputStream.make({ write: (_stream, text) => lines.push(text), maximumLines: 2 })
    observer.onStdout(Buffer.from("\u001b[2Jone\n"))
    observer.onStderr(Buffer.from("two"))
    observer.close()
    observer.close()
    expect(lines).toEqual(["one\n", "two\n"])
    const bounded = OutputStream.make({ write: (_stream, text) => lines.push(text), maximumLines: 1 })
    bounded.onStdout(Buffer.from("a\nb\nc\n"))
    bounded.close()
    expect(lines).toHaveLength(4)
    expect(lines.at(-1)).toContain("limit reached")
  })

  it("redacts each line of a multiline known secret", () => {
    const lines: Array<string> = []
    const observer = OutputStream.make({
      write: (_stream, text) => lines.push(text),
      environment: { PRIVATE_KEY: "first-part\nsecond-part" }
    })
    observer.onStdout(Buffer.from("first-part\nsecond-part\n"))
    observer.close()
    expect(lines).toEqual(["[REDACTED]\n", "[REDACTED]\n"])
  })

  it("discards overlong unterminated lines and isolates observer errors", () => {
    const lines: Array<string> = []
    const observer = OutputStream.make({ write: (_stream, text) => lines.push(text) })
    observer.onStdout(Buffer.from("s".repeat(40 * 1024)))
    observer.onStdout(Buffer.from("secret\nnext\n"))
    observer.close()
    expect(lines).toEqual(["[overlong output line omitted]\n", "next\n"])
    const broken = OutputStream.make({
      write: () => {
        throw new Error("terminal closed")
      }
    })
    expect(() => {
      broken.onStdout(Buffer.from("hello\n"))
      broken.close()
    }).not.toThrow()
  })
})
