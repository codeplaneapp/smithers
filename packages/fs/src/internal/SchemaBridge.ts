/**
 * Bridges loaded Effect schemas to command-line shaped input.
 *
 * @private
 * @since 0.1.0
 */
import type * as Descriptor from "@smthrs/registry/Descriptor"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { z } from "incur"
import { FsError } from "../FsError.ts"
import * as Boundary from "./Boundary.ts"

/**
 * Positional values collected by the agent parser or Incur.
 *
 * @private
 * @since 0.1.0
 */
export type Positional = ReadonlyArray<string> | Readonly<Record<string, unknown>>

/**
 * Input assembled before authoritative Effect schema decoding.
 *
 * @private
 * @since 0.1.0
 */
export interface Assembly {
  readonly value: unknown
}

/**
 * Declarative Incur descriptors plus the authoritative Effect decoder.
 *
 * @private
 * @since 0.1.0
 */
export interface CommandSchema {
  readonly args: z.ZodObject<any> | undefined
  readonly options: z.ZodObject<any> | undefined
  readonly assemble: (args: Positional, options: Readonly<Record<string, unknown>>) => Assembly
  readonly decode: (assembly: Assembly) => Effect.Effect<unknown, FsError>
}

type JsonSchema = Readonly<Record<string, unknown>>

const schemaFailure = (code: "decode_failed" | "encode_failed", method: string): FsError =>
  new FsError({
    code,
    method,
    description: code === "encode_failed"
      ? "The flow output did not satisfy its schema"
      : "The command input did not satisfy the flow schema"
  })

const recoverSchema = <A>(
  effect: Effect.Effect<A, unknown, unknown>,
  code: "decode_failed" | "encode_failed",
  method: string
): Effect.Effect<A, FsError> => (Effect.matchCauseEffect(effect, {
  onFailure: () => Effect.fail(schemaFailure(code, method)),
  onSuccess: Effect.succeed
}) as Effect.Effect<A, FsError>)

const jsonValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const record = (input: unknown): JsonSchema | undefined =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as JsonSchema
    : undefined

const resolveReference = (
  input: JsonSchema,
  definitions: JsonSchema
): JsonSchema => {
  const reference = input.$ref
  if (typeof reference !== "string") return input
  // Effect's draft-2020-12 document generator emits only local `$defs`
  // references and always supplies their target in `definitions`.
  return record(definitions[reference.slice("#/$defs/".length)])!
}

const zodFor = (input: unknown, definitions: JsonSchema): z.ZodType => {
  // Every node emitted by `Schema.toJsonSchemaDocument` is a JSON object.
  const raw = input as JsonSchema
  const schema = resolveReference(raw, definitions)
  const variants = schema.anyOf
  // Effect renders `Schema.Number` as `number | "Infinity" | "-Infinity" |
  // "NaN"`, and every union or nullable field the same way, so a projection
  // that ignored `anyOf` would advertise the most common field in the
  // repository as an untyped `{}` on `--schema`, OpenAPI, and the MCP tool
  // list, and would forward anything at all to the authoritative decoder.
  if (Array.isArray(variants)) return z.union(variants.map((variant) => zodFor(variant, definitions)))
  const type = schema.type
  if (type === "string") {
    const values = schema.enum
    // A literal set is advertised exactly, so an agent reading the tool list
    // learns which words the flow accepts instead of "any string".
    return Array.isArray(values) ? z.enum(values as ReadonlyArray<string> as [string, ...Array<string>]) : z.string()
  }
  if (type === "integer") return z.preprocess(jsonValue, z.int())
  // `jsonValue` rather than `z.coerce`: coercion turns `""`, `null`, and `[]`
  // into `0`, which would silently invent input for a durable run.
  if (type === "number") return z.preprocess(jsonValue, z.number())
  if (type === "boolean") return z.preprocess(jsonValue, z.boolean())
  if (type === "null") return z.preprocess(jsonValue, z.null())
  if (type === "array") return z.array(zodFor(schema.items, definitions))
  if (type === "object") return z.preprocess(jsonValue, z.record(z.string(), z.unknown()))
  return z.preprocess(jsonValue, z.unknown())
}

const documentOf = (schema: Schema.Top): {
  readonly root: JsonSchema
  readonly definitions: JsonSchema
} => {
  const document = Schema.toJsonSchemaDocument(schema)
  return {
    root: document.schema,
    definitions: document.definitions
  }
}

const objectDescriptors = (
  root: JsonSchema,
  definitions: JsonSchema
): {
  readonly args: z.ZodObject<any> | undefined
  readonly options: z.ZodObject<any>
} => {
  const properties = record(root.properties)!
  const required = Array.isArray(root.required)
    ? new Set(root.required.filter((value): value is string => typeof value === "string"))
    : new Set<string>()
  const shape: Record<string, z.ZodType> = Object.create(null) as Record<string, z.ZodType>
  for (const [name, property] of Object.entries(properties)) {
    const field = zodFor(property, definitions)
    shape[name] = required.has(name) ? field : field.optional()
  }
  const options = z.object(shape).strict()
  // Positionals are advertised only when the flow schema really has an `args`
  // field. Mounting one anywhere else would publish a parameter that the strict
  // options object is guaranteed to refuse.
  return {
    args: Object.hasOwn(shape, "args") ? z.object({ args: shape.args! }) : undefined,
    options
  }
}

const positionalRecord = (args: Positional): Readonly<Record<string, unknown>> => {
  if (!Array.isArray(args)) return args as Readonly<Record<string, unknown>>
  return args.length === 0 ? {} : { args }
}

/**
 * Joins positional tokens into the single argument string Markdown flows take.
 *
 * Incur delivers positionals as the record `{ args: ["a", "b"] }`, so the
 * tokens have to be read out of that key rather than off the record's values.
 * Anything that is not a list of strings is returned unchanged so the
 * authoritative `args: string` decode refuses it: `String(value)` would invoke
 * a caller-supplied `toString` and turn `["a", "b"]` into `"a,b"`.
 */
const positionalText = (args: Positional): unknown => {
  const values: unknown = Array.isArray(args) ? args : (args as Readonly<Record<string, unknown>>).args
  if (values === undefined) return ""
  if (!Array.isArray(values)) return values
  return values.every((value) => typeof value === "string") ? values.join(" ") : values
}

const decodeWith = (
  schema: Schema.Top,
  zodSchema: z.ZodType,
  assembly: Assembly
): Effect.Effect<unknown, FsError> =>
  Effect.suspend(() => {
    const parsed = zodSchema.safeParse(assembly.value)
    if (!parsed.success) return Effect.fail(schemaFailure("decode_failed", "SchemaBridge.decodeInput"))
    return decodeInput(schema, parsed.data)
  })

/**
 * Authoritatively decodes and snapshots one loaded flow input.
 *
 * @private
 * @since 0.1.0
 */
export const decodeInput = (schema: Schema.Top, value: unknown): Effect.Effect<unknown, FsError> =>
  recoverSchema(
    Schema.decodeUnknownEffect(schema)(value) as Effect.Effect<unknown, unknown, unknown>,
    "decode_failed",
    "SchemaBridge.decodeInput"
  ).pipe(
    Effect.flatMap((decoded) => {
      if (decoded === undefined) return Effect.succeed(undefined)
      const admitted = Boundary.admitJson(decoded)
      return admitted.ok
        ? Effect.succeed(admitted.value)
        : Effect.fail(schemaFailure("decode_failed", "SchemaBridge.decodeInput"))
    })
  )

/**
 * Projects a loaded route input schema onto command-line args and options.
 *
 * @private
 * @since 0.1.0
 */
export const toCommandSchema = (
  ref: Descriptor.SchemaRef,
  schema: Schema.Top
): Effect.Effect<CommandSchema, FsError> => {
  if (ref._tag === "MarkdownOutput") {
    return Effect.fail(
      new FsError({
        code: "unsupported_schema",
        method: "SchemaBridge.toCommandSchema",
        description: "An output locator cannot describe command input"
      })
    )
  }
  if (ref._tag === "None") {
    const empty = z.object({}).strict()
    return Effect.succeed(Object.freeze({
      // A schema-free command takes nothing, so it advertises no positionals.
      args: undefined,
      options: empty,
      assemble: (args: Positional, options: Readonly<Record<string, unknown>>) =>
        Object.freeze({ value: { ...positionalRecord(args), ...options } }),
      decode: (assembly: Assembly) =>
        Object.keys(assembly.value as Record<string, unknown>).length === 0
          ? recoverSchema(
            Schema.decodeUnknownEffect(schema)(undefined) as Effect.Effect<unknown, unknown, unknown>,
            "decode_failed",
            "SchemaBridge.decodeInput"
          )
          : Effect.fail(schemaFailure("decode_failed", "SchemaBridge.decodeInput"))
    }))
  }
  if (ref._tag === "MarkdownArgs") {
    const command = z.object({ args: z.string() }).strict()
    return Effect.succeed(Object.freeze({
      args: z.object({ args: z.array(z.string()).optional() }),
      options: z.object({}).strict(),
      assemble: (args: Positional, options: Readonly<Record<string, unknown>>) =>
        Object.freeze({ value: { args: positionalText(args), ...options } }),
      decode: (assembly: Assembly) => decodeWith(schema, command, assembly)
    }))
  }

  const { definitions, root } = documentOf(schema)
  const resolved = resolveReference(root, definitions)
  if (record(resolved.properties) !== undefined) {
    const descriptors = objectDescriptors(resolved, definitions)
    const command = descriptors.options
    return Effect.succeed(Object.freeze({
      args: descriptors.args,
      options: descriptors.options,
      assemble: (args: Positional, options: Readonly<Record<string, unknown>>) =>
        Object.freeze({ value: { ...positionalRecord(args), ...options } }),
      decode: (assembly: Assembly) => decodeWith(schema, command, assembly)
    }))
  }

  const value = zodFor(resolved, definitions)
  const command = z.object({ input: value }).strict()
  return Effect.succeed(Object.freeze({
    args: z.object({ input: value.optional() }),
    options: z.object({ input: value.optional() }).strict(),
    assemble: (args: Positional, options: Readonly<Record<string, unknown>>) => {
      const positional = Array.isArray(args) ? args[0] : (args as Readonly<Record<string, unknown>>).input
      return Object.freeze({ value: { input: options.input ?? positional } })
    },
    decode: (assembly: Assembly) =>
      Effect.flatMap(
        Effect.suspend(() => {
          const parsed = command.safeParse(assembly.value)
          return parsed.success
            ? Effect.succeed(parsed.data.input)
            : Effect.fail(schemaFailure("decode_failed", "SchemaBridge.decodeInput"))
        }),
        (input) => decodeInput(schema, input)
      )
  }))
}

/**
 * Encodes and snapshots a flow output through its declared schema.
 *
 * @private
 * @since 0.1.0
 */
export const encodeOutput = (schema: Schema.Top, value: unknown): Effect.Effect<unknown, FsError> =>
  recoverSchema(
    Schema.encodeUnknownEffect(schema)(value) as Effect.Effect<unknown, unknown, unknown>,
    "encode_failed",
    "SchemaBridge.encodeOutput"
  ).pipe(
    Effect.flatMap((encoded) => {
      if (encoded === undefined) return Effect.succeed(undefined)
      const admitted = Boundary.admitJson(encoded)
      return admitted.ok
        ? Effect.succeed(admitted.value)
        : Effect.fail(schemaFailure("encode_failed", "SchemaBridge.encodeOutput"))
    })
  )

/**
 * Snapshots programmatic input before any module-loading await.
 *
 * @private
 * @since 0.1.0
 */
export const snapshotInput = (input: unknown): Effect.Effect<Boundary.Json | undefined, FsError> => {
  if (input === undefined) return Effect.succeed(undefined)
  const admitted = Boundary.admitJson(input)
  return admitted.ok
    ? Effect.succeed(admitted.value)
    : Effect.fail(schemaFailure("decode_failed", "SchemaBridge.snapshotInput"))
}
