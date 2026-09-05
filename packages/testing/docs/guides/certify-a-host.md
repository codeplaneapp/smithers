---
title: "Certify a host bundle"
description: "Declare a host profile for the seven closed-list capabilities, run the shared Host conformance suite against your bundle, and report an unsupported capability as a declared code rather than an accident."
sidebar:
  order: 6
---

A Host bundle is the layer set a flow's side effects run through: a filesystem,
a path service, a shell, `Jj`, an HTTP client, a clock, and randomness.
`HostSuite.hostSuite` runs one shared suite against any complete bundle.

## Declare the profile

Every capability in the closed list must be declared. Omission is not an
admission mechanism, and the profile is where a bundle says what it does not
implement:

```ts
import type { HostSuite } from "@smthrs/testing"

const profile: HostSuite.HostProfile = {
  fileSystem: { supported: true },
  path: { supported: true },
  shell: { supported: true },
  jj: { supported: false, code: "not_installed" },
  httpTransport: { supported: false, code: "TransportError" },
  clock: { supported: true },
  random: { supported: true }
}
```

`code` is the stable code the suite expects from the named operation when a
capability is unsupported. The suite asserts that exact code, and a wrong one
is reported through the typed `expectedCode` and `actualCode` fields of
`CapabilityContractError` rather than encoded into a message.

## Run the suite

Each case is a value with a `name` and a `run`, so registration is a loop:

```ts
import { HostSuite } from "@smthrs/testing"
import * as TestHost from "@smthrs/testing/TestHost"
import { Effect } from "effect"
import { describe, it } from "vitest"

describe("TestHost host suite", () => {
  for (const testCase of HostSuite.hostSuite(TestHost.TestHost, profile)) {
    it(testCase.name, () => Effect.runPromise(testCase.run))
  }
})
```

The eight cases are `FileSystem round-trips`, `Path normalizes`,
`Shell behavior is deterministic`, `Jj has a declared capability result`,
`HttpTransport has a declared capability result`, `Clock is monotonic`,
`Random produces a valid value`, and
`Scoped resources clean up on fiber interruption`.

Because the cases are plain values, this suite needs no adapter from this
package. Plain `vitest` is enough.

## Probe HTTP explicitly

HTTP is the one supported capability that requires a target, so the shared
suite never invents a live network call:

```ts
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

const httpTransport = {
  supported: true,
  request: HttpClientRequest.get("http://127.0.0.1:8787/health"),
  expectedStatus: 200
} as const
```

## Where the scratch file goes

The filesystem case writes a scratch file, reads it back, and removes it. The
suite owns that file completely: it refuses a path that already exists, and it
removes only the file it created.

With no `fileSystemScratchPath` declared, the suite builds a unique absolute
path under `/tmp` from the bundle's own `Path` and `Random`. Declare one when
the bundle's platform has no `/tmp`:

```ts
const profileWithScratch = { ...profile, fileSystemScratchPath: "/var/tmp/host-suite-probe.txt" }
```

The default is absolute and unique for two reasons. A relative name resolves
against the caller's working directory, so a real host bundle would write into,
and force-delete from, your working tree. A fixed name makes two suites running
in one directory race on one file.

## Clock and randomness are checked behaviorally

`Clock` and `Random` are `Context.Reference`s with ambient defaults, so they
cannot appear in a bundle's output type and the compiler cannot demand them.
The suite runs those two cases over a poisoned base instead, so a bundle that
supplies neither fails loudly rather than silently using the Effect defaults.

## What the error channel carries

`HostSuite.HostSuiteError` is the typed contract violation plus the incidental
host failures a supported capability's own probe can produce: a
`PlatformError` from the scratch write, a `JjFailure` from a jj command, an
`HttpClientError` from the probe request.

The channel names that closed union rather than widening to `unknown`, so a
runner can tell "this host violates the contract" from "the scratch write
failed because the disk is full".

## Related

- [Conformance suites](../concepts/conformance.md): why an unsupported
  capability is a declared outcome.
- `@smthrs/testing/TestHost` is the deterministic bundle this suite is
  developed against; the kernel supplies the contract it certifies.
