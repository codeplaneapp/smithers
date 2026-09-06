/** A persistent Node host must plan from the same refreshed catalog it executes. */
import { ControlRuntime } from "@smthrs/control"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"

const writeFlow = (root: string, name: string, prompt: string, capability = "fs:read:before/**") => {
  const directory = join(root, "flows", name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, "flow.mdx"),
    `---\ndescription: ${prompt}\nmodel: anthropic:test-model\ncapabilities: ["${capability}"]\n---\n${prompt}\n`
  )
}

const withProject = async <A>(
  program: (root: string) => Effect.Effect<A, unknown, Registry.Registry | ControlRuntime.ControlRuntime>
): Promise<A> => {
  const root = mkdtempSync(join(tmpdir(), "smithers-registry-refresh-"))
  try {
    writeFlow(root, "review", "Original review")
    const registry = NodeControl.layerRegistry(root)
    const engine = NodeControl.engineDurable(root, registry)
    return await Effect.runPromise(
      program(root).pipe(Effect.provide(Layer.merge(engine.runtime, registry)), Effect.scoped)
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

it("replans from refreshed source and authority while preserving the original approved plan", () =>
  withProject((root) =>
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      const runtime = yield* ControlRuntime.ControlRuntime
      const first = yield* runtime.plan({ flowId: "review", input: {} })
      const token = yield* runtime.lookupApproval(first.card.approval.target)
      yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal(), "run")

      yield* Effect.sync(() => writeFlow(root, "review", "Updated review", "fs:read:after/**"))
      yield* registry.refresh()
      const current = yield* registry.get("review")
      const second = yield* runtime.plan({ flowId: "review", input: {} })

      expect(second.card.planId).not.toBe(first.card.planId)
      expect(second.card.executionDigest).toBe(Descriptor.executionDigest(current))
      expect(second.card.executionDigest).not.toBe(first.card.executionDigest)
      expect(second.card.digest).not.toBe(first.card.digest)
      expect(second.card.envelope.capabilities).toEqual(["fs:read:after/**"])
      const original = yield* runtime.getPlan(first.card.planId)
      expect(original.card).toEqual(first.card)
      expect(original.decision).toBe("approved")
    })
  ))

it("lists and plans newly discovered flows and stops offering removed flows", () =>
  withProject((root) =>
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      const runtime = yield* ControlRuntime.ControlRuntime
      const first = yield* runtime.plan({ flowId: "review", input: {} })
      expect((yield* runtime.listFlows).map((flow) => flow.flowId)).toContain("review")

      yield* Effect.sync(() => {
        writeFlow(root, "added", "Newly discovered")
        rmSync(join(root, "flows", "review"), { recursive: true })
      })
      yield* registry.refresh()

      const listed = yield* runtime.listFlows
      expect(listed).toContainEqual({ flowId: "added", description: "Newly discovered" })
      expect(listed.some((flow) => flow.flowId === "review")).toBe(false)
      expect(listed.some((flow) => flow.flowId === "system/test")).toBe(true)
      const added = yield* runtime.plan({ flowId: "added", input: {} })
      expect(added.card.executionDigest).toBe(Descriptor.executionDigest(yield* registry.get("added")))
      expect((yield* Effect.flip(runtime.plan({ flowId: "review", input: {} })))._tag).toBe("/control/FlowNotFound")
      expect((yield* runtime.getPlan(first.card.planId)).card).toEqual(first.card)
    })
  ))
