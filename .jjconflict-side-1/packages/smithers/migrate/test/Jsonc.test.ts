/**
 * The one JSON-with-comments reader: comments and trailing commas go, and
 * nothing that merely looks like one inside a string does.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as Jsonc from "../src/internal/Jsonc.ts"

describe("Jsonc.withoutComments", () => {
  it("strips line and block comments outside strings and leaves a glob include alone", () => {
    const text = [
      "{",
      "  // the compiler options",
      "  \"compilerOptions\": { \"strict\": true /* always */ },",
      "  \"include\": [\"**/*.ts\", \"**/*.tsx\"],",
      "  \"exclude\": [\"http://example.test/*\"]",
      "}"
    ].join("\n")
    expect(JSON.parse(Jsonc.withoutComments(text))).toEqual({
      compilerOptions: { strict: true },
      include: ["**/*.ts", "**/*.tsx"],
      exclude: ["http://example.test/*"]
    })
  })

  it("removes a trailing comma before a closing bracket, whatever whitespace or comment sits between", () => {
    const text = "{\n  \"a\": [1, 2, ], // trailing\n  \"b\": { \"c\": 1, /* x */ },\n}\n"
    expect(JSON.parse(Jsonc.withoutComments(text))).toEqual({ a: [1, 2], b: { c: 1 } })
  })

  it("keeps a comma, a comment marker, or a bracket that lives inside a string", () => {
    const text = "{ \"a\": \",}\", \"b\": \"// not a comment\", \"c\": \"/* nor this */\", \"d\": \"esc\\\"aped,\" }"
    expect(JSON.parse(Jsonc.withoutComments(text))).toEqual({
      a: ",}",
      b: "// not a comment",
      c: "/* nor this */",
      d: "esc\"aped,"
    })
  })

  it("reads an unterminated block comment to the end and a comma that is not trailing as a comma", () => {
    expect(Jsonc.withoutComments("{ \"a\": 1 } /* open")).toBe("{ \"a\": 1 } ")
    expect(Jsonc.withoutComments("[1, 2]")).toBe("[1, 2]")
  })
})
