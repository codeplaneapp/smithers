import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as KeyMaterial from "../src/KeyMaterial.ts"
import * as StepKey from "../src/StepKey.ts"
import { withCrypto, withCryptoFailure } from "./Crypto.ts"

const material = (overrides: Partial<KeyMaterial.KeyMaterial> = {}): KeyMaterial.KeyMaterial => ({
  version: KeyMaterial.version,
  kind: "sealed",
  body: { action: "render" },
  inputs: [],
  layers: [],
  capabilities: [],
  ...overrides
})

describe("StepKey", () => {
  it.effect("produces a key1_ digest and is stable under set reordering", () =>
    Effect.gen(function*() {
      const left = yield* withCrypto(
        StepKey.content({ body: 1, inputs: {}, layers: ["b", "a"], capabilities: { fs: ["w", "r", "r"] } })
      )
      const right = yield* withCrypto(
        StepKey.content({ body: 1, inputs: {}, layers: ["a", "b"], capabilities: { fs: ["r", "w"] } })
      )
      expect(left).toMatch(/^key1_[0-9a-f]{64}$/)
      expect(left).toBe(right)
    }))

  it.effect("hashes a branded digest input differently from a literal of the same shape", () =>
    Effect.gen(function*() {
      const branded = yield* withCrypto(
        StepKey.content({ body: 1, inputs: { a: StepKey.digestInput("abc") }, layers: [], capabilities: {} })
      )
      const literal = yield* withCrypto(
        StepKey.content({ body: 1, inputs: { a: { digest: "abc" } }, layers: [], capabilities: {} })
      )
      expect(StepKey.isDigestInput(StepKey.digestInput("abc"))).toBe(true)
      expect(StepKey.isDigestInput({ digest: "abc" })).toBe(false)
      expect(StepKey.isDigestInput(null)).toBe(false)
      expect(branded).not.toBe(literal)
    }))

  it.effect("keeps the environment namespace non-aliasing and order-sensitive", () =>
    Effect.gen(function*() {
      const separate = yield* withCrypto(StepKey.content({
        body: 1,
        inputs: {},
        layers: ["a"],
        capabilities: {},
        environment: { declared: true, layers: ["b"], capabilities: { fs: ["r"] } }
      }))
      const merged = yield* withCrypto(
        StepKey.content({ body: 1, inputs: {}, layers: ["a", "b"], capabilities: { fs: ["r"] } })
      )
      const undeclared = yield* withCrypto(StepKey.content({
        body: 1,
        inputs: {},
        layers: ["a"],
        capabilities: {},
        environment: { declared: false, layers: ["b"], capabilities: { fs: ["r"] }, runScope: "run-1" }
      }))
      const reordered = yield* withCrypto(StepKey.content({
        body: 1,
        inputs: {},
        layers: ["a"],
        capabilities: {},
        environment: { declared: true, layers: ["b", "c"], capabilities: {} }
      }))
      const swapped = yield* withCrypto(StepKey.content({
        body: 1,
        inputs: {},
        layers: ["a"],
        capabilities: {},
        environment: { declared: true, layers: ["c", "b"], capabilities: {} }
      }))
      expect(separate).not.toBe(merged)
      expect(separate).not.toBe(undeclared)
      expect(reordered).not.toBe(swapped)
    }))

  it.effect("normalizes and dedupes the hermetic declaration", () =>
    Effect.gen(function*() {
      const left = yield* withCrypto(StepKey.content({
        body: 1,
        inputs: {},
        layers: [],
        capabilities: {},
        hermetic: {
          readSet: [{ path: "b", digest: "2" }, { path: "a", digest: "1" }, { path: "a", digest: "1" }, {
            path: "a",
            digest: "0"
          }],
          writeSet: ["out", "out"],
          boundaryMode: "hard"
        }
      }))
      const right = yield* withCrypto(StepKey.content({
        body: 1,
        inputs: {},
        layers: [],
        capabilities: {},
        hermetic: {
          readSet: [{ path: "a", digest: "0" }, { path: "a", digest: "1" }, { path: "b", digest: "2" }],
          writeSet: ["out"],
          boundaryMode: "hard"
        }
      }))
      expect(left).toBe(right)
    }))

  it.effect("normalizes tree, glob, and removal declarations", () =>
    Effect.gen(function*() {
      const identity = (
        writeSet: NonNullable<StepKey.ContentIdentity["hermetic"]>["writeSet"],
        removes: ReadonlyArray<string>
      ) =>
        StepKey.content({
          body: 1,
          inputs: {},
          layers: [],
          capabilities: {},
          hermetic: { readSet: [], writeSet, removes, boundaryMode: "hard" }
        })
      const left = yield* withCrypto(identity([
        { _tag: "Glob", include: ["src/**/*.ts", "src/**/*.ts"], exclude: ["src/z.ts", "src/a.ts"] },
        { _tag: "Glob", include: ["assets/**"] },
        { _tag: "TreeArtifact", path: "dist" },
        "out"
      ], ["stale/z", "stale/a", "stale/a"]))
      const right = yield* withCrypto(identity([
        "out",
        { _tag: "Glob", include: ["assets/**"] },
        { _tag: "TreeArtifact", path: "dist" },
        { _tag: "Glob", include: ["src/**/*.ts"], exclude: ["src/a.ts", "src/z.ts"] }
      ], ["stale/a", "stale/z"]))
      expect(left).toBe(right)
    }))

  it.effect("canonicalizes write entry property order and sorts by code unit", () =>
    Effect.gen(function*() {
      const identity = (writeSet: NonNullable<StepKey.ContentIdentity["hermetic"]>["writeSet"]) =>
        StepKey.content({
          body: 1,
          inputs: {},
          layers: [],
          capabilities: {},
          hermetic: { readSet: [], writeSet, boundaryMode: "hard" }
        })
      const ordinary = { _tag: "TreeArtifact" as const, path: "än/out.js" }
      const reordered = { path: "än/out.js", _tag: "TreeArtifact" as const }
      const left = yield* withCrypto(identity([ordinary, reordered, "z/out.js"]))
      const right = yield* withCrypto(identity(["z/out.js", reordered]))

      expect(left).toBe(right)
    }))

  it.effect("makes an ordinal key run-local", () =>
    Effect.gen(function*() {
      const first = yield* withCrypto(StepKey.ordinal({ runId: "run-1", ordinal: 1, tier: "unsealed" }))
      const second = yield* withCrypto(StepKey.ordinal({ runId: "run-2", ordinal: 1, tier: "unsealed" }))
      expect(first).not.toBe(second)
    }))

  it.effect("substitutes dependency digests and tags every reference variant", () =>
    Effect.gen(function*() {
      const digests = { upstream: "key1_upstream" }
      const pending = yield* withCrypto(
        StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Pending", from: "upstream" }] }), digests)
      )
      const plain = yield* withCrypto(
        StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: "upstream", path: [] }] }), digests)
      )
      const projected = yield* withCrypto(
        StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: "upstream", path: ["a"] }] }), digests)
      )
      const literal = yield* withCrypto(
        StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Literal", value: 1 }] }), digests)
      )
      expect(new Set([pending, plain, projected, literal]).size).toBe(4)
    }))

  it.effect("keeps a literal that spells a digest reference distinct from the reference (D7)", () =>
    Effect.gen(function*() {
      // `fromKeyMaterial` now builds `DigestInput` values and lets
      // `normalizeInputs` be the single normalizer, instead of hand-building
      // `{kind: "ref", digest}` objects that were then wrapped a second time as
      // `{kind: "literal", value: <that object>}`. The double wrap was what made
      // this collision impossible before; the nominal `DigestInputTypeId` brand
      // is what makes it impossible now. A literal value can spell the digest
      // reference's normalized form exactly and still cannot be mistaken for it.
      const digests = { upstream: "key1_upstream" }
      const reference = yield* withCrypto(
        StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: "upstream", path: [] }] }), digests)
      )
      const impostor = yield* withCrypto(
        StepKey.fromKeyMaterial(
          material({
            inputs: [{ _tag: "Literal", value: { kind: "digest", digest: "key1_upstream", reference: "ref" } }]
          }),
          digests
        )
      )
      const projectedImpostor = yield* withCrypto(
        StepKey.fromKeyMaterial(
          material({
            inputs: [{
              _tag: "Literal",
              value: { kind: "digest", digest: "key1_upstream", reference: "ref-projected", path: ["a"] }
            }]
          }),
          digests
        )
      )
      const projected = yield* withCrypto(
        StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: "upstream", path: ["a"] }] }), digests)
      )

      expect(new Set([reference, impostor, projected, projectedImpostor]).size).toBe(4)
    }))

  it.effect("keeps an untagged digest input distinct from a graph reference (D7)", () =>
    Effect.gen(function*() {
      // A caller-supplied `digestInput(d)` carries no `reference`, so it must not
      // collide with the `ref` variant `fromKeyMaterial` produces for the same
      // digest. This is the corner the new discriminator opens.
      const untagged = yield* withCrypto(
        StepKey.content({
          body: { version: 1, declaration: "step" },
          inputs: { "0": StepKey.digestInput("key1_upstream") },
          layers: [],
          capabilities: { declared: [] }
        })
      )
      const tagged = yield* withCrypto(
        StepKey.content({
          body: { version: 1, declaration: "step" },
          inputs: { "0": StepKey.digestInput("key1_upstream", { reference: "ref" }) },
          layers: [],
          capabilities: { declared: [] }
        })
      )

      expect(untagged).not.toBe(tagged)
    }))

  it.effect("folds effects, placement, and the material version into the body", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(StepKey.fromKeyMaterial(material(), {}))
      const withEffects = yield* withCrypto(StepKey.fromKeyMaterial(material({ effects: { net: true } }), {}))
      const withPlacement = yield* withCrypto(StepKey.fromKeyMaterial(material({ placement: "edge" }), {}))
      expect(new Set([base, withEffects, withPlacement]).size).toBe(3)
    }))

  it.effect("folds declared nondeterminism without moving the absent plan key", () =>
    Effect.gen(function*() {
      const deterministic = yield* withCrypto(StepKey.fromKeyMaterial(material(), {}))
      const nondeterministic = yield* withCrypto(
        StepKey.fromKeyMaterial(material({ nondeterministic: true }), {})
      )
      expect(deterministic).toBe("key1_594e55424285180f3bcb35e6075d0e6961b6506cc15d78de0613eac91eeb9cd9")
      expect(nondeterministic).not.toBe(deterministic)
    }))

  it.effect("refuses material with no digest for a declared dependency", () =>
    Effect.gen(function*() {
      const failure = yield* withCryptoFailure(
        StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: "missing", path: [] }] }), {})
      )
      expect(failure).toMatchObject({ code: "missing_dependency" })
    }))

  it.effect("refuses non-content material", () =>
    Effect.gen(function*() {
      const failure = yield* withCryptoFailure(StepKey.fromKeyMaterial(material({ kind: "irreversible" }), {}))
      expect(failure).toMatchObject({ code: "non_content_material" })
    }))

  it.effect("surfaces a canonicalization failure as a typed schema error", () =>
    Effect.gen(function*() {
      const failure = yield* withCryptoFailure(
        Effect.asVoid(StepKey.content({ body: 1n, inputs: {}, layers: [], capabilities: {} }))
      )
      expect(failure).toBeDefined()
    }))
})

describe("StepKey.dispatchIdentity", () => {
  const hermetic: NonNullable<StepKey.ContentIdentity["hermetic"]> = {
    readSet: [{ path: "src/a.ts", digest: "sha256:a" }],
    writeSet: ["out/a.js"],
    boundaryMode: "hard"
  }

  const dispatch = (
    overrides: Partial<KeyMaterial.KeyMaterial>,
    results: Readonly<Record<string, unknown>>,
    boundary: typeof hermetic = hermetic
  ) => StepKey.dispatchIdentity({ material: material(overrides), results, hermetic: boundary })

  it.effect("memoizes a projected value digest across concurrent key computations", () =>
    Effect.gen(function*() {
      let digestCalls = 0
      const countingCrypto = Layer.effect(
        Crypto.Crypto,
        Effect.map(Crypto.Crypto, (crypto) =>
          Crypto.Crypto.of({
            ...crypto,
            digest: (algorithm, data) =>
              Effect.sync(() => {
                digestCalls = digestCalls + 1
              }).pipe(Effect.andThen(crypto.digest(algorithm, data)))
          }))
      ).pipe(Layer.provide(NodeCrypto.layer))
      const inputs = [{ _tag: "Ref", from: "upstream", path: ["value"] }] as const
      const options = {
        material: material({ inputs }),
        results: { upstream: { value: { nested: true } } },
        hermetic
      }
      const digestMemo = StepKey.makeDigestMemo()
      const memoized = yield* (
        Effect.all([
          StepKey.dispatchIdentity({ ...options, digestMemo }),
          StepKey.dispatchIdentity({ ...options, digestMemo })
        ], { concurrency: "unbounded" }).pipe(Effect.provide(countingCrypto))
      )
      const unmemoized = yield* withCrypto(StepKey.dispatchIdentity(options))
      // One projected-value digest plus one final key digest per call.
      expect(digestCalls).toBe(3)
      expect(memoized).toEqual([unmemoized, unmemoized])
    }))

  it.effect("evicts an interrupted projected-value computation", () =>
    Effect.gen(function*() {
      const memo = StepKey.makeDigestMemo()
      const started = yield* Deferred.make<void>()
      const blocked = yield* Deferred.make<void>()
      const first = yield* Effect.forkChild(
        memo.digest(
          "upstream",
          ["value"],
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(blocked)),
            Effect.as("key1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as StepKey.StepKey)
          )
        )
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(first)

      const recovered = yield* memo.digest(
        "upstream",
        ["value"],
        Effect.succeed("key1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as StepKey.StepKey)
      )
      expect(recovered).toBe("key1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    }).pipe(Effect.provide(NodeCrypto.layer)))

  it.effect("folds an engine-resolved environment without moving the absent identity", () =>
    Effect.gen(function*() {
      const absent = yield* withCrypto(dispatch({}, {}))
      const environment: StepKey.EnvironmentIdentity = {
        declared: false,
        layers: ["node-crypto", "workspace"],
        capabilities: { fs: ["read", "write"] }
      }
      const present = yield* withCrypto(StepKey.dispatchIdentity({
        material: material(),
        results: {},
        hermetic,
        environment
      }))
      const scoped = yield* withCrypto(StepKey.dispatchIdentity({
        material: material(),
        results: {},
        hermetic,
        environment: { ...environment, runScope: "run-1" }
      }))
      expect(absent).toBe("key1_70bc16b1ef9256f7301167c9d11f332d39383c61d9f630d99bdc920c066b6ac2")
      expect(present).not.toBe(absent)
      expect(scoped).not.toBe(present)
    }))

  it.effect("folds declared nondeterminism without moving the absent dispatch key", () =>
    Effect.gen(function*() {
      const deterministic = yield* withCrypto(dispatch({}, {}))
      const nondeterministic = yield* withCrypto(dispatch({ nondeterministic: true }, {}))
      expect(deterministic).toBe("key1_70bc16b1ef9256f7301167c9d11f332d39383c61d9f630d99bdc920c066b6ac2")
      expect(nondeterministic).not.toBe(deterministic)
    }))

  it.effect("folds the settled output value of a `Ref`, never the upstream's identity", () =>
    Effect.gen(function*() {
      // The early cutoff: the derivation is handed the upstream's VALUE and
      // nothing else, so there is no channel through which an upstream body
      // edit that left the output byte-identical could reach this key.
      const inputs = [{ _tag: "Ref", from: "upstream", path: [] }] as const
      const first = yield* withCrypto(dispatch({ inputs }, { upstream: { count: 1 } }))
      const again = yield* withCrypto(dispatch({ inputs }, { upstream: { count: 1 } }))
      const changed = yield* withCrypto(dispatch({ inputs }, { upstream: { count: 2 } }))
      expect(first).toBe(again)
      expect(first).not.toBe(changed)
    }))

  it.effect("projects a `Ref` path, so a sibling field of the upstream result cannot re-key it", () =>
    Effect.gen(function*() {
      const inputs = [{ _tag: "Ref", from: "upstream", path: ["taken"] }] as const
      const base = yield* withCrypto(dispatch({ inputs }, { upstream: { taken: "x", ignored: 1 } }))
      const sibling = yield* withCrypto(dispatch({ inputs }, { upstream: { taken: "x", ignored: 2 } }))
      const projected = yield* withCrypto(dispatch({ inputs }, { upstream: { taken: "y", ignored: 1 } }))
      expect(base).toBe(sibling)
      expect(base).not.toBe(projected)
    }))

  it.effect("digests a projection that walks off the end as a stable, distinct value", () =>
    Effect.gen(function*() {
      const deep = [{ _tag: "Ref", from: "upstream", path: ["a", "b"] }] as const
      const offScalar = yield* withCrypto(dispatch({ inputs: deep }, { upstream: { a: "scalar" } }))
      const offNull = yield* withCrypto(dispatch({ inputs: deep }, { upstream: { a: null } }))
      const offMissing = yield* withCrypto(dispatch({ inputs: deep }, { upstream: {} }))
      const present = yield* withCrypto(dispatch({ inputs: deep }, { upstream: { a: { b: null } } }))
      // Every way of missing is the same absence; an explicit `null` is not it.
      expect(new Set([offScalar, offNull, offMissing]).size).toBe(1)
      expect(present).not.toBe(offScalar)
    }))

  it.effect("keeps a projected reference distinct from the unprojected one", () =>
    Effect.gen(function*() {
      const flat = yield* withCrypto(dispatch({ inputs: [{ _tag: "Ref", from: "u", path: [] }] }, { u: { a: 1 } }))
      const nested = yield* withCrypto(dispatch({ inputs: [{ _tag: "Ref", from: "u", path: ["a"] }] }, { u: { a: 1 } }))
      const bare = yield* withCrypto(dispatch({ inputs: [{ _tag: "Ref", from: "u", path: [] }] }, { u: 1 }))
      expect(nested).not.toBe(bare)
      expect(flat).not.toBe(nested)
    }))

  it.effect("folds nothing but a tag for `Pending`: ordering does not change what a node consumes", () =>
    Effect.gen(function*() {
      const inputs = [{ _tag: "Pending", from: "before" }] as const
      const one = yield* withCrypto(dispatch({ inputs }, { before: { anything: 1 } }))
      const other = yield* withCrypto(dispatch({ inputs }, { before: "completely different" }))
      expect(one).toBe(other)
    }))

  it.effect("keeps a literal that spells a resolved reference distinct from the reference", () =>
    Effect.gen(function*() {
      const reference = yield* withCrypto(dispatch({ inputs: [{ _tag: "Ref", from: "u", path: [] }] }, { u: 1 }))
      const digest = yield* withCrypto(StepKey.content({ body: 0, inputs: { "0": 1 }, layers: [], capabilities: {} }))
      const impostor = yield* withCrypto(
        dispatch({ inputs: [{ _tag: "Literal", value: { kind: "digest", digest, reference: "ref" } }] }, { u: 1 })
      )
      expect(reference).not.toBe(impostor)
    }))

  it.effect("folds the node's own declaration and the measured boundary", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(dispatch({}, {}))
      const body = yield* withCrypto(dispatch({ body: { action: "compile" } }, {}))
      const effects = yield* withCrypto(dispatch({ effects: { net: true } }, {}))
      const placement = yield* withCrypto(dispatch({ placement: "edge" }, {}))
      const layers = yield* withCrypto(dispatch({ layers: ["fs"] }, {}))
      const capabilities = yield* withCrypto(dispatch({ capabilities: ["fs:read"] }, {}))
      const measured = yield* withCrypto(
        dispatch({}, {}, { ...hermetic, readSet: [{ path: "src/a.ts", digest: "sha256:b" }] })
      )
      expect(new Set([base, body, effects, placement, layers, capabilities, measured]).size).toBe(7)
    }))

  it.effect("folds declared removals into the dispatch identity", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(dispatch({}, {}))
      const removing = yield* withCrypto(dispatch({}, {}, { ...hermetic, removes: ["out/stale.js"] }))
      expect(removing).not.toBe(base)
    }))

  it.effect("refuses material naming a dependency that has not settled", () =>
    Effect.gen(function*() {
      const failure = yield* withCryptoFailure(dispatch({ inputs: [{ _tag: "Ref", from: "missing", path: [] }] }, {}))
      expect(failure).toMatchObject({ code: "missing_dependency" })
    }))

  it.effect("refuses non-content material", () =>
    Effect.gen(function*() {
      expect(yield* withCryptoFailure(dispatch({ kind: "irreversible" }, {}))).toMatchObject({
        code: "non_content_material"
      })
    }))

  it.effect("surfaces a canonicalization failure as a typed schema error", () =>
    Effect.gen(function*() {
      const failure = yield* withCryptoFailure(
        Effect.asVoid(dispatch({ inputs: [{ _tag: "Ref", from: "u", path: [] }] }, { u: 1n }))
      )
      expect(failure).toBeDefined()
    }))
})

describe("KeyMaterial.dependencies", () => {
  it("lists graph references once, in declaration order, skipping literals", () => {
    expect(KeyMaterial.dependencies(material({
      inputs: [
        { _tag: "Literal", value: 1 },
        { _tag: "Ref", from: "b", path: [] },
        { _tag: "Pending", from: "a" },
        { _tag: "Ref", from: "b", path: ["x"] }
      ]
    }))).toEqual(["b", "a"])
  })

  it("decodes persisted material without a nondeterminism declaration", () => {
    const decoded = Schema.decodeUnknownResult(KeyMaterial.KeyMaterial)(material())
    expect(decoded._tag).toBe("Success")
    if (decoded._tag === "Success") {
      expect(decoded.success.nondeterministic).toBeUndefined()
    }
  })
})
