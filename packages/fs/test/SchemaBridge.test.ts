import * as Descriptor from "@smthrs/registry/Descriptor"
import { Cause, Context, Effect, Option, Schema, SchemaTransformation } from "effect"
import { describe, expect, it } from "vitest"
import * as SchemaBridge from "../src/internal/SchemaBridge.ts"

const moduleRef = new Descriptor.SchemaRefModule({ path: "/absolute/flow.ts", field: "input" })

const failure = async (effect: Effect.Effect<unknown, unknown>): Promise<any> => {
  const exit = await Effect.runPromise(Effect.exit(effect))
  expect(exit._tag).toBe("Failure")
  if (exit._tag !== "Failure") throw new Error("expected failure")
  return Option.getOrThrow(Cause.findErrorOption(exit.cause))
}

describe("SchemaBridge", () => {
  it("represents a schema-free command with actual undefined", async () => {
    const command = await Effect.runPromise(
      SchemaBridge.toCommandSchema(new Descriptor.SchemaRefNone({}), Schema.Void)
    )
    expect(await Effect.runPromise(command.decode(command.assemble([], {})))).toBeUndefined()
    expect((await failure(command.decode(command.assemble(["unexpected"], {})))).code).toBe("decode_failed")
    expect((await failure(command.decode(command.assemble([], { unexpected: true })))).code).toBe("decode_failed")
  })

  it("joins markdown arguments but refuses output locators as input", async () => {
    const command = await Effect.runPromise(
      SchemaBridge.toCommandSchema(
        new Descriptor.SchemaRefMarkdownArgs({}),
        Schema.Struct({ args: Schema.String })
      )
    )
    expect(await Effect.runPromise(command.decode(command.assemble(["hello", "world"], {})))).toEqual({
      args: "hello world"
    })
    expect(await Effect.runPromise(command.decode(command.assemble({ first: 1, second: "two" }, {})))).toEqual({
      args: "1 two"
    })
    const unsupported = await failure(
      SchemaBridge.toCommandSchema(new Descriptor.SchemaRefMarkdownOutput({}), Schema.String)
    )
    expect(unsupported.code).toBe("unsupported_schema")
  })

  it("projects object fields without bypassing the authoritative schema", async () => {
    const Input = Schema.Struct({
      title: Schema.String,
      finite: Schema.Finite,
      integer: Schema.Int,
      enabled: Schema.Boolean,
      tags: Schema.Array(Schema.String),
      nested: Schema.Struct({ value: Schema.String }),
      anything: Schema.Unknown,
      optional: Schema.optionalKey(Schema.String)
    })
    const command = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, Input))
    const decoded = await Effect.runPromise(command.decode(command.assemble([], {
      title: "review",
      finite: "1.5",
      integer: "2",
      enabled: "true",
      tags: ["a", "b"],
      nested: "{\"value\":\"inside\"}",
      anything: "{\"free\":true}"
    })))

    expect(decoded).toEqual({
      title: "review",
      finite: 1.5,
      integer: 2,
      enabled: true,
      tags: ["a", "b"],
      nested: { value: "inside" },
      anything: { free: true }
    })
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(
      (await failure(command.decode(command.assemble([], {
        title: "review",
        finite: "not-finite",
        integer: "2",
        enabled: true,
        tags: [],
        nested: {},
        anything: null
      })))).code
    ).toBe("decode_failed")
  })

  it("supports an explicit args property and schema definitions", async () => {
    const WithArgs = Schema.Struct({ args: Schema.Array(Schema.String) })
    const argsCommand = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, WithArgs))
    expect(await Effect.runPromise(argsCommand.decode(argsCommand.assemble(["a", "b"], {})))).toEqual({
      args: ["a", "b"]
    })

    const Identified = Schema.Struct({ value: Schema.Finite }).annotate({ identifier: "FsIdentified" })
    const identified = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, Identified))
    expect(await Effect.runPromise(identified.decode(identified.assemble([], { value: "3" })))).toEqual({ value: 3 })

    const optional = await Effect.runPromise(
      SchemaBridge.toCommandSchema(moduleRef, Schema.Struct({ value: Schema.optionalKey(Schema.String) }))
    )
    expect(await Effect.runPromise(optional.decode(optional.assemble([], {})))).toEqual({})
  })

  it("projects scalar schemas from a positional or named input", async () => {
    const finite = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, Schema.Finite))
    expect(await Effect.runPromise(finite.decode(finite.assemble(["4.5"], {})))).toBe(4.5)
    expect(await Effect.runPromise(finite.decode(finite.assemble([], { input: "5.5" })))).toBe(5.5)
    expect(await Effect.runPromise(finite.decode(finite.assemble({ input: "6.5" }, {})))).toBe(6.5)
    expect((await failure(finite.decode(finite.assemble([], {})))).code).toBe("decode_failed")

    const array = await Effect.runPromise(SchemaBridge.toCommandSchema(moduleRef, Schema.Array(Schema.String)))
    expect(await Effect.runPromise(array.decode(array.assemble([], { input: ["a", "b"] })))).toEqual(["a", "b"])

    const dictionary = await Effect.runPromise(
      SchemaBridge.toCommandSchema(moduleRef, Schema.Record(Schema.String, Schema.String))
    )
    expect(await Effect.runPromise(dictionary.decode(dictionary.assemble([], { input: "{\"a\":\"b\"}" })))).toEqual({
      a: "b"
    })
  })

  it("snapshots decoded inputs and encoded outputs as inert JSON", async () => {
    const source = { nested: { value: 1 } }
    const decoded = await Effect.runPromise(SchemaBridge.decodeInput(Schema.Json, source)) as typeof source
    source.nested.value = 2
    expect(decoded).toEqual({ nested: { value: 1 } })
    expect(Object.isFrozen(decoded.nested)).toBe(true)

    expect(await Effect.runPromise(SchemaBridge.encodeOutput(Schema.Void, undefined))).toBeUndefined()
    expect(await Effect.runPromise(SchemaBridge.decodeInput(Schema.Void, undefined))).toBeUndefined()
    expect(await Effect.runPromise(SchemaBridge.encodeOutput(Schema.DateFromString, new Date("2026-01-01")))).toBe(
      "2026-01-01T00:00:00.000Z"
    )
    expect((await failure(SchemaBridge.decodeInput(Schema.DateFromString, "2026-01-01"))).code).toBe("decode_failed")
    expect((await failure(SchemaBridge.encodeOutput(Schema.instanceOf(Date), new Date()))).code).toBe("encode_failed")
  })

  it("converts missing schema services into typed refusals", async () => {
    class Prefix extends Context.Service<Prefix, string>()("test/fs/SchemaBridge/Prefix") {}
    const ServiceSchema = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformOrFail({
          decode: (value) => Effect.map(Prefix, (prefix) => `${prefix}${value}`),
          encode: (value) => Effect.map(Prefix, (prefix) => value.slice(prefix.length))
        })
      )
    )

    expect((await failure(SchemaBridge.decodeInput(ServiceSchema, "value"))).code).toBe("decode_failed")
    expect((await failure(SchemaBridge.encodeOutput(ServiceSchema, "prefix:value"))).code).toBe("encode_failed")
    expect(
      await Effect.runPromise(
        SchemaBridge.decodeInput(ServiceSchema, "value").pipe(Effect.provideService(Prefix, "prefix:"))
      )
    ).toBe("prefix:value")
    expect(
      await Effect.runPromise(
        SchemaBridge.encodeOutput(ServiceSchema, "prefix:value").pipe(Effect.provideService(Prefix, "prefix:"))
      )
    ).toBe("value")
  })

  it("snapshots programmatic input before asynchronous loading", async () => {
    const source = { value: [1] }
    const snapshot = await Effect.runPromise(SchemaBridge.snapshotInput(source)) as {
      readonly value: ReadonlyArray<number>
    }
    source.value[0] = 2
    expect(snapshot).toEqual({ value: [1] })
    expect(Object.isFrozen(snapshot.value)).toBe(true)
    expect(await Effect.runPromise(SchemaBridge.snapshotInput(undefined))).toBeUndefined()
    expect((await failure(SchemaBridge.snapshotInput({ value: undefined }))).code).toBe("decode_failed")
  })
})
