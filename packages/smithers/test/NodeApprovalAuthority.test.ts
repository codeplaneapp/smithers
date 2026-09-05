import { ApprovalAuthority, ControlRuntime } from "@smthrs/control"
import { Registry } from "@smthrs/registry"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"

for (const discovered of [false, true]) {
  it(`durable Node composition forwards host principal and independent delegation (${discovered ? "registry" : "system"} catalog)`, async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-host-authority-"))
    const principal = { id: "explicit-host-agent", kind: "agent" }
    const approvalAuthority = await Effect.runPromise(ApprovalAuthority.make([
      { principal, scopes: ["once"], targets: ["Plan"] }
    ]))
    try {
      const engine = NodeControl.engineDurable(root, discovered ? Registry.layerNoop() : undefined, {
        principal,
        approvalAuthority
      })
      await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime.ControlRuntime
          const actor = yield* runtime.stampPrincipal()
          expect(actor).toMatchObject(principal)
          const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
          const token = yield* runtime.lookupApproval(card.approval.target)
          expect((yield* Effect.flip(runtime.resolveApproval(token, "approved", actor, "remembered")))._tag).toBe(
            "/control/Unauthorized"
          )
          expect((yield* runtime.getPlan(card.planId)).decision).toBe("pending")
          yield* runtime.resolveApproval(token, "approved", actor, "once")
          expect((yield* runtime.getPlan(card.planId)).decision).toBe("approved")
        }).pipe(Effect.provide(engine.runtime), Effect.scoped)
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
