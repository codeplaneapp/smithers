/**
 * `Fixture` is exported twice under one name: a hand-written interface and a
 * `Schema.Struct`. `decode`'s signature resolves to the interface, so the
 * compiler only ever checks the one direction that signature happens to use,
 * and the two shapes were free to drift while staying assignable that way.
 * These are the checks that hold them together, in the same compile-time form
 * `ModelLikeParity` uses for the model contracts.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, type Schema } from "effect"
import { decode, Fixture, type RecordedCall } from "../src/Fixture.ts"
import type { ModelRequestLike } from "../src/ModelLike.ts"

type Decoded = Schema.Schema.Type<typeof Fixture>
type DecodedCall = Decoded["calls"][number]

// The direction `decode`'s own signature claims: what the schema produces is a
// `Fixture`. A field the schema stopped producing, or a type it widened, fails
// `tsc` rather than this run.
const _schemaSatisfiesInterface: Fixture = {} as Decoded

// The whole-value reverse direction is deliberately false, in exactly one
// place. `tools[].parameters` is `Record<string, unknown>` on the interface,
// because `ModelRequestLike` mirrors `@smthrs/model`'s tool shape, and
// `Record<string, Json>` in the schema, because a fixture is written to a file
// and read back. The narrowing is the point, and the run below proves it is
// real rather than accidental.
//
// Everything else has to match, so the key sets are compared level by level: a
// field added to one side and not the other fails `tsc` here, which is the
// drift the single forward assignment could not see.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _fixtureKeys: Exact<keyof Decoded, keyof Fixture> = true
const _callKeys: Exact<keyof DecodedCall, keyof RecordedCall> = true
const _requestKeys: Exact<keyof DecodedCall["request"], keyof ModelRequestLike> = true
const _paramsKeys: Exact<keyof DecodedCall["request"]["params"], keyof ModelRequestLike["params"]> = true
const _toolKeys: Exact<
  keyof DecodedCall["request"]["tools"][number],
  keyof ModelRequestLike["tools"][number]
> = true

const request = (modelId: string): ModelRequestLike => ({
  modelId,
  system: [{ type: "text", text: "You are a concise reviewer." }],
  messages: [{ role: "user", content: [{ type: "text", text: "Summarize PR 4821." }] }],
  tools: [],
  params: {}
})

const fixture = (model: string, modelId: string): unknown => ({
  calls: [{ request: request(modelId), model, events: [] }]
})

describe("the Fixture interface and the Fixture schema are one contract", () => {
  it("decodes into a value the interface accepts", () =>
    Effect.runPromise(Effect.gen(function*() {
      const decoded = yield* decode(fixture("openai:gpt-5-mini", "openai:gpt-5-mini"))
      // Not a cast: `decoded` is typed by the interface, and reading a
      // `RecordedCall` field off it is what proves the decode produced one.
      const call: RecordedCall = decoded.calls[0]!
      expect(call.model).toBe("openai:gpt-5-mini")
      expect(call.request.modelId).toBe("openai:gpt-5-mini")
    })))

  it.effect("rejects a call whose model disagrees with its own request.modelId", () =>
    Effect.gen(function*() {
      const exit = yield* decode(fixture("anthropic:claude-sonnet-4", "openai:gpt-5-mini")).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      // The message names both values, because the fixture author has to know
      // which of the two to change.
      const rendered = String(exit.cause)
      expect(rendered).toContain("anthropic:claude-sonnet-4")
      expect(rendered).toContain("openai:gpt-5-mini")
    }))

  it.effect("rejects a tool whose parameters are not JSON, which is the one place the schema is narrower", () =>
    Effect.gen(function*() {
      const tool = { name: "review", description: "Review a diff.", parameters: { validate: () => true } }
      const call = {
        request: { ...request("openai:gpt-5-mini"), tools: [tool] },
        model: "openai:gpt-5-mini",
        events: []
      }
      const exit = yield* decode({ calls: [call] }).pipe(Effect.exit)
      // The interface would accept this value: `parameters` is
      // `Record<string, unknown>` there. A fixture is a file, so the schema
      // refuses it, and that refusal is what the missing reverse assignment
      // above stands for.
      expect(exit._tag).toBe("Failure")
    }))
})
