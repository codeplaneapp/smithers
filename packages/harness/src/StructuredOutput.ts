/**
 * Turning one agent's final text into a value the declared output schema
 * accepts, or into a typed failure.
 *
 * A model may answer with a bare JSON document, prose wrapped around a JSON
 * document, a fenced block, or JSON of the wrong shape. Downstream nodes must
 * never receive that ambiguity, so this module implements the recovery
 * contract in `docs/specs/Concepts/Structured Output.md`:
 *
 * 1. parse the complete, BOM-stripped response and decode it;
 * 2. otherwise scan once for balanced JSON containers, take the container
 *    whose matching close ends last, and decode that;
 * 3. otherwise report a typed {@link StructuredOutputFailure} carrying bounded
 *    diagnostics, which is what a caller re-prompts with when it still holds a
 *    correction slot.
 *
 * Every candidate is decoded by the declared schema. Extraction never relaxes
 * validation: it only decides which bytes are offered to it, and the schema may
 * accept any JSON root rather than silently requiring an object.
 *
 * The prompt half is {@link instructions}. It renders the declared schema as a
 * JSON Schema document placed in the run's system teaching, which is BAML's
 * `ctx.output_format` injection reached through the seam the vault note
 * specifies — the model is told the shape before it answers, and the answer is
 * still validated locally. Provider acceptance is not a cast.
 *
 * Reference consulted: `reference/effect`
 * `packages/effect/src/unstable/ai/LanguageModel.ts` `generateObject`, which
 * sends `responseFormat: { type: "json", schema }` and then decodes the result
 * with the same schema, failing `AiError.InvalidOutputError` on mismatch. The
 * decode-and-fail-typed half is copied. The provider `responseFormat` half is
 * not reachable here: `@smthrs/model`'s `ModelRequest.GenerationParams` has no
 * response-format field, and the cell loop's final answer is a `Cell.Complete`
 * `output` string rather than a provider-decoded value, so the schema is
 * carried in the prompt and enforced at this boundary.
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * The terminal failure of one structured-output boundary.
 *
 * It carries what an operator needs to tell two identical-looking refusals
 * apart: which schema was demanded, how many correction slots the attempt
 * consumed out of its budget, the digest of the last candidate that was
 * offered to the decoder, and the bounded issue list.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class StructuredOutputFailure extends Schema.TaggedError<StructuredOutputFailure>()(
  "/harness/StructuredOutputFailure",
  {
    /** The declared output schema's canonical digest. */
    schema: Schema.String,
    /** SHA-256 of the text the decoder was last offered. */
    candidate: Schema.String,
    /** Correction attempts already spent on this boundary. */
    corrections: Schema.Number,
    /** The correction budget the boundary was declared with. */
    limit: Schema.Number,
    /** At most {@link maxIssues} rendered validation issues. */
    issues: Schema.Array(Schema.String),
    message: Schema.String
  }
) {}

/**
 * The most validation issues a failure or a correction prompt carries.
 *
 * Bounded for the same reason smithers bounds its own validation summary: a
 * wide struct that mismatched everywhere would otherwise spend the correction
 * prompt's whole budget restating the schema back to the model.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maxIssues = 5

/**
 * The JSON Schema document for a declared output schema.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const jsonSchema = (schema: Schema.Top): unknown => {
  const document = Schema.toJsonSchemaDocument(schema)
  return Object.keys(document.definitions).length > 0
    ? { ...document.schema, $defs: document.definitions }
    : document.schema
}

/**
 * The canonical digest of a declared output schema.
 *
 * Two declarations that render the same JSON Schema name the same boundary, so
 * this is what a step key folds in rather than the schema value itself.
 *
 * @category identity
 * @since 0.1.0
 * @slop
 */
export const digest = (schema: Schema.Top): string => Digest.digest(Digest.canonical(jsonSchema(schema)))

/**
 * The system teaching that tells a run what its final `output` must be.
 *
 * Written against the cell contract: a cell finishes by calling
 * `ctx.done(output)`, and the sandbox rejects a returned transition, so the
 * instruction is about the argument of that call and not about the assistant
 * message around it.
 *
 * @category prompts
 * @since 0.1.0
 * @slop
 */
export const instructions = (schema: Schema.Top): string =>
  `## Required output shape

Finish by calling \`ctx.done(output)\`. The \`output\` you pass must be a string
holding exactly ONE JSON document that validates against this JSON Schema. No
prose, no explanation, and no code fence around it.

\`\`\`json
${JSON.stringify(jsonSchema(schema), null, 2)}
\`\`\``

/**
 * The correction teaching appended when a candidate failed to decode.
 *
 * It restates the schema and the bounded diagnostics and nothing else: a
 * correction does not reinterpret the task, so the original prompt is repeated
 * verbatim by the caller and only this section is new.
 *
 * @category prompts
 * @since 0.1.0
 * @slop
 */
export const correction = (failure: StructuredOutputFailure): string =>
  `## Your previous answer did not validate

The output you passed to \`ctx.done\` could not be decoded against the required
schema. Call \`ctx.done(output)\` again with the same information as ONE JSON
document that validates.

Validation issues:
${failure.issues.map((issue) => `- ${issue}`).join("\n")}`

const stripBom = (text: string): string => text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

/**
 * The balanced JSON container whose matching close ends last.
 *
 * Scans once, left to right, tracking object and array delimiters, quoted
 * strings, and escapes. A mismatched close abandons the open container rather
 * than pairing it with the wrong opener, so a truncated prefix cannot be
 * reported as a complete document. `undefined` means the text holds no
 * balanced container at all.
 *
 * This is the array-capable form of smithers' `extractLastBalancedJson`, which
 * is object-only.
 *
 * @category extraction
 * @since 0.1.0
 * @slop
 */
export const lastBalanced = (text: string): string | undefined => {
  const stack: Array<string> = []
  let start = -1
  let found: string | undefined = undefined
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === "\"") quoted = false
      continue
    }
    if (char === "\"") {
      if (stack.length > 0) quoted = true
      continue
    }
    if (char === "{" || char === "[") {
      if (stack.length === 0) start = index
      stack.push(char)
      continue
    }
    if (char === "}" || char === "]") {
      const opener = stack.pop()
      if (opener === undefined) continue
      if ((char === "}") !== (opener === "{")) {
        // Mismatched close: abandon the whole open container rather than
        // reporting a pairing the text does not contain.
        stack.length = 0
        start = -1
        continue
      }
      if (stack.length === 0 && start >= 0) found = text.slice(start, index + 1)
    }
  }
  return found
}

/**
 * The candidates offered to the decoder, in the declared recovery order.
 *
 * @category extraction
 * @since 0.1.0
 * @slop
 */
export const candidates = (text: string): ReadonlyArray<string> => {
  const stripped = stripBom(text).trim()
  const balanced = lastBalanced(stripped)
  return balanced === undefined || balanced === stripped ? [stripped] : [stripped, balanced]
}

const issuesOf = (error: unknown): ReadonlyArray<string> => {
  /* v8 ignore next -- both callers pass an `Error`: `JSON.parse` throws `SyntaxError`, and `Schema.decodeUnknownEffect` fails with `SchemaError`, which extends `Data.TaggedError` and so extends `Error`; the `String` arm only discharges the `unknown` a `catch` binding and a schema failure channel are typed as */
  const rendered = error instanceof Error ? error.message : String(error)
  return rendered.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).slice(0, maxIssues)
}

/**
 * Decodes one agent answer with the declared output schema.
 *
 * Tries every {@link candidates} entry in order and returns the first the
 * schema accepts. When none does, the failure reports the issues raised by the
 * LAST candidate, which is the narrowest text the extractor could isolate and
 * therefore the one a correction prompt should be about.
 *
 * @category decoding
 * @since 0.1.0
 * @slop
 */
export const decode = <S extends Schema.Top>(
  schema: S,
  text: string,
  attempt: { readonly corrections: number; readonly limit: number }
): Effect.Effect<S["Type"], StructuredOutputFailure, S["DecodingServices"]> =>
  Effect.gen(function*() {
    const offered = candidates(text)
    const decoder = Schema.decodeUnknownEffect(schema)
    let issues: ReadonlyArray<string> = ["the answer held no JSON document"]
    for (const candidate of offered) {
      let parsed: unknown
      try {
        parsed = JSON.parse(candidate)
      } catch (error) {
        issues = issuesOf(error)
        continue
      }
      const result = yield* Effect.result(decoder(parsed))
      if (result._tag === "Success") return result.success
      issues = issuesOf(result.failure)
    }
    return yield* new StructuredOutputFailure({
      schema: digest(schema),
      candidate: Digest.digest(offered[offered.length - 1]!),
      corrections: attempt.corrections,
      limit: attempt.limit,
      issues,
      message:
        `The agent's answer did not validate against its declared output schema after ${attempt.corrections} of ${attempt.limit} corrections`
    })
  })
