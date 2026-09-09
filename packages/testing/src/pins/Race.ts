/**
 * Durable race conformance pins.
 *
 * Governing design: `packages/testing/docs/concepts/engine-subject.md`, "Race
 * semantics"; manifest: `packages/testing/test/support/ParityManifest.ts`.
 *
 * @since 0.0.0
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Latch from "effect/Latch"
import * as Ref from "effect/Ref"
import * as TestClock from "effect/testing/TestClock"
import type { ConformanceCase } from "../Conformance.ts"
import type { EngineSubject, ExecutionResult, FlowSpec, JournalEntryLike, StepSpec } from "../EngineSubject.ts"
import { assert, awaitFiber, fail, invoke, waitUntil } from "../internal/Pin.ts"
import { same } from "../internal/Structural.ts"
import type { ConformanceViolation, EngineSubjectError } from "../TestingError.ts"

const loserInterruptedPin = "race/loser-interrupted"
const recordedWinnerPin = "race/recorded-winner-replay"
const recordedLoserPin = "race/recorded-loser-interruption"

interface RaceObservation {
  readonly fresh: ExecutionResult
  readonly replayed: ExecutionResult
  readonly freshJournal: ReadonlyArray<JournalEntryLike>
  readonly replayedJournal: ReadonlyArray<JournalEntryLike>
  readonly winnerKey: string
  readonly loserKey: string
  readonly winnerRuns: number
  readonly loserRuns: number
  readonly loserInterruptions: number
}

const successfulFiber = <A, E>(
  pin: string,
  exit: Exit.Exit<A, E>,
  message: string
): Effect.Effect<A, ConformanceViolation> =>
  Exit.isSuccess(exit) ? Effect.succeed(exit.value) : fail(pin, message, "successful result", exit.cause)

const runRace = (
  pin: string,
  suffix: string,
  engine: EngineSubject
): Effect.Effect<RaceObservation, ConformanceViolation | EngineSubjectError> =>
  Effect.gen(function*() {
    const winnerKey = `race/${suffix}/recorded-winner`
    const loserKey = `race/${suffix}/recorded-loser`
    const freshWinnerStarted = yield* Latch.make()
    const freshLoserStarted = yield* Latch.make()
    const freshWinnerGate = yield* Latch.make()
    const freshLoserGate = yield* Latch.make()
    const replayWinnerGate = yield* Latch.make()
    const replayLoserGate = yield* Latch.make(true)
    const winnerRuns = yield* Ref.make(0)
    const loserRuns = yield* Ref.make(0)
    const loserInterruptions = yield* Ref.make(0)
    let replayPhase = false

    const winner: StepSpec = {
      key: winnerKey,
      sealed: false,
      kind: "step",
      run: () =>
        Effect.suspend(() => {
          const gate = replayPhase ? replayWinnerGate : freshWinnerGate
          return Effect.andThen(
            Ref.update(winnerRuns, (count) => count + 1),
            Effect.andThen(
              freshWinnerStarted.open,
              Effect.as(
                Effect.andThen(
                  gate.await,
                  replayPhase ? Effect.void : Effect.sleep("1 second")
                ),
                "recorded-winner"
              )
            )
          )
        })
    }
    const loser: StepSpec = {
      key: loserKey,
      sealed: false,
      kind: "step",
      run: () =>
        Effect.suspend(() => {
          const gate = replayPhase ? replayLoserGate : freshLoserGate
          return Effect.onInterrupt(
            Effect.andThen(
              Ref.update(loserRuns, (count) => count + 1),
              Effect.andThen(freshLoserStarted.open, Effect.as(gate.await, "recorded-loser"))
            ),
            () => Ref.update(loserInterruptions, (count) => count + 1)
          )
        })
    }
    const flow: FlowSpec = {
      name: `testing/race/${suffix}`,
      steps: [{
        key: `race/${suffix}/parent`,
        sealed: true,
        kind: "race",
        branches: [winner, loser]
      }]
    }
    const executionId = `testing/race/${suffix}/execution`
    const freshFiber = yield* invoke(pin, "run(fork)", () =>
      engine.run({
        flow,
        payload: { command: "race" },
        executionId
      })).pipe(Effect.forkChild({ startImmediately: true }))

    yield* waitUntil(
      pin,
      () => freshWinnerStarted.isOpen() && freshLoserStarted.isOpen(),
      "The subject did not start both race branches."
    )
    yield* freshWinnerGate.open
    yield* TestClock.adjust("1 second")

    const freshExit = yield* awaitFiber(
      pin,
      freshFiber,
      "The fresh race did not settle after its deterministic winner was released."
    )
    const fresh = yield* successfulFiber(
      pin,
      freshExit,
      "The fresh race escaped as a failure or defect."
    )
    const freshJournal = yield* invoke(pin, "journal(fresh)", () => engine.journal(executionId))

    replayPhase = true
    const replayFiber = yield* invoke(pin, "resume(fork)", () => engine.resume(executionId)).pipe(
      Effect.forkChild({ startImmediately: true })
    )
    const replayExit = yield* awaitFiber(
      pin,
      replayFiber,
      "Race replay did not settle from its recorded outcomes."
    )
    const replayed = yield* successfulFiber(
      pin,
      replayExit,
      "Race replay escaped as a failure or defect."
    )
    const replayedJournal = yield* invoke(pin, "journal(replayed)", () => engine.journal(executionId))

    return {
      fresh,
      replayed,
      freshJournal,
      replayedJournal,
      winnerKey,
      loserKey,
      winnerRuns: yield* Ref.get(winnerRuns),
      loserRuns: yield* Ref.get(loserRuns),
      loserInterruptions: yield* Ref.get(loserInterruptions)
    }
  })

/**
 * Pins loser fiber interruption and its journaled aborted outcome.
 *
 * Governing design: `packages/testing/docs/concepts/engine-subject.md`, "Race
 * semantics".
 */
const loserInterrupted: ConformanceCase = {
  name: loserInterruptedPin,
  run: (engine) =>
    Effect.gen(function*() {
      const observed = yield* runRace(loserInterruptedPin, "loser-interrupted", engine)
      yield* assert(
        loserInterruptedPin,
        observed.fresh.status === "completed" && observed.fresh.value === "recorded-winner",
        "The released branch must deterministically win the fresh race.",
        { status: "completed", value: "recorded-winner" },
        observed.fresh
      )
      yield* assert(
        loserInterruptedPin,
        observed.loserRuns === 1 && observed.loserInterruptions === 1,
        "The losing branch must run once and observe fiber interruption.",
        { loserRuns: 1, loserInterruptions: 1 },
        {
          loserRuns: observed.loserRuns,
          loserInterruptions: observed.loserInterruptions
        }
      )
      yield* assert(
        loserInterruptedPin,
        observed.freshJournal.some((entry) => entry.stepKey === observed.loserKey && entry.outcome === "aborted"),
        "The loser interruption must be recorded as an aborted journal outcome.",
        { stepKey: observed.loserKey, outcome: "aborted" },
        observed.freshJournal
      )
    })
}

/**
 * Pins recorded-winner reconstruction under adversarially inverted timing.
 *
 * Governing design: `packages/testing/docs/concepts/engine-subject.md`, "Race
 * semantics".
 */
const recordedWinnerReplay: ConformanceCase = {
  name: recordedWinnerPin,
  run: (engine) =>
    Effect.gen(function*() {
      const observed = yield* runRace(recordedWinnerPin, "recorded-winner-replay", engine)
      yield* assert(
        recordedWinnerPin,
        observed.replayed.status === "completed" && observed.replayed.value === "recorded-winner",
        "Replay must reconstruct the journaled winner instead of re-racing; the recorded loser is timed to win replay.",
        { status: "completed", value: "recorded-winner" },
        observed.replayed
      )
      yield* assert(
        recordedWinnerPin,
        observed.winnerRuns === 1 && observed.loserRuns === 1,
        "Replaying a recorded race must not invoke either branch closure again.",
        { winnerRuns: 1, loserRuns: 1 },
        {
          winnerRuns: observed.winnerRuns,
          loserRuns: observed.loserRuns
        }
      )
      yield* assert(
        recordedWinnerPin,
        same(observed.fresh.value, observed.replayed.value) &&
          same(observed.freshJournal, observed.replayedJournal),
        "Replay must preserve the recorded decision, output, and journal.",
        {
          value: observed.fresh.value,
          journal: observed.freshJournal
        },
        {
          value: observed.replayed.value,
          journal: observed.replayedJournal
        }
      )
    })
}

/**
 * Pins replay of the loser's recorded interruption.
 *
 * Governing design: `packages/testing/docs/concepts/engine-subject.md`, "Race
 * semantics".
 */
const recordedLoserInterruption: ConformanceCase = {
  name: recordedLoserPin,
  run: (engine) =>
    Effect.gen(function*() {
      const observed = yield* runRace(recordedLoserPin, "recorded-loser-interruption", engine)
      const freshLoser = observed.freshJournal.filter((entry) => entry.stepKey === observed.loserKey)
      const replayedLoser = observed.replayedJournal.filter((entry) => entry.stepKey === observed.loserKey)

      yield* assert(
        recordedLoserPin,
        freshLoser.length === 1 && freshLoser[0]?.outcome === "aborted",
        "The fresh loser must have one recorded interruption outcome.",
        [{ stepKey: observed.loserKey, outcome: "aborted" }],
        freshLoser
      )
      yield* assert(
        recordedLoserPin,
        same(freshLoser, replayedLoser),
        "Replaying the loser must yield its recorded interruption rather than executing it again.",
        freshLoser,
        replayedLoser
      )
      yield* assert(
        recordedLoserPin,
        observed.loserRuns === 1 && observed.loserInterruptions === 1,
        "Loser replay must not invoke or interrupt the branch closure a second time.",
        { loserRuns: 1, loserInterruptions: 1 },
        {
          loserRuns: observed.loserRuns,
          loserInterruptions: observed.loserInterruptions
        }
      )
    })
}

/**
 * Race interruption and deterministic replay conformance cases.
 *
 * Every case pins the contract in
 * `packages/testing/docs/concepts/engine-subject.md`, "Race semantics".
 *
 * @category conformance
 * @since 0.0.0
 */
export const cases: ReadonlyArray<ConformanceCase> = Object.freeze([
  loserInterrupted,
  recordedWinnerReplay,
  recordedLoserInterruption
])
