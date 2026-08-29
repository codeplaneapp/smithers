import { describe, expect, it } from "vitest"
import * as TestReport from "../src/internal/TestReport.ts"

describe("TestReport", () => {
  it("reads pytest's short summary and tally", () => {
    const output = [
      "============================= test session starts ==============================",
      "collected 43 items",
      "",
      "tests/test_widen.py::test_widens PASSED                                  [ 50%]",
      "tests/test_widen.py::test_narrows FAILED                                 [100%]",
      "",
      "=========================== short test summary info ============================",
      "FAILED tests/test_widen.py::test_narrows - AssertionError: 3 != 4",
      "ERROR tests/test_other.py::test_imports",
      "========================= 1 failed, 41 passed in 1.20s =========================="
    ].join("\n")
    expect(TestReport.parse(output)).toEqual({
      passed: 41,
      failed: ["tests/test_widen.py::test_narrows", "tests/test_other.py::test_imports"],
      parsed: true
    })
  })

  it("reads a verbose pytest run whose tally was cut off", () => {
    const output = [
      "tests/test_a.py::test_one PASSED",
      "tests/test_a.py::test_two PASSED",
      "tests/test_a.py::test_three FAILED"
    ].join("\n")
    expect(TestReport.parse(output)).toEqual({
      passed: 2,
      failed: ["tests/test_a.py::test_three"],
      parsed: true
    })
  })

  it("reads unittest, whose ids are the other way round", () => {
    const output = [
      "test_widens (tests.test_widen.WidenTests) ... ok",
      "test_narrows (tests.test_widen.WidenTests) ... FAIL",
      "======================================================================",
      "FAIL: test_narrows (tests.test_widen.WidenTests)",
      "----------------------------------------------------------------------",
      "Ran 2 tests in 0.003s",
      "",
      "FAILED (failures=1)"
    ].join("\n")
    expect(TestReport.parse(output)).toEqual({
      passed: 1,
      failed: ["tests.test_widen.WidenTests.test_narrows"],
      parsed: true
    })
  })

  it("reads TAP", () => {
    const output = ["TAP version 13", "1..2", "ok 1 - widens", "not ok 2 - narrows"].join("\n")
    expect(TestReport.parse(output)).toEqual({ passed: 1, failed: ["narrows"], parsed: true })
  })

  it("says plainly when it recognised nothing", () => {
    // A wrong failure set is worse than none: attribution is built on it.
    expect(TestReport.parse("Segmentation fault (core dumped)\n")).toEqual({
      passed: 0,
      failed: [],
      parsed: false
    })
    expect(TestReport.parse("")).toEqual({ passed: 0, failed: [], parsed: false })
  })

  it("differences two runs into the three sets attribution needs", () => {
    expect(TestReport.attribute(["a", "b"], ["b", "c"])).toEqual({
      introduced: ["a"],
      preexisting: ["b"],
      fixed: ["c"]
    })
  })
})
