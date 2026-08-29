import * as HarnessEngineLike from "@smthrs/harness/EngineLike"
import { Effect } from "effect"
import * as EngineSubject from "../src/EngineSubject.ts"
import * as TestingError from "../src/TestingError.ts"
import { describe, expect, it } from "../src/Vitest.ts"

describe("EngineSubject", () => {
  it("is a distinct port from the harness EngineLike it used to share a name with", () => {
    // The harness port is what the built-in harness *consumes* (seal/splice/
    // suspend). The testing port is the conformance *subject* (run/result/
    // interrupt/resume/journal). Neither structurally satisfies the other, so
    // they must never be exported under one ambiguous name again.
    const subject = EngineSubject.makeNoop()
    expect(Object.keys(subject).sort()).toEqual(
      ["interrupt", "journal", "name", "restart", "result", "resume", "run"].filter((key) => key in subject).sort()
    )
    expect("sealStep" in subject).toBe(false)
    expect("splice" in subject).toBe(false)
    expect("suspend" in subject).toBe(false)
    expect(HarnessEngineLike.EngineLike.key).toBe("/harness/EngineLike")
    expect(EngineSubject.EngineSubject.key).toBe("flows/testing/EngineSubject")
  })

  it.effect("fails every unavailable operation with a typed, stable-coded error", () =>
    Effect.gen(function*() {
      const subject = EngineSubject.makeNoop()
      const exit = yield* Effect.exit(subject.result("nope"))
      expect(exit._tag).toBe("Failure")
      const error = yield* Effect.flip(subject.result("nope"))
      expect(error._tag).toBe("EngineUnavailableError")
      expect(error.code).toBe("engine_unavailable")
    }))

  it("carries every subject failure in one closed typed union", () => {
    const errors: ReadonlyArray<TestingError.EngineSubjectError> = [
      new TestingError.EngineUnavailableError({ message: "no subject" }),
      new TestingError.CapabilityOperationError({ capability: "rewind", operation: "rewind", message: "no subject" }),
      new TestingError.TransactionCommitError({ boundary: "frame" }),
      new TestingError.RewindFailureError({ executionId: "e1", frame: 1, boundary: "resume" })
    ]
    expect(errors.map((error) => error.code)).toEqual([
      "engine_unavailable",
      "capability_operation_failed",
      "transaction_commit_failed",
      "rewind_failed"
    ])
  })
})
