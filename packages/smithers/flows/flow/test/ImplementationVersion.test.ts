import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Graph, Interpreter } from "@smthrs/flow"
import { Node, Plan } from "@smthrs/plan"
import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import { withCrypto } from "./Crypto.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

const declaration = (implementationVersion?: string) =>
  Action.make("version/read", {
    payload: {},
    success: Schema.String,
    implementationVersion
  })

describe("declared implementation versions", () => {
  it("validates declaration versions and requires registration attestation", () => {
    const versioned = declaration("read/v1")
    expect(() => declaration("")).toThrow(Schema.SchemaError)
    expect(() => Action.make({ name: "version/inline", implementationVersion: "", execute: Effect.void }))
      .toThrow(Schema.SchemaError)
    for (const supplied of [undefined, "read/v2"]) {
      expect(() => versioned.toLayer(() => Effect.succeed("ok"), { implementationVersion: supplied }))
        .toThrow(Action.ImplementationVersionMismatch)
    }
    expect(() => declaration().toLayer(() => Effect.succeed("ok"), { implementationVersion: "read/v1" }))
      .toThrow(Action.ImplementationVersionMismatch)
    expect(() => versioned.toLayer(() => Effect.succeed("ok"), { implementationVersion: "read/v1" })).not.toThrow()
  })

  it.effect("preserves versions through declaration copies, inline actions, and registration", () =>
    withCrypto(Effect.gen(function*() {
      const mark = Context.Reference<string>("version/mark", { defaultValue: () => "default" })
      const versioned = declaration("read/v1")
      for (
        const copy of [versioned, versioned.annotate(mark, "one"), versioned.annotateMerge(Context.make(mark, "two"))]
      ) {
        expect(copy.implementationVersion).toBe("read/v1")
        const implementation = yield* copy.requirement.pipe(Effect.provide(
          copy.toLayer(() => Effect.succeed("ok"), { implementationVersion: "read/v1" }).pipe(
            Layer.provide(layerMemory)
          )
        ))
        expect(implementation.implementationVersion).toBe("read/v1")
      }
      const inline = Action.make({ name: "version/inline", implementationVersion: "inline/v1", execute: Effect.void })
      expect(inline.annotate(mark, "one").implementationVersion).toBe("inline/v1")
      expect(inline.annotateMerge(Context.make(mark, "two")).implementationVersion).toBe("inline/v1")
    })))

  it.effect("changes dependent plan identity while preserving unversioned material", () =>
    withCrypto(Effect.gen(function*() {
      const build = (version?: string) =>
        Graph.build(
          Node.all({
            upstream: Node.succeed("unchanged"),
            operation: declaration(version).call({})
          }),
          undefined,
          { callbackIdentity: "stable" }
        )
      const before = yield* Plan.compile({
        planId: "version-plan",
        flow: "version",
        nodes: Graph.drafts(build("read/v1"))
      })
      const same = yield* Plan.compile({
        planId: "version-plan",
        flow: "version",
        nodes: Graph.drafts(build("read/v1"))
      })
      const after = yield* Plan.compile({
        planId: "version-plan",
        flow: "version",
        nodes: Graph.drafts(build("read/v2"))
      })
      expect(same).toEqual(before)
      expect(after.digest).not.toBe(before.digest)
      expect(after.nodes[0]?.key).toBe(before.nodes[0]?.key)
      expect(after.nodes[1]?.key).not.toBe(before.nodes[1]?.key)
      expect(after.nodes[2]?.key).not.toBe(before.nodes[2]?.key)
      const legacy = Graph.drafts(build())[1]?.material.body as { declaration: Record<string, unknown> }
      expect(Object.hasOwn(legacy.declaration, "implementationVersion")).toBe(false)
    })))

  it.effect("preflights every node against the actual registry before any action dispatch", () =>
    withCrypto(Effect.gen(function*() {
      let calls = 0
      const first = Action.make("version/first", { payload: {}, success: Schema.String })
      const required = declaration("read/v2")
      const wired = declaration("read/v1")
      const flow = Flow.make("version/flow", {
        payload: {},
        success: Schema.Struct({ first: Schema.String, second: Schema.String }),
        body: Node.capture({ version: "fixture/v1", actions: [first.name, required.name] }, () =>
          Node.all({
            first: first.call({}),
            second: required.call({})
          }))
      })
      const implementations = Layer.merge(
        first.toLayer(() =>
          Effect.sync(() => {
            calls++
            return "first"
          })
        ),
        wired.toLayer(() =>
          Effect.sync(() => {
            calls++
            return "second"
          }), { implementationVersion: "read/v1" })
      )
      const exit = yield* Effect.exit(
        flow.execute({}).pipe(Effect.provide(
          Interpreter.layerWithImplementations(flow, implementations).pipe(Layer.provideMerge(layerMemory))
        ))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          code: "implementation_version_mismatch",
          node: "root.flow.all.second"
        })
      }
      expect(calls).toBe(0)
    })))
})

describe("canonical content-reuse admission", () => {
  it.effect("requires a version for every declared form of a sealed idempotency key", () =>
    withCrypto(Effect.gen(function*() {
      for (const idempotencyKey of ["shared", { request: "shared" }, () => "shared"] as const) {
        let calls = 0
        const keyed = Action.make("canonical/keyed", { payload: {}, success: Schema.String, idempotencyKey })
        const flow = Flow.make("canonical/keyed-flow", {
          payload: {},
          success: Schema.String,
          body: Node.capture({ action: keyed.name, bodyVersion: "v1" }, () => keyed.call({}))
        })
        const exit = yield* Effect.exit(
          flow.execute({}).pipe(Effect.provide(
            Interpreter.layerWithImplementations(
              flow,
              keyed.toLayer(() =>
                Effect.sync(() => {
                  calls++
                  return "ran"
                })
              )
            ).pipe(Layer.provideMerge(layerMemory))
          ))
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({
            code: "missing_implementation_version",
            node: "root.flow",
            message: expect.stringContaining("Declare implementationVersion on Action.make")
          })
        }
        expect(calls).toBe(0)
      }
    })))

  it.effect("a manual registry and process-local callbacks cannot bypass whole-graph version admission", () =>
    withCrypto(Effect.gen(function*() {
      let calls = 0
      const first = Action.make("canonical/first", { payload: {}, success: Schema.String })
      const keyed = Action.make("canonical/manual", { payload: {}, success: Schema.String, idempotencyKey: "shared" })
      const manual = Layer.effect(keyed.requirement)(Effect.gen(function*() {
        const registry = yield* Action.Implementations
        const implementation: Action.Implementation = {
          name: keyed.name,
          action: () =>
            Effect.sync(() => {
              calls++
              return "manual"
            })
        }
        yield* registry.add(implementation)
        return implementation
      }))
      const flow = Flow.make("canonical/manual-flow", {
        payload: {},
        success: Schema.Struct({ first: Schema.String, second: Schema.String }),
        body: () => Node.all({ first: first.call({}), second: keyed.call({}) })
      })
      const exit = yield* Effect.exit(
        flow.execute({}).pipe(Effect.provide(
          Interpreter.layerWithImplementations(
            flow,
            Layer.merge(
              manual,
              first.toLayer(() =>
                Effect.sync(() => {
                  calls++
                  return "first"
                })
              )
            ),
            { callbackIdentity: "process-local" }
          ).pipe(Layer.provideMerge(layerMemory))
        ))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          code: "missing_implementation_version",
          node: "root.flow.all.second"
        })
      }
      expect(calls).toBe(0)
    })))

  it.effect("permits invocation-scoped actions without manufacturing a content version", () =>
    withCrypto(Effect.gen(function*() {
      for (const tier of ["sealed", "compensable", "irreversible"] as const) {
        const operation = Action.make(`canonical/${tier}`, {
          payload: {},
          tier,
          success: Schema.String,
          ...(tier === "sealed" ? {} : { idempotencyKey: "request" })
        })
        const flow = Flow.make(`canonical/${tier}-flow`, {
          payload: {},
          success: Schema.String,
          body: Node.capture({ action: operation.name, bodyVersion: "v1" }, () => operation.call({}))
        })
        expect(
          yield* flow.execute({}).pipe(Effect.provide(
            Interpreter.layerWithImplementations(flow, operation.toLayer(() => Effect.succeed(tier))).pipe(
              Layer.provideMerge(layerMemory)
            )
          ))
        ).toBe(tier)
      }
    })))

  it.effect("refuses a detached action whose content-reuse declaration can no longer be checked", () =>
    withCrypto(Effect.gen(function*() {
      let calls = 0
      const operation = declaration("read/v1")
      const node = operation.call({})
      const detached = { ...node, ast: JSON.parse(JSON.stringify(node.ast)) as Node.Ast }
      const flow = Flow.make("canonical/detached", {
        payload: {},
        success: Schema.String,
        body: Node.capture({ action: operation.name, bodyVersion: "v1" }, () => detached)
      })
      const exit = yield* Effect.exit(
        flow.execute({}).pipe(Effect.provide(
          Interpreter.layerWithImplementations(
            flow,
            operation.toLayer(() =>
              Effect.sync(() => {
                calls++
                return "ran"
              }), { implementationVersion: "read/v1" })
          ).pipe(Layer.provideMerge(layerMemory))
        ))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          code: "incomplete_graph",
          node: "root.flow",
          message: expect.stringContaining("lost its declaration")
        })
      }
      expect(calls).toBe(0)
    })))
})
