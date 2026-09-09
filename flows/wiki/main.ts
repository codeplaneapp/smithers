/** Executable boundary only: Node-compatible process APIs also run under Bun. */
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { pages, sourceFiles } from "../../factory/wiki/catalog.ts"
import { operations } from "./operations.ts"
import type { Input } from "./schema.ts"

const { values } = parseArgs({ options: {
  check: { type: "boolean" }, root: { type: "string" }, output: { type: "string" }, verified: { type: "boolean" },
  model: { type: "string", default: "openai:gpt-5.6-sol" }, run: { type: "string" },
  database: { type: "string" }, help: { type: "boolean" }
} })
if (values.help) {
  console.log("node --experimental-strip-types flows/wiki/main.ts [--verified] [--model provider:model] [--output path] [--database .flows/engine.db] [--run id]\nDefault: a clearly unreviewed preview. --verified performs real AgentAction semantic review and fails if any section lacks support. Runtime host is selected from the actual Node/Bun executable.")
} else {
  const root = resolve(values.root ?? process.cwd()), output = resolve(root, values.output ?? ".flows/wiki")
  if (values.check) {
    console.log(JSON.stringify(await Effect.runPromise(operations({ root, output }).check(pages, values.verified).pipe(Effect.provide(NodeServices.layer))), null, 2))
  } else {
  const [{ Action, Interpreter }, { Capability }, { Wiki }, { actionLayers, agentLayers }] = await Promise.all([
    import("@smthrs/flow"), import("@smthrs/flows"), import("./workflow.ts"), import("./runtime.ts")
  ])
  const runtime = typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? await import("@smthrs/flows/NodeRuntime") : await import("@smthrs/flows/BunRuntime")
  const input: Input = { pages, mode: values.verified ? "verified" : "preview", reviewer: values.model }
  // A preflight source capture prints the exact input identity before admission;
  // actions independently recapture and the write gate rechecks it after review.
  await Effect.runPromise(Effect.forEach(pages, (page) => operations({ root, output }).collect(page)).pipe(Effect.provide(NodeServices.layer)))
  const layers = Layer.mergeAll(actionLayers({ root, output }), Interpreter.layer(Wiki),
    ...(values.verified ? [agentLayers((await import("../release-support/runtime.ts")).liveSeats(values.model), 900_000)] : []))
    .pipe(Layer.provideMerge(Action.layerImplementations))
  const rule = (action: "fs:read" | "fs:write", resource: string) => new Capability.Permission.Rule({ effect: "allow", pattern: new Capability.Capability.CapabilityPattern({ action, resource }) })
  const rules = [
    ...[...new Set([root, ...sourceFiles.map((file) => resolve(root, file)), output, `${output}/**`, resolve(output, "..")])].map((resource) => rule("fs:read", resource)),
    ...[output, `${output}/**`].map((resource) => rule("fs:write", resource))
  ]
  const runId = values.run ?? `wiki-${crypto.randomUUID()}`
  console.log(JSON.stringify({ runId, output, mode: input.mode, model: values.verified ? values.model : null }))
  const result = await Effect.runPromise(Effect.scoped(Wiki.execute(input, { executionId: runId }).pipe(Effect.provide(runtime.layerHost({
    filename: resolve(root, values.database ?? ".flows/engine.db"), workspaceRoot: root, owner: { hostId: `wiki-${process.pid}` }, signals: [],
    rules: [rules]
  }, layers)))))
  console.log(JSON.stringify({ runId, result }, null, 2))
  }
}
