/** Independent byte-boundary oracle shared by the full gate and mutation tier. */
import { expect, it } from "@effect/vitest"
import type { Service as ControlService } from "@smthrs/control/Control"
import type { ControlEvent } from "@smthrs/control/ControlSchema"
import { Effect, Exit, Stream } from "effect"
import * as Projections from "../src/Projections.ts"

for (const offset of [-1, 0, 1]) {
  it.effect(`mutation contract: complete event rows at byte limit ${offset}`, () =>
    Effect.gen(function*() {
      // The public 4 MiB contract is independent of the implementation constant.
      const limit = 4 * 1024 * 1024
      const rows: Array<ControlEvent> = [
        { sequence: 1, kind: "control.test", runId: "byte-oracle", occurredAt: 1, payload: "café😀\"\n" },
        { sequence: 2, kind: "control.test", runId: "byte-oracle", occurredAt: 2, payload: "" }
      ]
      const overhead = Buffer.byteLength(JSON.stringify(rows), "utf8")
      rows[1] = { ...rows[1]!, payload: "x".repeat(limit + offset - overhead) }
      expect(Buffer.byteLength(JSON.stringify(rows), "utf8")).toBe(limit + offset)
      const service = {
        list: () =>
          Effect.succeed({
            _tag: "runs",
            items: [{ runId: "byte-oracle", flowId: "fixture", status: "running", createdAt: 1, updatedAt: 2 }]
          }),
        watch: () => Stream.fromIterable(rows)
      } as unknown as ControlService
      const projection = yield* Projections.make(service)
      const outcome = yield* Effect.exit(projection.snapshot({ _tag: "run-events", runId: "byte-oracle" }))
      if (offset <= 0) {
        expect(outcome._tag).toBe("Success")
        if (Exit.isSuccess(outcome)) expect(outcome.value.rows).toEqual(rows)
      } else {
        expect(outcome._tag).toBe("Failure")
        const refusal = yield* Effect.flip(projection.snapshot({ _tag: "run-events", runId: "byte-oracle" }))
        expect(refusal.code).toBe("resource_limit")
        expect(refusal.message).toBe(`Run event history exceeds ${limit} encoded bytes`)
      }
    }))
}
