/**
 * The unsupported half of the host suite, and the scratch file the supported
 * half owns.
 *
 * Only the all-supported profile ran, so the branch that asserts an
 * unsupported capability fails with its declared stable code -- the branch the
 * whole "tickets, not exceptions" rule rests on -- never executed, and neither
 * did the mismatched-code report.
 */
import * as TestHost from "@smthrs/kernel/test/TestHost"
import { Effect, FileSystem } from "effect"
import { describe, expect, it } from "vitest"
import * as HostSuite from "../../src/HostSuite.ts"

/** Every capability declared unsupported, with the code TestHost really raises. */
const declaredUnsupported: HostSuite.HostProfile = {
  fileSystem: { supported: false, code: "NotFound" },
  path: { supported: false, code: "BadArgument" },
  shell: { supported: false, code: "spawn_denied" },
  jj: { supported: false, code: "not_installed" },
  httpTransport: { supported: false, code: "TransportError" },
  clock: { supported: false, code: "capability_contract_violation" },
  random: { supported: false, code: "capability_contract_violation" }
}

/** The same profile with every declared code wrong. */
const wrongCodes: HostSuite.HostProfile = {
  ...declaredUnsupported,
  fileSystem: { supported: false, code: "not-the-code-it-raises" },
  path: { supported: false, code: "not-the-code-it-raises" },
  jj: { supported: false, code: "not-the-code-it-raises" }
}

const byName = (profile: HostSuite.HostProfile) =>
  new Map(HostSuite.hostSuite(TestHost.TestHost, profile).map((suiteCase) => [suiteCase.name, suiteCase]))

const outcome = (suiteCase: HostSuite.HostSuiteCase): Promise<"passed" | HostSuite.HostSuiteError> =>
  Effect.runPromise(
    suiteCase.run.pipe(
      Effect.map(() => "passed" as const),
      Effect.catch((error: HostSuite.HostSuiteError) => Effect.succeed(error))
    )
  )

describe("a capability declared unsupported must fail with its declared code", () => {
  const cases = byName(declaredUnsupported)

  // Clock and Random are deliberately absent: their unsupported branch runs
  // over the poisoned base, which raises a DEFECT, and `assertCapabilityError`
  // inspects the recoverable channel. A bundle that declares those unsupported
  // is a shape the suite cannot assert today, and inventing a passing
  // expectation for it here would claim coverage that does not exist.
  it.each([
    "FileSystem round-trips",
    "Jj has a declared capability result",
    "HttpTransport has a declared capability result"
  ])("%s", async (name) => {
    expect(await outcome(cases.get(name)!)).toBe("passed")
  })

  // TestHost really does normalize paths and really does spawn, so declaring
  // either unsupported is a wrong profile and the suite says so rather than
  // accepting the declaration.
  it.each([
    ["Path normalizes", "Path", "fromFileUrl"],
    ["Shell behavior is deterministic", "ChildProcessSpawner", "spawn"]
  ])("%s reports a capability the host actually has", async (name, capability, operation) => {
    expect(await outcome(cases.get(name)!)).toMatchObject({
      _tag: "CapabilityContractError",
      capability,
      operation
    })
  })

  it("reports the code it actually observed when the declaration is wrong", async () => {
    const observed = await outcome(byName(wrongCodes).get("Jj has a declared capability result")!)
    expect(observed).not.toBe("passed")
    expect(observed).toMatchObject({
      _tag: "CapabilityContractError",
      capability: "Jj",
      operation: "status",
      expectedCode: "not-the-code-it-raises"
    })
  })

  it("reports a file-system code that differs from the one the host raises", async () => {
    const observed = await outcome(byName(wrongCodes).get("FileSystem round-trips")!)
    expect(observed).toMatchObject({
      _tag: "CapabilityContractError",
      capability: "FileSystem",
      operation: "readFileString",
      expectedCode: "not-the-code-it-raises",
      actualCode: "NotFound"
    })
  })
})

describe("the file-system probe owns the scratch file it writes", () => {
  const supported: HostSuite.HostProfile = { ...declaredUnsupported, fileSystem: { supported: true } }

  it("refuses to write over a file it did not create, and leaves it alone", async () => {
    const scratchPath = "/host-suite/pre-existing.txt"
    const run = Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(scratchPath, "not the suite's")
      const suiteCase = HostSuite.hostSuite(TestHost.TestHost, {
        ...supported,
        fileSystemScratchPath: scratchPath
      })[0]!
      const exit = yield* Effect.exit(suiteCase.run)
      return { exit, survivor: yield* fs.readFileString(scratchPath) }
    }).pipe(Effect.provide(TestHost.TestHost))
    const { exit, survivor } = await Effect.runPromise(run)
    expect(exit._tag).toBe("Failure")
    expect(survivor).toBe("not the suite's")
  })

  it("defaults to an absolute path outside the caller's working directory", async () => {
    const suiteCase = HostSuite.hostSuite(TestHost.TestHost, supported)[0]!
    expect(await outcome(suiteCase)).toBe("passed")
    // Two suites over one bundle must not collide on a fixed name.
    const [first, second] = await Promise.all([
      outcome(HostSuite.hostSuite(TestHost.TestHost, supported)[0]!),
      outcome(HostSuite.hostSuite(TestHost.TestHost, supported)[0]!)
    ])
    expect([first, second]).toEqual(["passed", "passed"])
  })
})
