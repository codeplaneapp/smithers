/**
 * Telling an invalid probe from a failing check.
 *
 * The cases fix one property: a classification is only made when the command
 * failed *about itself*. Every recogniser is exercised against output a real
 * runner prints, and the negative cases are the ones that matter more — a false
 * positive suppresses genuine regression evidence.
 */
import { describe, expect, it } from "vitest"
import * as Probe from "../src/Probe.ts"

const failing = (text: string, exitCode = 1) => Probe.classify({ exitCode, stdout: "", stderr: text })

describe("Probe.classify", () => {
  it("never classifies a command that exited zero, whatever it printed", () => {
    expect(
      Probe.classify({
        exitCode: 0,
        stdout: "unittest.loader._FailedTest",
        stderr: "ModuleNotFoundError: No module named 'nope'"
      })
    ).toBeUndefined()
  })

  it("reads unittest's synthesised placeholder as a test that does not exist", () => {
    const probe = failing(
      "ERROR: test_missing (unittest.loader._FailedTest.test_missing)\nAttributeError: module has none"
    )
    expect(probe?.reason).toBe("unknown-test")
  })

  it("reads a missing test method on a real class as a test that does not exist", () => {
    // The django wave-3 case, verbatim: exit 1, and nothing about the tree.
    const probe = failing(
      "AttributeError: type object 'AdminViewBasicTest' has no attribute 'test_catch_all_view_append_slash'"
    )
    expect(probe).toMatchObject({ reason: "unknown-test" })
    expect(probe?.evidence).toContain("test_catch_all_view_append_slash")
  })

  it("reads pytest's unresolvable node id as a test that does not exist", () => {
    expect(failing("ERROR: not found: /repo/tests/test_admin.py::test_nope")?.reason).toBe("unknown-test")
  })

  it("reads pytest's missing collection root as a path that does not exist", () => {
    expect(failing("ERROR: file or directory not found: tests/test_absent.py")?.reason).toBe("unknown-path")
  })

  it("reads a python interpreter that could not open its script as a path that does not exist", () => {
    expect(failing("python: can't open file '/repo/repro.py': [Errno 2] No such file or directory")?.reason).toBe(
      "unknown-path"
    )
  })

  it("reads both import errors as a module that does not exist", () => {
    expect(failing("ModuleNotFoundError: No module named 'django.contrib.nope'")?.reason).toBe("unknown-module")
    expect(failing("ImportError: No module named tests.helpers")?.reason).toBe("unknown-module")
  })

  it("reads a runner's unknown environment as an environment that does not exist", () => {
    expect(failing("ERROR: unknown environment 'py313'")?.reason).toBe("unknown-environment")
  })

  it("reads both shells' phrasing as a program that does not exist", () => {
    expect(failing("bash: line 1: pytest: command not found", 127)?.reason).toBe("unknown-command")
    expect(failing("sh: 1: pytest: not found", 127)?.reason).toBe("unknown-command")
  })

  it("falls back to the POSIX exit codes when the shell printed nothing recognisable", () => {
    // 127 is "not found" and 126 is "found and not executable"; no test runner
    // reaches its own tests and then reports either.
    expect(Probe.classify({ exitCode: 127, stdout: "", stderr: "" })).toMatchObject({
      reason: "unknown-command",
      evidence: "the command exited 127"
    })
    expect(Probe.classify({ exitCode: 126, stdout: "", stderr: "" })?.reason).toBe("unknown-command")
  })

  it("leaves an ordinary failing check alone", () => {
    const output = [
      "FAILED tests/test_admin.py::AdminViewBasicTest::test_catch_all_view - AssertionError",
      "assert 301 == 404",
      "1 failed, 412 passed in 3.20s"
    ].join("\n")
    expect(Probe.classify({ exitCode: 1, stdout: output, stderr: "" })).toBeUndefined()
  })

  it("leaves an attribute error about anything but a test alone", () => {
    expect(failing("AttributeError: 'Model' object has no attribute 'related_name'")).toBeUndefined()
  })

  it("leaves an ordinary missing file alone", () => {
    // The phrase on its own is what half of every failing suite prints; only
    // the runner's own load-time wording is evidence.
    expect(failing("OSError: [Errno 2] No such file or directory: '/tmp/fixture'")).toBeUndefined()
  })

  it("classifies from stdout as readily as from stderr, and from both together", () => {
    expect(Probe.classify({ exitCode: 1, stdout: "ERROR: not found: t.py::x", stderr: "" })?.reason).toBe(
      "unknown-test"
    )
    expect(
      Probe.classify({ exitCode: 1, stdout: "collecting …", stderr: "ERROR: not found: t.py::x" })?.reason
    ).toBe("unknown-test")
  })

  it("quotes the whole matched line as evidence and clips a long one", () => {
    const probe = Probe.classify({
      exitCode: 1,
      stdout: "collected 0 items\nERROR: not found: tests/test_admin.py::nope\n1 error",
      stderr: ""
    })
    expect(probe?.evidence).toBe("ERROR: not found: tests/test_admin.py::nope")

    const long = Probe.classify({
      exitCode: 1,
      stdout: `ERROR: not found: ${"x".repeat(600)}`,
      stderr: ""
    })
    expect(long?.evidence).toHaveLength(240)
    expect(long?.evidence.endsWith("…")).toBe(true)
  })

  it("states what the failure does and does not prove, in the result itself", () => {
    const probe = failing("ERROR: not found: t.py::x")
    expect(probe?.message).toContain("never ran a check")
    expect(probe?.message).toContain("not a reproduction")
  })

  it("names the reserved output key flows report under", () => {
    expect(Probe.key).toBe("invalidProbe")
  })
})

describe("Probe.classify against a genuine failure that prints refusal wording", () => {
  // The failure mode that would make this module worse than nothing: the bug
  // under test is itself an import error, or a test asserts on a shell message,
  // so a real reproduction carries the exact phrase a refusal carries. Reading
  // one as an invalid probe tells the agent its reproduction proved nothing.
  it("leaves an import error raised inside a test that ran alone", () => {
    const probe = Probe.classify({
      exitCode: 1,
      stdout: [
        "collected 3 items",
        "",
        "=================================== FAILURES ===================================",
        "    def test_lazy_import():",
        ">       load_backend('sqlite3')",
        "E   ModuleNotFoundError: No module named 'app.backends.sqlite3'",
        "========================= 1 failed, 2 passed in 0.41s =========================="
      ].join("\n"),
      stderr: ""
    })
    expect(probe).toBeUndefined()
  })

  it("leaves an import error raised inside a unittest case that ran alone", () => {
    expect(
      failing(
        [
          ".....E",
          "ERROR: test_optional_dep (tests.test_compat.CompatTests.test_optional_dep)",
          "Traceback (most recent call last):",
          "    from app.compat import pytz_shim",
          "ImportError: No module named pytz",
          "----------------------------------------------------------------------",
          "Ran 6 tests in 0.013s",
          "",
          "FAILED (errors=1)"
        ].join("\n")
      )
    ).toBeUndefined()
  })

  it("leaves a test that asserts on a shell's own not-found message alone", () => {
    expect(
      failing(
        [
          "E   AssertionError: assert 'sh: nope: command not found' == 'sh: nope: not executable'",
          "========================= 1 failed, 40 passed in 2.10s ========================="
        ].join("\n")
      )
    ).toBeUndefined()
  })

  it("leaves a missing attribute that only starts with the word test alone", () => {
    // `testing`, `tests` and `tested` are ordinary attribute names, and their
    // absence is an ordinary bug. Only `test_foo` and the older `testFoo` are
    // shaped like the test method a runner was asked to find.
    expect(failing("AttributeError: type object 'Settings' has no attribute 'testing'")).toBeUndefined()
    expect(failing("AttributeError: module 'app.conf' has no attribute 'tests'")).toBeUndefined()
    expect(failing("AttributeError: type object 'Case' has no attribute 'testFoo'")?.reason).toBe("unknown-test")
  })

  it("still classifies when the runner reported that it ran nothing", () => {
    // A collection error tallies `error`, never `passed` or `failed`, so the
    // veto does not fire and the load-time wording is still read.
    expect(
      Probe.classify({
        exitCode: 2,
        stdout: "collected 0 items / 1 error\nE   ModuleNotFoundError: No module named 'django'\n1 error in 0.12s",
        stderr: ""
      })?.reason
    ).toBe("unknown-module")
    // A tally of zero is a tally of nothing, and proves nothing ran.
    expect(failing("Ran 0 tests in 0.000s\nModuleNotFoundError: No module named 'tests.helpers'")?.reason).toBe(
      "unknown-module"
    )
    expect(failing("0 passed in 0.01s\nERROR: not found: t.py::x")?.reason).toBe("unknown-test")
  })

  it("reads both shells' word order, and only as a whole line", () => {
    expect(failing("bash: line 1: pytest: command not found", 127)?.reason).toBe("unknown-command")
    expect(failing("zsh: command not found: pytest", 127)?.reason).toBe("unknown-command")
    expect(failing("stdout captured: 'x: command not found' was expected here")).toBeUndefined()
  })

  it("lets the shell's reserved exit codes speak even when tests ran", () => {
    // 126 and 127 are the shell's verdict on the command it was handed. A
    // compound command whose check passed and whose next program is missing
    // still ran a broken invocation, and nothing in the tally contradicts the
    // shell.
    expect(
      Probe.classify({ exitCode: 127, stdout: "412 passed in 3.20s", stderr: "flake9: command not found" })?.reason
    ).toBe("unknown-command")
  })
})
