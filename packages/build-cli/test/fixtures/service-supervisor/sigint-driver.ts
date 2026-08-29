// SIGINT teardown proof driver.
//
// Starts a supervisor, acquires the fixture server as a service, prints
// "READY <server pid>", then idles. The test sends this process SIGINT; the
// supervisor's backstop must SIGKILL the service's process group and re-raise,
// leaving no orphan (verified with pgrep in the test).
//
// Run with: node --import tsx sigint-driver.ts <port> <path-to-server.mjs>
import * as Effect from "effect/Effect"
import * as ServiceSupervisor from "../../../src/ServiceSupervisor.ts"

const port = Number(process.argv[2])
const serverPath = process.argv[3]
if (!Number.isInteger(port) || typeof serverPath !== "string") {
  console.error("usage: sigint-driver.ts <port> <server.mjs>")
  process.exit(2)
}

const program = Effect.scoped(Effect.gen(function*() {
  const supervisor = yield* ServiceSupervisor.make
  const handle = yield* supervisor.acquire({
    key: "//fixtures:sigint-proof",
    cwd: process.cwd(),
    argv: [
      process.execPath,
      serverPath,
      "--port",
      String(port),
      "--marker",
      "service-supervisor-sigint-proof"
    ],
    readiness: { port }
  })
  console.log(`READY ${handle.pid}`)
  yield* Effect.sleep(600_000)
}))

Effect.runPromise(program).catch((error) => {
  console.error(error)
  process.exit(1)
})
