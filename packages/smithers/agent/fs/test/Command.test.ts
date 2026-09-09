import { Cause, Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Command from "../src/Command.ts"
import * as CommandLine from "../src/internal/CommandLine.ts"
import * as SchemaBridge from "../src/internal/SchemaBridge.ts"
import * as Route from "../src/Route.ts"
import { makeRoute } from "./helpers.ts"

describe("Command", () => {
  it.each([0, 4_097, 16_384])("parses a %i-character flag value through the public surface", async (length) => {
    const surface = await Effect.runPromise(Command.make([makeRoute("review")]))
    const value = "a".repeat(length)
    const parsed = await Effect.runPromise(surface.parse(`review --tags "${value}" --tags a --number 1`))
    expect(parsed.input).toEqual({ tags: [value, "a"], number: 1 })
    expect(parsed.argv).toEqual(["review", "--tags", value, "--tags", "a", "--number", "1"])
  })

  it("preserves command-token and route-name errors through the public surface", async () => {
    const surface = await Effect.runPromise(Command.make([makeRoute("review")]))
    for (
      const [command, method, description] of [
        [
          `review --tags ${"a".repeat(CommandLine.maximumTokenLength + 1)} --tags a --number 1`,
          "CommandLine.lex",
          `A command token may contain at most ${CommandLine.maximumTokenLength} characters`
        ],
        [
          "a".repeat(Route.maximumRouteNameLength + 1),
          "CommandTree.resolve",
          "The command name exceeds its resource bounds"
        ]
      ] as const
    ) {
      const exit = await Effect.runPromise(Effect.exit(surface.parse(command)))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          code: "resource_limit",
          method,
          description
        })
      }
    }
  })

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
    expect(await Effect.runPromise(CommandLine.parseFlags(argv.slice(1)))).toEqual({
      args: ["--literal", "value with spaces"],
      options: {
        title: "fix bug",
        number: "4821",
        tag: ["one", "two"],
        draft: false
      }
    })
  })

  it("keeps single-quoted text literal and honours escapes elsewhere", async () => {
    expect(await Effect.runPromise(CommandLine.lex("x 'a\\nb' 'C:\\path'"))).toEqual([
      "x",
      "a\\nb",
      "C:\\path"
    ])
    expect(await Effect.runPromise(CommandLine.lex("\"a\\\"b\""))).toEqual(["a\"b"])
    expect(await Effect.runPromise(CommandLine.lex("a\\'b"))).toEqual(["a'b"])
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

  it("uses null-prototype option storage and refuses prototype-sensitive names", async () => {
    const parsed = await Effect.runPromise(CommandLine.parseFlags([
      "--safe=one",
      "--safe",
      "two",
      "--safe=three",
      "--no-draft",
      "positional"
    ]))
    expect(parsed).toEqual({
      args: ["positional"],
      options: { safe: ["one", "two", "three"], draft: false }
    })
    expect(Object.getPrototypeOf(parsed.options)).toBeNull()
    expect(Object.isFrozen(parsed.options)).toBe(true)

    for (
      const argv of [
        ["--constructor=secret"],
        ["--__proto__", "secret"],
        ["--no-constructor"],
        ["--prototype"],
        ["--=true"],
        ["--bad.name=x"]
      ]
    ) {
      const exit = await Effect.runPromise(Effect.exit(CommandLine.parseFlags(argv)))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
        expect(error.code).toBe("parse_failed")
        expect(JSON.stringify(error)).not.toContain("secret")
      }
    }
  })

  it("handles empty tokens and trailing escapes without shell evaluation", async () => {
    expect(await Effect.runPromise(CommandLine.lex("review \"\" tail\\"))).toEqual(["review", "", "tail\\"])
    expect(await Effect.runPromise(CommandLine.lex("   "))).toEqual([])
    expect(await Effect.runPromise(CommandLine.lex("  review  "))).toEqual(["review"])
  })

  it("enforces command, token, and argv resource bounds", async () => {
    expect(await Effect.runPromise(CommandLine.lex("x".repeat(CommandLine.maximumTokenLength)))).toHaveLength(1)
    for (
      const command of [
        "x".repeat(CommandLine.maximumTokenLength + 1),
        `${"x".repeat(CommandLine.maximumTokenLength + 1)} `,
        "x".repeat(CommandLine.maximumCommandBytes + 1),
        "\ud800"
      ]
    ) {
      const exit = await Effect.runPromise(Effect.exit(CommandLine.lex(command)))
      expect(exit._tag).toBe("Failure")
    }

    const exact = Array.from({ length: CommandLine.maximumCommandTokens }, () => "x").join(" ")
    expect(await Effect.runPromise(CommandLine.lex(exact))).toHaveLength(CommandLine.maximumCommandTokens)
    const tooMany = `${exact} x`
    const excess = await Effect.runPromise(Effect.exit(CommandLine.lex(tooMany)))
    expect(excess._tag).toBe("Failure")

    const hostile = new Proxy(["--safe=x"], {
      ownKeys: () => {
        throw new Error("trap")
      }
    })
    expect((await Effect.runPromise(Effect.exit(CommandLine.parseFlags(hostile))))._tag).toBe("Failure")
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
