/**
 * Bridges registry schema locators to command-line shaped input.
 *
 * @since 0.1.0
 */
import type * as Descriptor from "@smthrs/registry/Descriptor"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { FsError } from "../FsError.ts"

/**
 * Positional and named values collected from one invocation.
 *
 * The agent surface produces positionals as an array; incur produces them as a
 * named record. Both are accepted so one bridge serves both projections.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Positional = ReadonlyArray<string> | Readonly<Record<string, unknown>>

/**
 * The command-line projection of a route's input schema.
 *
 * `args` and `options` are the declarative descriptors a CLI framework may
 * mount. They are currently left undefined because registry discovery records
 * a schema *locator*, not a schema: the authoritative check is {@link
 * CommandSchema.decode}, which runs the real Effect schema.
 *
 * TODO(/fs): emit declarative arg/option descriptors once discovery can
 * project a module's input schema without evaluating the module.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CommandSchema {
  readonly args: undefined
  readonly options: undefined
  readonly assemble: (args: Positional, options: Readonly<Record<string, unknown>>) => unknown
  readonly decode: (value: unknown) => Effect.Effect<unknown, FsError>
}

const positionalText = (args: Positional): string =>
  Array.isArray(args)
    ? args.join(" ")
    : Object.values(args as Readonly<Record<string, unknown>>).map(String).join(" ")

const schemaFailure = (
  code: "decode_failed" | "encode_failed",
  method: string
) =>
(cause: unknown): FsError =>
  new FsError({
    code,
    method,
    description: cause instanceof Error
      ? cause.message
      : code === "encode_failed"
      ? "Output did not match the flow schema"
      : "Input did not match the flow schema",
    cause
  })

const markdownArgs: CommandSchema = {
  args: undefined,
  options: undefined,
  assemble: (args, options) => ({ args: positionalText(args), ...options }),
  decode: (value) => Effect.succeed(value)
}

const none: CommandSchema = {
  args: undefined,
  options: undefined,
  assemble: () => ({}),
  decode: () => Effect.succeed({})
}

const structured: CommandSchema = {
  args: undefined,
  options: undefined,
  assemble: (args, options) =>
    Array.isArray(args)
      ? { ...options, ...(args.length === 0 ? {} : { args }) }
      : { ...(args as Readonly<Record<string, unknown>>), ...options },
  // A module's schema is only available once the module is loaded, which the
  // invoker does; decoding here would force the module during parsing.
  decode: (value) => Effect.succeed(value)
}

/**
 * Projects a route's input locator onto the command line.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const toCommandSchema = (ref: Descriptor.SchemaRef): Effect.Effect<CommandSchema, FsError> => {
  switch (ref._tag) {
    case "MarkdownArgs":
      return Effect.succeed(markdownArgs)
    case "None":
      return Effect.succeed(none)
    case "Module":
    // An inline document describes the same struct a module locator points
    // at, so the command line assembles the same way. The document is a JSON
    // Schema rather than a decoder, and the invoker holds the real schema, so
    // parsing still does not decode.
    case "Inline":
      return Effect.succeed(structured)
    case "MarkdownOutput":
      return Effect.fail(
        new FsError({
          code: "unsupported_schema",
          method: "SchemaBridge.toCommandSchema",
          description: "An output schema locator cannot describe command input"
        })
      )
  }
}

/**
 * Encodes a flow's output through its declared schema.
 *
 * @category encoding
 * @since 0.1.0
 * @slop
 */
export const encodeOutput = (
  schema: Schema.Top,
  value: unknown
): Effect.Effect<unknown, FsError> =>
  // A flow's declared output schema carries no encoding services at this
  // boundary; the assertion keeps that requirement off every caller's R.
  (Schema.encodeUnknownEffect(schema)(value) as Effect.Effect<unknown, Schema.SchemaError>).pipe(
    Effect.mapError(schemaFailure("encode_failed", "SchemaBridge.encodeOutput"))
  )
