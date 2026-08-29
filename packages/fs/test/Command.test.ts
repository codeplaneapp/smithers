import { Cause, Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as CommandLine from "../src/internal/CommandLine.ts"
import * as SchemaBridge from "../src/internal/SchemaBridge.ts"

describe("Command", () => {
  it("lexes quotes and escapes before parsing flags", async () => {
    const argv = await Effect.runPromise(
      CommandLine.lex(
        "review --title='fix bug' --number=4821 --tag one --tag=two --no-draft -- --literal value\\ with\\ spaces"
      )
    )
    expect(argv).toEqual([
      "review",
      "--title=fix bug",
      "--number=4821",
      "--tag",
      "one",
      "--tag=two",
      "--no-draft",
      "--",
      "--literal",
      "value with spaces"
    ])
    expect(CommandLine.parseFlags(argv.slice(1))).toEqual({
      args: ["--literal", "value with spaces"],
      options: {
        title: "fix bug",
        number: "4821",
        tag: ["one", "two"],
        draft: false
      }
    })
  })

  it("does not evaluate shell syntax", async () => {
    const argv = await Effect.runPromise(CommandLine.lex("review '$HOME' \"$(whoami)\" `uname`"))
    expect(argv).toEqual(["review", "$HOME", "$(whoami)", "`uname`"])
  })

  it("reports unterminated quotes as parse failures", async () => {
    const exit = await Effect.runPromise(Effect.exit(CommandLine.lex("review 'unterminated")))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure) && failure.value.code).toBe("parse_failed")
    }
  })

  it("classifies output schema failures as encoding failures", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(SchemaBridge.encodeOutput(Schema.Number, "not-a-number"))
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure) && failure.value.code).toBe("encode_failed")
    }
  })
})
