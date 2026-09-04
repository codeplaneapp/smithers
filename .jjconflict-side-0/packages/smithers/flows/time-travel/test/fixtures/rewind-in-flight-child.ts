import * as Effect from "effect/Effect"
import { parkSealedFlow, runRealEngine } from "../RealTimeTravelHarness.ts"

const [databaseFile, runId, hostId] = process.argv.slice(2)
if (databaseFile === undefined || runId === undefined || hostId === undefined) {
  throw new Error("usage: rewind-in-flight-child.ts <database-file> <run-id> <host-id>")
}

const inFlight = Effect.sync(() => {
  process.stdout.write(`${JSON.stringify({ status: "in-flight" })}\n`)
}).pipe(Effect.andThen(Effect.never))

// A process entrypoint: running the Effect here is the intended boundary.
await Effect.runPromise(runRealEngine(databaseFile, hostId, parkSealedFlow(runId, inFlight)))

// The parent always SIGKILLs this process after observing a durable heartbeat.
process.exitCode = 2
