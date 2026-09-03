/**
 * The workerd smoke, driven from the suite when a host opts in.
 *
 * It is off by default because it is not a unit test: it starts wrangler, which
 * downloads and runs the workerd binary, and it needs `npm install` in
 * `test/workerd` first. Neither belongs in the default run. Set
 * `FLOWS_WORKERD_SMOKE=1` to include it, and see `README.md` for the two
 * commands.
 *
 * What it proves is the one thing no Node test can: workerd refuses
 * `WebAssembly.compile` over bytes, so a cell that completes inside it ran
 * against a module the toolchain compiled and the host named through
 * `QuickJSSandbox.Variant`.
 */
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const run = promisify(execFile)

const directory = fileURLToPath(new URL("./workerd", import.meta.url))

describe.skipIf(process.env.FLOWS_WORKERD_SMOKE !== "1")("workerd smoke", () => {
  it("runs a cell inside workerd against the build the host named", async () => {
    const { stdout } = await run(process.execPath, ["smoke.mjs"], {
      cwd: directory,
      timeout: 180_000
    })

    expect(stdout).toContain("workerd smoke passed")
    expect(stdout).toContain("complete")
  }, 180_000)
})
