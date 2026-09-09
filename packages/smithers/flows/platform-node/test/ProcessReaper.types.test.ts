/**
 * Pins the relationship `Reaped` documents between `killed` and `refusal`.
 *
 * The sweep report is this package's public account of what it did to another
 * incarnation's processes, so a caller has to be able to read the reason off a
 * kept record without a second check, and must not be able to publish a killed
 * record naming a reason it never had. Both halves are type level; the runtime
 * objects `reap` returns are unchanged and asserted below.
 */
import type { ProcessLedger } from "@smthrs/kernel"
import { expect, expectTypeOf, it } from "vitest"
import type * as ProcessReaper from "../src/ProcessReaper.ts"

const record: ProcessLedger.ProcessRecord = {
  pid: 900011,
  pgid: 900011,
  hostId: "types",
  ownerPid: 900012,
  startedAtMs: 0,
  commandDigest: "types"
}

// A kept record without a reason is not a decision anyone can act on.
// @ts-expect-error `killed: false` requires the `Refusal` that produced it.
const missingReason: ProcessReaper.Reaped = { record, killed: false }

// Nothing refused the kill, so there is no reason to report.
// @ts-expect-error `killed: true` cannot carry a `Refusal`.
const killedWithReason: ProcessReaper.Reaped = { record, killed: true, refusal: "kill-failed" }

const killed: ProcessReaper.Reaped = { record, killed: true }
const kept: ProcessReaper.Reaped = { record, killed: false, refusal: "owner-alive" }

/** The narrowing a caller writes: one check, and the reason is there to read. */
const reasonOf = (entry: ProcessReaper.Reaped): ProcessReaper.Refusal | "none" => {
  if (entry.killed) {
    expectTypeOf(entry.refusal).toEqualTypeOf<undefined>()
    return "none"
  }
  expectTypeOf(entry.refusal).toEqualTypeOf<ProcessReaper.Refusal>()
  return entry.refusal
}

it("narrows the refusal off `killed` and leaves the runtime shapes alone", () => {
  expect(reasonOf(killed)).toBe("none")
  expect(reasonOf(kept)).toBe("owner-alive")
  // A killed entry omits the key entirely, which is the shape `reap` returns
  // and the shape the ledger events were already written from.
  expect(Object.hasOwn(killed, "refusal")).toBe(false)
  expect(missingReason.killed).toBe(false)
  expect(killedWithReason.killed).toBe(true)
})
