import * as TestHost from "@smthrs/kernel/test/TestHost"
import { Effect } from "effect"
import { describe, it } from "vitest"
import * as HostSuite from "../../src/HostSuite.ts"

const profile: HostSuite.HostProfile = {
  fileSystem: { supported: true },
  path: { supported: true },
  shell: { supported: true },
  jj: { supported: false, code: "not_installed" },
  httpTransport: { supported: false, code: "TransportError" },
  clock: { supported: true },
  random: { supported: true }
}

describe("TestHost HostSuite", () => {
  for (const testCase of HostSuite.hostSuite(TestHost.TestHost, profile)) {
    it(testCase.name, () => Effect.runPromise(testCase.run))
  }
})
