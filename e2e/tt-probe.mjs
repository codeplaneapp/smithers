import * as Effect from "effect/Effect"
const { makeWorkspace, layer, Ledger } = await import("/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/wt/e2e-tooling/e2e/harness/timeTravelRun.ts")
const ws = makeWorkspace("probe")
ws.enter()
const exit = await Effect.runPromise(
  Effect.exit(Effect.scoped(Effect.provide(Ledger.execute({ entry: "posted" }, { executionId: "probe-1" }), layer(ws.root, ws.filename, "probe-host"))))
)
console.log(JSON.stringify(exit, null, 1).slice(0, 4000))
const Cause = await import("effect/Cause")
const d = Cause.squash(exit.cause)
console.log("typeof:", typeof d, "ctor:", d?.constructor?.name)
console.log("own:", Object.getOwnPropertyNames(d))
console.log("str:", String(d))
console.log("stack:", d?.stack?.split("\n").slice(0,12).join("\n"))
