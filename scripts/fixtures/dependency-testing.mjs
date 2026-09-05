/** Executed by the installed Vitest selected for create-app/testing. */
import { expect, test } from "vitest"
import { cachedModelTest, replayModelError, runCachedModelTest } from "@smthrs/create-app/testing"
import * as ScoreGate from "@smthrs/testing/ScoreGate"
import { ScoreGateError } from "@smthrs/testing/TestingError"

test("create-app's selected testing adapter loads its grading facade and preserves replay failures", () => {
  expect(typeof cachedModelTest).toBe("function")
  expect(typeof runCachedModelTest).toBe("function")
  expect(typeof ScoreGateError).toBe("function")
  expect(typeof ScoreGate.expectScores).toBe("function")
  const failure = replayModelError({ code: "invalid_provider_output", message: "recorded failure" })
  expect(failure.code).toBe("invalid_provider_output")
  expect(failure.message).toBe("recorded failure")
})
