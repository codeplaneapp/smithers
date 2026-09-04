/**
 * The race pin's conversion of an engine failure into its own typed
 * conformance diagnostic.
 *
 * The double starts both real pin-supplied branch closures, then fails the run
 * itself. This reaches the defensive successful-fiber check without weakening
 * the assertion to an untyped exit check.
 */
import * as Effect from "effect/Effect"
import type { EngineSubject as Subject } from "../src/EngineSubject.ts"
import * as EngineSubject from "../src/EngineSubject.ts"
import * as MemoryEngine from "../src/MemoryEngine.ts"
import * as Race from "../src/pins/Race.ts"
import { EngineUnavailableError } from "../src/TestingError.ts"
import { expect, it } from "../src/Vitest.ts"

const failingRaceSubject: Subject = EngineSubject.make({
  name: "failing-race-subject",
  run: ((options) =>
    Effect.gen(function*() {
      const race = options.flow.steps[0]
      if (race?.kind === "race") {
        yield* Effect.forEach(
          race.branches,
          (branch) =>
            branch.kind === "step"
              ? branch.run(options.payload).pipe(Effect.forkChild({ startImmediately: true }))
              : Effect.void,
          { discard: true }
        )
        yield* Effect.yieldNow
      }
      return yield* Effect.fail(new EngineUnavailableError({ message: "race execution escaped" }))
    })) as Subject["run"],
  result: () => Effect.fail(new EngineUnavailableError({ message: "no result" })),
  interrupt: () => Effect.void,
  resume: () => Effect.fail(new EngineUnavailableError({ message: "no resume" })),
  journal: () => Effect.succeed([])
})

it.effect("reports a failed fresh race with the conformance code and pin", () =>
  Effect.gen(function*() {
    const error = yield* Race.cases[0]!.run(failingRaceSubject).pipe(Effect.flip)
    expect(error).toMatchObject({
      code: "conformance_violation",
      pin: "race/loser-interrupted"
    })
    expect((error as { readonly message: string }).message).toContain("fresh race escaped as a failure or defect")
  }))

it.scoped("reports a subject that re-races instead of replaying its recorded winner", () =>
  Effect.gen(function*() {
    const store = yield* MemoryEngine.makeStore()
    const base = yield* MemoryEngine.make(store)
    let submitted: Parameters<Subject["run"]>[0] | undefined
    let replayExecutionId: string | undefined
    let replaying = false
    const rerunsOnResume = EngineSubject.make({
      name: "reruns-race-on-resume",
      run: (options) => {
        submitted = options
        return base.run(options)
      },
      result: base.result,
      interrupt: base.interrupt,
      resume: (executionId) =>
        Effect.suspend(() => {
          if (submitted === undefined) {
            return Effect.fail(new EngineUnavailableError({ message: "nothing was submitted" }))
          }
          replaying = true
          replayExecutionId = `${executionId}/incorrect-replay`
          return base.run({ ...submitted, executionId: replayExecutionId })
        }),
      journal: (executionId) => base.journal(replaying ? replayExecutionId! : executionId)
    })

    const error = yield* Race.cases[1]!.run(rerunsOnResume).pipe(Effect.flip)
    expect(error).toMatchObject({
      code: "conformance_violation",
      pin: "race/recorded-winner-replay"
    })
    expect((error as { readonly message: string }).message).toContain("reconstruct the journaled winner")
  }))
