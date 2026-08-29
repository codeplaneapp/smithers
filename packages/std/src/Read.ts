/**
 * Read flow declaration and portable handler.
 *
 * `content` is raw file text. It used to be rendered as `NNN\t<line>`, and that
 * rendering was the single most expensive tool defect measured on the 45-instance
 * SWE-bench trace program: an anchor copied out of a read carried the gutter, so
 * every `edit` built from a read missed, and every cell that wanted a literal
 * line had to strip the prefix in JavaScript first. Two instances (django-13346,
 * django-14351) spent whole frames writing string surgery against text the file
 * does not contain. Line numbers are facts about the page, so they are page
 * fields — `startLine` and `endLine` — and never bytes inside the text.
 *
 * Every line in `content` is a whole line: a page cut short by the byte budget
 * drops its trailing partial line rather than handing back a fragment that looks
 * like an anchor and is not one.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { capability, envelope } from "./internal/Declaration.ts"
import { DEFAULT_READ_LIMIT, MAX_LINE_CHARS, MAX_OUTPUT_BYTES, notice, slice, truncateBytes } from "./internal/Text.ts"
import * as StdError from "./StdError.ts"

/**
 * Registry name for the read flow.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const name = "read"

/**
 * Model-facing description of the read flow.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const description =
  "Read a text file by 1-based offset and limit. content is RAW file text with no line-number prefixes, so any line of it is an edit anchor as it stands; the numbers are startLine/endLine."

/**
 * Input schema for the read flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  path: Schema.String.annotate({ description: "Path of the text file to read" }),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "1-based line offset"
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "Maximum number of lines to return"
  })
})

/**
 * Output schema for the read flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Output = Schema.Struct({
  content: Schema.String.annotate({
    description: "Raw page text, byte-for-byte as the file holds it and never line-number prefixed"
  }),
  startLine: Schema.Number.annotate({ description: "First returned 1-based line number" }),
  endLine: Schema.Number.annotate({ description: "Last returned 1-based line number" }),
  totalLines: Schema.Number.annotate({ description: "Total number of source lines" }),
  truncated: Schema.Boolean.annotate({ description: "Whether displayed output was truncated" }),
  notice: Schema.optional(Schema.String.annotate({ description: "Truncation disclosure" }))
})

/**
 * Static conservative effect envelope for the read flow.
 *
 * @category effects
 * @since 0.1.0
 */
export const effects = envelope({
  tier: "sealed",
  mode: "hermetic",
  reads: ["/**"],
  writes: []
})

/**
 * Narrows the read effect envelope to one input path.
 *
 * @category effects
 * @since 0.1.0
 */
export const effectsFor = (input: typeof Input.Type) =>
  envelope({
    tier: "sealed",
    mode: "hermetic",
    reads: [input.path],
    writes: []
  })

/**
 * Capabilities required by the read flow.
 *
 * @category capabilities
 * @since 0.1.0
 */
export const capabilities = [capability("fs:read", "/**")]

/**
 * Declaration-only read flow.
 *
 * @category flows
 * @since 0.1.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

const fileError = (path: string) =>
  new StdError.StdError({
    code: "not_found",
    message: `File not found: ${path}`,
    path
  })

/**
 * Reads, validates, and renders one page of a UTF-8 text file.
 *
 * The kernel filesystem exposes bytes rather than a guaranteed UTF-8 string,
 * so decoding is deliberately fatal to keep binary input in the typed channel.
 *
 * @category handlers
 * @since 0.1.0
 */
export const run = Effect.fn("Read.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem
  const info = yield* fileSystem.stat(input.path).pipe(Effect.mapError(() => fileError(input.path)))
  if (info.type === "Directory") {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "is_directory",
        message: `Cannot read a directory: ${input.path}`,
        path: input.path
      })
    )
  }
  if (info.type !== "File") {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "not_found",
        message: `File not found: ${input.path}`,
        path: input.path
      })
    )
  }
  const bytes = yield* fileSystem.readFile(input.path).pipe(Effect.mapError(() => fileError(input.path)))
  if (bytes.includes(0)) {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "binary_file",
        message: `Cannot read binary file: ${input.path}`,
        path: input.path
      })
    )
  }
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () =>
      new StdError.StdError({
        code: "binary_file",
        message: `File is not valid UTF-8: ${input.path}`,
        path: input.path
      })
  })
  const offset = input.offset ?? 1
  const page = slice(text, { offset, limit: input.limit ?? DEFAULT_READ_LIMIT })
  if (offset > page.totalLines) {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "offset_out_of_range",
        message: `Line offset ${offset} is outside ${input.path}`,
        path: input.path
      })
    )
  }
  const lines = page.lines.map((line) => line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line)
  const longLinesTruncated = lines.some((line, index) => line !== page.lines[index])
  const rendered = truncateBytes(lines.join("\n"), MAX_OUTPUT_BYTES, { keep: "head" })
  // A byte budget cuts mid-line. A partial line reads like an anchor and is not
  // one, so the page ends at the last whole line it could afford.
  const whole = rendered.truncated
    ? rendered.text.slice(0, Math.max(0, rendered.text.lastIndexOf("\n")))
    : rendered.text
  const shown = rendered.truncated ? (whole === "" ? 0 : whole.split("\n").length) : lines.length
  const endLine = page.startLine + Math.max(0, shown - 1)
  const truncated = longLinesTruncated || rendered.truncated || page.endLine < page.totalLines
  const clipped = longLinesTruncated
    ? ` Lines longer than ${MAX_LINE_CHARS} characters are clipped, so such a line is not an edit anchor.`
    : ""
  return {
    content: whole,
    startLine: page.startLine,
    endLine,
    totalLines: page.totalLines,
    truncated,
    ...(truncated ? { notice: `${notice("lines", shown, page.totalLines)}${clipped}` } : {})
  }
})
