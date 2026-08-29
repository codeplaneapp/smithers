import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/37-host-containment.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-containment-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("reaps the process group a killed host left running", async () => {
  const summary = await Effect.runPromise(main(join(directory, "containment", "host.sqlite")))

  // The killed host really did leave a live process group behind: without that
  // the reaping below would be a statement about nothing.
  expect(summary.orphaned).toBe(true)
  expect(summary.survivedTheReaper).toBe(false)
  // Recorded by the dead host, retired by the live one, both on the journal run
  // named after the host they share.
  expect(summary.hostEvents).toEqual([
    "flows.host.process-spawned.v1",
    "flows.host.process-reaped.v1"
  ])
}, 120_000)
