/**
 * Starts the worker under workerd and asserts one cell ran inside it.
 *
 * Run it directly with `node smoke.mjs`, or through vitest by setting
 * `FLOWS_WORKERD_SMOKE=1`. Either way it needs `npm install` in this directory
 * first, because wrangler ships the workerd binary and this project is not a
 * pnpm workspace member.
 *
 * The assertion is the whole point: workerd refuses `WebAssembly.compile` over
 * bytes, so a `complete` transition here can only have come from the module the
 * toolchain compiled and the worker named.
 */
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"

const port = Number(process.env.FLOWS_WORKERD_PORT ?? 8799)
const startupMs = Number(process.env.FLOWS_WORKERD_STARTUP_MS ?? 120_000)
const expected = "README.md"

const directory = new URL(".", import.meta.url)

// Said here rather than left to npx, whose "command not found" does not name
// the one command that fixes it.
if (!existsSync(new URL("node_modules/wrangler", directory))) {
  process.stderr.write("wrangler is not installed. Run `npm install` in packages/harness/test/workerd first.\n")
  process.exit(1)
}

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["--no-install", "wrangler", "dev", "--ip", "127.0.0.1", "--port", String(port)],
  {
    cwd: directory,
    // `CI` is what turns off wrangler's interactive dev session, which would
    // otherwise hold the terminal and never exit under a test runner.
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  }
)

let log = ""
child.stdout.on("data", (chunk) => {
  log += chunk
})
child.stderr.on("data", (chunk) => {
  log += chunk
})

let exited
child.on("exit", (code) => {
  exited = code ?? 1
})

const stop = async () => {
  if (exited === undefined) {
    child.kill("SIGTERM")
    await delay(200)
    if (exited === undefined) child.kill("SIGKILL")
  }
}

const fail = async (message) => {
  await stop()
  process.stderr.write(`${message}\n\nwrangler output:\n${log}\n`)
  process.exit(1)
}

/** Polls until the worker answers, because wrangler reports ready before it is. */
const answer = async () => {
  const deadline = Date.now() + startupMs
  while (Date.now() < deadline) {
    if (exited !== undefined) return undefined
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      return { status: response.status, body: await response.text() }
    } catch {
      await delay(250)
    }
  }
  return undefined
}

const result = await answer()
if (result === undefined) {
  await fail(
    exited === undefined
      ? `The worker did not answer within ${startupMs} ms.`
      : `wrangler exited with code ${exited} before the worker answered.`
  )
}

if (result.status !== 200) await fail(`The worker answered ${result.status}: ${result.body}`)
if (!result.body.includes(expected)) {
  await fail(`The cell did not complete inside workerd. The worker answered: ${result.body}`)
}

await stop()
process.stdout.write(`workerd smoke passed: ${result.body}\n`)
