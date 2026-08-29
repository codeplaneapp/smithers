/**
 * Runs `worker.ts` inside real workerd.
 *
 * Everything else in this package proves the driver against a `node:sqlite`
 * fake. Only workerd can prove the platform claims the driver is built on, so
 * this suite exists to be run deliberately — see `README.md` in this
 * directory.
 *
 * It is skipped unless `FLOWS_WORKERD_BIN` names a workerd binary. workerd
 * ships as a platform-specific optional package and is not a dependency of
 * `@smthrs/database`, so there is nothing to resolve and nothing to install on
 * a machine that only wants the ordinary suite; CI keeps the variable unset
 * and this file costs one skipped describe block.
 */
import { build } from "esbuild"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { CheckResult } from "./worker.ts"

const binary = process.env["FLOWS_WORKERD_BIN"]
/** Fixed rather than searched: a failure to bind must fail, not pick a peer. */
const port = Number(process.env["FLOWS_WORKERD_PORT"] ?? 8787)

/**
 * workerd embeds the bundle by path relative to the config file, so the two
 * are written into one temp directory. `enableSql` is what makes the namespace
 * SQLite-backed; without it `ctx.storage.sql` does not exist.
 */
const config = `
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [ (name = "main", worker = .mainWorker) ],
  sockets = [ (name = "http", address = "*:${port}", http = (), service = "main") ]
);

const mainWorker :Workerd.Worker = (
  modules = [ (name = "worker.js", esModule = embed "worker.js") ],
  durableObjectNamespaces = [
    (className = "ContractObject", uniqueKey = "flows-database-contract", enableSql = true)
  ],
  durableObjectStorage = (inMemory = void),
  bindings = [ (name = "CONTRACT", durableObjectNamespace = "ContractObject") ],
  compatibilityDate = "2026-07-01"
);
`

const suite = binary === undefined ? describe.skip : describe

suite("DurableObjectDatabase inside workerd", () => {
  let directory: string
  let child: ChildProcess
  let results: ReadonlyArray<CheckResult>

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "flows-database-workerd-"))
    await build({
      entryPoints: [join(import.meta.dirname, "worker.ts")],
      outfile: join(directory, "worker.js"),
      bundle: true,
      format: "esm",
      target: "es2022",
      // workerd provides the web platform, not Node's, so the bundle must not
      // reach for a Node builtin. An import that survives here is a real
      // portability defect in the driver, and esbuild fails the build on it.
      platform: "neutral",
      conditions: ["workerd", "worker", "browser", "import"]
    })
    writeFileSync(join(directory, "config.capnp"), config)

    child = spawn(binary!, ["serve", "config.capnp"], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] })
    const stderr: Array<string> = []
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()))

    // workerd binds its socket before it is ready to serve; poll rather than
    // sleep so a fast start is not paid for and a slow one still succeeds.
    const deadline = Date.now() + 30_000
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`workerd exited with ${child.exitCode}: ${stderr.join("")}`)
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`)
        results = await response.json() as ReadonlyArray<CheckResult>
        return
      } catch (cause) {
        if (Date.now() > deadline) {
          throw new Error(`workerd never answered: ${String(cause)}\n${stderr.join("")}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }, 90_000)

  afterAll(() => {
    child?.kill("SIGKILL")
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("reports every platform check", () => {
    // Each result carries its name, so a failure reports which platform
    // assumption broke; the count catches a worker that ran fewer checks.
    expect(results.length).toBe(7)
    expect(results.filter((result) => !result.ok)).toEqual([])
  })
})
