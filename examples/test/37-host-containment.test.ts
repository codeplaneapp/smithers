import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/37-host-containment.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-containment-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("reaps the process group a killed host left running", async () => {
  const summary = await Effect.runPromise(main(join(directory, "containment", "host.sqlite")))

  // The killed host really did leave a live process group behind: without that
  // the reaping below would be a statement about nothing.
  expect(summary).toHaveProperty("hostStderr", "")
  expect(summary.orphaned).toBe(true)
  expect(summary.survivedTheReaper).toBe(false)
  // Recorded by the dead host, retired by the live one, both on the journal run
  // named after the host they share.
  expect(summary.hostEvents).toEqual([
    "flows.host.process-spawned.v1",
    "flows.host.process-reaped.v1"
  ])
}, 120_000)

it("reports a host startup failure on stderr and exits unsuccessfully", () => {
  const binary = join(directory, "unsupported-jj")
  writeFileSync(binary, "#!/bin/sh\necho \"jj 0.38.0\"\n", { mode: 0o755 })
  const child = spawnSync(process.execPath, [
    new URL("../src/37-host-containment-host.ts", import.meta.url).pathname,
    join(directory, "failure.sqlite"),
    "failed-host"
  ], {
    env: { ...process.env, SMITHERS_JJ_PATH: binary },
    encoding: "utf8",
    timeout: 30_000
  })
  expect(child.error).toBeUndefined()
  expect(child.signal).toBeNull()
  expect(child.status).toBe(1)
  expect(child.stdout).toBe("")
  expect(child.stderr).toContain("jj requires version 0.39.0 or newer; found jj 0.38.0")
})
