/** Use the host's existing registered project flows, without another gateway or runtime. */
import { FlowRuntime } from "@smthrs/flow"
import * as Executable from "@smthrs/registry/Executable"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Crypto, Effect, Layer, Schema } from "effect"
import { CodingError, Implementation, Receipt } from "./schema.ts"
import { Implement, RunCheck } from "./workflow.ts"

const invoke = (name: string, input: Schema.Json, key: ReadonlyArray<string>) => Effect.gen(function*() {
  const catalog = yield* Executable.Catalog
  const instance = yield* FlowRuntime.FlowInstance
  const runtime = yield* FlowRuntime.FlowRuntime
  const crypto = yield* Crypto.Crypto
  const executable = catalog.executables.find(entry => entry.descriptor.name === name)
  if (!executable) return yield* Effect.fail(new CodingError({ code: "unavailable", message: `Project flow ${name} is not registered in this host` }))
  const descriptorDigest = Descriptor.executionDigest(executable.descriptor)
  if (descriptorDigest === undefined) return yield* Effect.fail(new CodingError({ code: "unavailable", message: `Project flow ${name} has no verified executable identity` }))
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
    name, descriptorDigest, input, key
  ]))).pipe(Effect.mapError(cause => new CodingError({ code: "execution", message: `Could not identify project flow invocation: ${String(cause)}` })))
  const suffix = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
  // The runtime reads the ambient FlowInstance and persists the parent edge.
  // Full payload and verified descriptor identity prevent stale child reuse.
  return yield* runtime.execute(executable.flow, {
    executionId: `${instance.executionId}/coding/${suffix}`,
    payload: { input }
  }).pipe(Effect.catch(cause => Effect.fail(new CodingError({ code: "execution", message: `Project flow ${name} failed: ${String(cause)}` }))))
})

/** The deployment supplies its existing Executable.Catalog and FlowRuntime layers. */
export const catalogLayers = Layer.mergeAll(
  Implement.toLayer(input => invoke(input.change.implementation, input,
    ["implement", input.change.id, input.parent.commitId]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Implementation)),
      Effect.catch(cause => Effect.fail(cause instanceof CodingError ? cause : new CodingError({ code: "execution", message: `Implementation flow returned invalid JJ revision evidence: ${String(cause)}` })))
    )),
  RunCheck.toLayer(input => invoke(input.check.flow, input,
    ["check", input.implementation.change, input.implementation.head.commitId, input.check.id]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Receipt)),
      Effect.catch(cause => Effect.fail(cause instanceof CodingError ? cause : new CodingError({ code: "invalid_receipt", message: `Check flow returned invalid revision evidence: ${String(cause)}` })))
    ))
)
