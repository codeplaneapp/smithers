import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as EffectHandlerRegistry from "../../src/internal/EffectHandlerRegistry.ts"
import * as Rewind from "../../src/internal/Rewind.ts"
import { TimeTravelStore } from "../../src/TimeTravelStore.ts"
import { runReal } from "../RealTimeTravelHarness.ts"

const filename = process.argv[2]
const runId = process.argv[3]
const stage = process.argv[4]
if (filename === undefined || runId === undefined || (stage !== "after-audit" && stage !== "after-archive")) {
  throw new Error("usage: rewind-crash-child.ts <database> <run-id> <after-audit|after-archive>")
}

const checkpoint = Effect.sync(() => {
  process.stdout.write(`${JSON.stringify({ stage })}\n`)
})

// A process entrypoint: running the Effect here is the intended boundary.
await Effect.runPromise(runReal(
  filename,
  Effect.gen(function*() {
    const store = yield* TimeTravelStore
    const wrapped = stage === "after-archive"
      ? TimeTravelStore.of({
        ...store,
        updateAudit: (id, patch) =>
          patch.status === "completed"
            ? checkpoint.pipe(Effect.andThen(Effect.never))
            : store.updateAudit(id, patch)
      })
      : store
    return yield* Rewind.rewind({
      runId,
      frame: { lineageId: `${runId}/root`, seq: 0 },
      owner: { hostId: `crash-child:${process.pid}`, pid: process.pid, nonce: `crash-child:${process.pid}` },
      auditId: `${runId}-audit`,
      ...(stage === "after-audit"
        ? {
          hooks: {
            beforeStep: (step) =>
              step === "write-audit"
                ? checkpoint.pipe(Effect.andThen(Effect.never))
                : Effect.void
          }
        }
        : {})
    }).pipe(
      Effect.provideService(TimeTravelStore, wrapped),
      Effect.provide(EffectHandlerRegistry.layerNoop)
    )
  })
))

// The parent always SIGKILLs at a checkpoint. Reaching here is a fixture defect.
process.exitCode = 2
