/**
 * Shell-independent command-string parsing for the agent command surface.
 *
 * @since 0.0.0
 */
import * as Effect from "effect/Effect"
import { FsError } from "../FsError.ts"

/**
 * The positional and named values extracted from an argv tail.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface ParsedFlags {
  readonly args: ReadonlyArray<string>
  readonly options: Readonly<Record<string, unknown>>
}

const parseError = (description: string): FsError =>
  new FsError({
    code: "parse_failed",
    method: "CommandLine.lex",
    description
  })

/**
 * Splits a command string into argv without invoking a shell.
 *
 * Quotes and backslashes only affect tokenization. Shell syntax, including
 * substitutions and variable references, is ordinary literal text.
 *
 * @category parsing
 * @since 0.0.0
 * @slop
 */
export const lex = (commandString: string): Effect.Effect<ReadonlyArray<string>, FsError> =>
  Effect.suspend(() => {
    const argv: Array<string> = []
    let current = ""
    let quote: "single" | "double" | undefined
    let started = false
    let escaping = false

    for (const character of commandString) {
      if (escaping) {
        current += character
        started = true
        escaping = false
        continue
      }
      if (character === "\\") {
        escaping = true
        started = true
        continue
      }
      if (quote === "single") {
        if (character === "'") {
          quote = undefined
        } else {
          current += character
        }
        continue
      }
      if (quote === "double") {
        if (character === "\"") {
          quote = undefined
        } else {
          current += character
        }
        continue
      }
      if (character === "'") {
        quote = "single"
        started = true
      } else if (character === "\"") {
        quote = "double"
        started = true
      } else if (/\s/.test(character)) {
        if (started) {
          argv.push(current)
          current = ""
          started = false
        }
      } else {
        current += character
        started = true
      }
    }

    if (escaping) {
      current += "\\"
    }
    if (quote !== undefined) {
      return Effect.fail(parseError("unterminated quote"))
    }
    if (started) {
      argv.push(current)
    }
    return Effect.succeed(argv)
  })

const append = (options: Record<string, unknown>, name: string, value: unknown): void => {
  const current = options[name]
  options[name] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value]
}

/**
 * Parses long options from an argv tail. This is deliberately a small,
 * deterministic grammar rather than a compatibility layer for a shell.
 *
 * @category parsing
 * @since 0.0.0
 * @slop
 */
export const parseFlags = (argv: ReadonlyArray<string>): ParsedFlags => {
  const args: Array<string> = []
  const options: Record<string, unknown> = {}
  let endOfFlags = false

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!
    if (endOfFlags) {
      args.push(value)
      continue
    }
    if (value === "--") {
      endOfFlags = true
      continue
    }
    if (!value.startsWith("--") || value === "--") {
      args.push(value)
      continue
    }

    const flag = value.slice(2)
    if (flag.startsWith("no-") && !flag.includes("=")) {
      append(options, flag.slice(3), false)
      continue
    }
    const equals = flag.indexOf("=")
    if (equals !== -1) {
      append(options, flag.slice(0, equals), flag.slice(equals + 1))
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      append(options, flag, next)
      index += 1
    } else {
      append(options, flag, true)
    }
  }

  return { args, options }
}
