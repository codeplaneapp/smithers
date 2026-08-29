import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import * as Author from "../src/Author.ts"
import * as Chain from "../src/Chain.ts"
import type * as Event from "../src/Event.ts"
import * as ScriptRunner from "../src/ScriptRunner.ts"
import { countingEntry, failChain, failingEntry, flow, runChain } from "./harness.ts"

const grepResult = { files: ["a.ts", "b.ts", "c.ts", "d.ts"] }

const l1 = [
  "Plan: search, compute on the hits, hand off.",
  flow(
    `const hits = await ctx.call("grep", { pattern: "TODO" })`,
    `const top = hits.files.slice(0, 3)`,
    `const s = await ctx.call("author", { context: [top.join("\\n")] })`,
    `return to(s)`
  )
].join("\n")

const l2 = flow(`await ctx.call("edit", { file: "a.ts" })`, `return done({ patched: true })`)

const doneScript = flow(`return done("recovered")`)

const goldenTags = [
  "ChainStarted",
  "CallSettled",
  "LinkAuthored",
  "LinkEnded",
  "CallSettled",
  "CallSettled",
  "LinkAuthored",
  "LinkEnded",
  "CallSettled",
  "LinkEnded"
]

const goldenRun = async () => {
  const grep = countingEntry("grep", grepResult)
  const edit = countingEntry("edit", { ok: true })
  const result = await runChain({
    author: Author.layerMock([l1, l2]),
    entries: [grep.entry, edit.entry]
  })
  return { edit, grep, ...result }
}

describe("Chain", () => {
  it("runs a two-link chain to done with the golden journal", async () => {
    const { edit, events, grep, outcome } = await goldenRun()
    expect(outcome).toEqual({ _tag: "Done", value: { patched: true } })
    expect(events.map((event) => event._tag)).toEqual(goldenTags)
    expect(grep.count()).toBe(1)
    expect(edit.count()).toBe(1)

    const bootstrapCall = events[1] as Event.CallSettled
    expect(bootstrapCall.name).toBe("author")
    expect(bootstrapCall.key).toEqual({
      entryDigest: Chain.authorDigest,
      link: 0,
      ordinal: 0,
      scriptDigest: ""
    })
    expect(bootstrapCall.payload).toEqual({ context: ["fix TODOs"] })

    const l1Script = (events[2] as Event.LinkAuthored).script
    const grepCall = events[4] as Event.CallSettled
    expect(grepCall.name).toBe("grep")
    expect(grepCall.key.link).toBe(1)
    expect(grepCall.key.ordinal).toBe(0)
    expect(grepCall.key.scriptDigest).toBe(l1Script.digest)

    // The script computed on real values: its author call carries them.
    const handoffCall = events[5] as Event.CallSettled
    expect(handoffCall.name).toBe("author")
    expect(handoffCall.key.ordinal).toBe(1)
    expect(handoffCall.payload).toEqual({ context: ["a.ts\nb.ts\nc.ts"] })

    const ended = events[9] as Event.LinkEnded
    expect(ended.link).toBe(2)
    expect(ended.outcome._tag).toBe("Done")
  })

  it("replays a finished chain with zero model calls and zero effects", async () => {
    const { events } = await goldenRun()
    const grep = countingEntry("grep", grepResult)
    const edit = countingEntry("edit", { ok: true })
    const replay = await runChain({
      author: Author.layerMock([]),
      entries: [grep.entry, edit.entry],
      initial: events,
      runner: ScriptRunner.layerNoop()
    })
    expect(replay.outcome).toEqual({ _tag: "Done", value: { patched: true } })
    expect(replay.events).toEqual(events)
    expect(grep.count()).toBe(0)
    expect(edit.count()).toBe(0)
  })

  it.each([
    ["goal", { goal: "a different goal" }],
    ["envelope", { envelope: { workspace: "different" } }]
  ])("refuses to resume a finished chain under a different %s", async (_label, changed) => {
    const { events } = await goldenRun()
    const error = await failChain({
      author: Author.layerMock([]),
      initial: events,
      runner: ScriptRunner.layerNoop(),
      ...changed
    }) as Chain.ChainError
    expect(error.code).toBe("replay_divergence")
    expect(error.message).toContain("different goal or envelope")
  })

  it("resumes a crash after the first settled call without re-running it", async () => {
    const { events } = await goldenRun()
    const grep = countingEntry("grep", grepResult)
    const edit = countingEntry("edit", { ok: true })
    const resumed = await runChain({
      author: Author.layerMock([l2]),
      entries: [grep.entry, edit.entry],
      initial: events.slice(0, 5)
    })
    expect(resumed.outcome).toEqual({ _tag: "Done", value: { patched: true } })
    expect(grep.count()).toBe(0)
    expect(edit.count()).toBe(1)
    expect(resumed.events).toEqual(events)
  })

  it("resumes a crash between LinkAuthored and LinkEnded without duplicating either", async () => {
    const { events } = await goldenRun()
    const grep = countingEntry("grep", grepResult)
    const edit = countingEntry("edit", { ok: true })
    const resumed = await runChain({
      author: Author.layerMock([]),
      entries: [grep.entry, edit.entry],
      initial: events.slice(0, 7)
    })
    expect(resumed.outcome).toEqual({ _tag: "Done", value: { patched: true } })
    expect(grep.count()).toBe(0)
    expect(edit.count()).toBe(1)
    expect(resumed.events).toEqual(events)
  })

  it("journals a catalog rejection and shows it to the recovery author", async () => {
    const seen: Array<Author.Input> = []
    const bad = flow(`await ctx.call("missing", {})`, `return done(null)`)
    const author = Author.layerFn((input) => {
      seen.push(input)
      return seen.length === 1 ? bad : doneScript
    })
    const { events, outcome } = await runChain({ author })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })

    const rejection = events.find((event) => event._tag === "GateRejected") as Event.GateRejected
    expect(rejection.link).toBe(1)
    expect(rejection.ordinal).toBe(0)
    expect(rejection.observation.kind).toBe("catalog")

    expect(seen).toHaveLength(2)
    const recovery = seen[1] as Author.Input
    expect(recovery.context[0]).toBe("fix TODOs")
    expect(recovery.context.some((line) => line.startsWith("[catalog]"))).toBe(true)

    const recoveryCall = events.filter((event) =>
      event._tag === "CallSettled" && event.link === 1
    )[0] as Event.CallSettled
    expect(recoveryCall.key.ordinal).toBe(1)
    expect(recoveryCall.key.scriptDigest).toBe("")
  })

  it("retries authoring when the output has no flow block", async () => {
    const seen: Array<Author.Input> = []
    const author = Author.layerFn((input) => {
      seen.push(input)
      return seen.length === 1 ? "no fence in sight" : doneScript
    })
    const { events, outcome } = await runChain({ author })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })

    const rejection = events[1] as Event.GateRejected
    expect(rejection._tag).toBe("GateRejected")
    expect(rejection.observation.kind).toBe("shape")
    const marker = events[2] as Event.CallSettled
    expect(marker._tag).toBe("CallSettled")
    expect(marker.result).toEqual({ raw: "no fence in sight", rejected: true })

    const retry = seen[1] as Author.Input
    expect(retry.context.some((line) => line.startsWith("[shape]"))).toBe(true)
  })

  it("recovers from a failing catalog entry", async () => {
    const seen: Array<Author.Input> = []
    const bad = flow(`await ctx.call("boom", {})`, `return done(null)`)
    const author = Author.layerFn((input) => {
      seen.push(input)
      return seen.length === 1 ? bad : doneScript
    })
    const { events, outcome } = await runChain({
      author,
      entries: [failingEntry("boom", "exploded")]
    })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
    const rejection = events.find((event) => event._tag === "GateRejected") as Event.GateRejected
    expect(rejection.observation.kind).toBe("call_failed")
    expect(rejection.observation.message).toContain("exploded")
    expect((seen[1] as Author.Input).context.some((line) => line.startsWith("[call_failed]"))).toBe(true)
  })

  it("rejects a non-JSON handler result before journaling it", async () => {
    const bad = flow(`await ctx.call("bad-result", {})`, `return done(null)`)
    const { events, outcome } = await runChain({
      author: Author.layerMock([bad, doneScript]),
      entries: [countingEntry("bad-result", new Date(0)).entry]
    })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
    expect(events.some((event) => event._tag === "CallSettled" && event.name === "bad-result")).toBe(false)
    const rejection = events.find((event) =>
      event._tag === "GateRejected" && event.observation.message.includes("not JSON-serializable")
    )
    expect(rejection).toBeDefined()
  })

  it("rejects a non-JSON payload supplied by a runner binding", async () => {
    let runs = 0
    const runner = ScriptRunner.make({
      run: (_script, handler) => {
        runs++
        return runs === 1
          ? handler({ name: "bad-input", payload: new Date(0) }).pipe(
            Effect.as({ _tag: "Done", value: null } as const)
          )
          : Effect.succeed({ _tag: "Done", value: "recovered" } as const)
      }
    })
    const { events, outcome } = await runChain({
      author: Author.layerMock([flow(`return done(null)`), doneScript]),
      entries: [countingEntry("bad-input", null).entry],
      runner: Layer.succeed(ScriptRunner.ScriptRunner)(runner)
    })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
    expect(events.some((event) => event._tag === "CallSettled" && event.name === "bad-input")).toBe(false)
  })

  it.each([
    ["throws", `throw new Error("kaput")`, "runtime"],
    ["returns a non-outcome", `return 42`, "invalid_outcome"],
    ["does not compile", `const const`, "compile"]
  ])("recovers from a script that %s", async (_label, body, code) => {
    const seen: Array<Author.Input> = []
    const author = Author.layerFn((input) => {
      seen.push(input)
      return seen.length === 1 ? flow(body) : doneScript
    })
    const { events, outcome } = await runChain({ author })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
    const rejection = events.find((event) => event._tag === "GateRejected") as Event.GateRejected
    expect(rejection.observation.kind).toBe("script_failed")
    expect(rejection.observation.message).toContain(code)
    expect((seen[1] as Author.Input).context.some((line) => line.startsWith("[script_failed]"))).toBe(true)
  })

  it("does not duplicate a script failure observation on resume", async () => {
    const first = await runChain({
      author: Author.layerMock([flow(`throw new Error("kaput")`), doneScript])
    })
    const rejectionIndex = first.events.findIndex((event) => event._tag === "GateRejected")
    const resumed = await runChain({
      author: Author.layerMock([doneScript]),
      initial: first.events.slice(0, rejectionIndex + 1)
    })
    expect(resumed.outcome).toEqual({ _tag: "Done", value: "recovered" })
    expect(resumed.events.filter((event) => event._tag === "GateRejected")).toHaveLength(1)
    expect(resumed.events).toEqual(first.events)
  })

  it("replays a recorded rejection without re-running its gate", async () => {
    const bad = flow(`await ctx.call("missing", {})`, `return done(null)`)
    const first = await runChain({ author: Author.layerMock([bad, doneScript]) })
    const rejectionIndex = first.events.findIndex((event) => event._tag === "GateRejected")
    const resumed = await runChain({
      author: Author.layerMock([doneScript]),
      initial: first.events.slice(0, rejectionIndex + 1)
    })
    expect(resumed.outcome).toEqual({ _tag: "Done", value: "recovered" })
    expect(resumed.events.filter((event) => event._tag === "GateRejected")).toHaveLength(1)
    expect(resumed.events).toEqual(first.events)
  })

  it("parks the chain when a link runs out of fuel", async () => {
    const grep = countingEntry("grep", grepResult)
    const greedy = flow(
      `await ctx.call("grep", {})`,
      `await ctx.call("grep", {})`,
      `await ctx.call("grep", {})`,
      `return done(null)`
    )
    const { events, outcome } = await runChain({
      author: Author.layerMock([greedy]),
      entries: [grep.entry],
      maxCallsPerLink: 2
    })
    expect(outcome._tag).toBe("Park")
    expect((outcome as { reason: { code: string } }).reason.code).toBe("quota")
    const rejection = events.find((event) => event._tag === "GateRejected") as Event.GateRejected
    expect(rejection.observation.kind).toBe("fuel")
    expect(grep.count()).toBe(2)
    const ended = events.at(-1) as Event.LinkEnded
    expect(ended.link).toBe(1)
    expect(ended.outcome._tag).toBe("Park")
  })

  it("parks immediately when the call budget is zero", async () => {
    const { events, outcome } = await runChain({
      author: Author.layerNoop(),
      maxCallsPerLink: 0,
      runner: ScriptRunner.layerNoop()
    })
    expect(outcome._tag).toBe("Park")
    expect(events.map((event) => event._tag)).toEqual(["ChainStarted", "GateRejected", "LinkEnded"])
  })

  it("parks the chain at its link budget", async () => {
    const relay = flow(`const s = await ctx.call("author", { context: [] })`, `return to(s)`)
    const { events, outcome } = await runChain({
      author: Author.layerFn(() => relay),
      maxLinks: 2
    })
    expect(outcome._tag).toBe("Park")
    expect((outcome as { reason: { message: string } }).reason.message).toContain("2 links")
    const ended = events.at(-1) as Event.LinkEnded
    expect(ended.link).toBe(2)
  })

  it("parks when the script says park, and replays the park as terminal", async () => {
    const parking = flow(`return park("timer")`)
    const first = await runChain({ author: Author.layerMock([parking]) })
    expect(first.outcome).toEqual({ _tag: "Park", reason: { code: "timer", message: "" } })

    const replay = await runChain({
      author: Author.layerMock([]),
      initial: first.events,
      runner: ScriptRunner.layerNoop()
    })
    expect(replay.outcome).toEqual(first.outcome)
    expect(replay.events).toEqual(first.events)
  })

  it("fails with replay_divergence when the journal disagrees with the script", async () => {
    const { events } = await goldenRun()
    const tampered = [...events.slice(0, 5)]
    tampered[4] = { ...tampered[4], name: "other" } as Event.Event
    const error = await failChain({
      author: Author.layerMock([]),
      initial: tampered
    }) as { _tag: string; code: string }
    expect(error._tag).toBe("/chain/ChainError")
    expect(error.code).toBe("replay_divergence")
  })

  it.each([
    ["script digest", { scriptDigest: "tampered" }],
    ["link", { link: 99 }]
  ])("refuses to replay a call settled under a different %s", async (_label, keyPatch) => {
    const { events } = await goldenRun()
    const tampered = [...events.slice(0, 5)]
    const settled = tampered[4] as Event.CallSettled
    tampered[4] = { ...settled, key: { ...settled.key, ...keyPatch } }

    const error = await failChain({
      author: Author.layerMock([]),
      initial: tampered
    }) as { code: string; message: string }
    expect(error.code).toBe("replay_divergence")
    expect(error.message).toContain("different link or script")
  })

  it("refuses to replay a call whose entry left the catalog", async () => {
    const { events } = await goldenRun()
    const error = await failChain({
      author: Author.layerMock([]),
      entries: [countingEntry("edit", { ok: true }).entry],
      initial: events.slice(0, 5)
    }) as { code: string }
    expect(error.code).toBe("replay_divergence")
  })

  it("refuses to replay a settled call under a different payload", async () => {
    const { events } = await goldenRun()
    const tampered = [...events.slice(0, 5)]
    tampered[4] = { ...(tampered[4] as Event.CallSettled), payload: { pattern: "FIXME" } }
    const error = await failChain({
      author: Author.layerMock([]),
      entries: [countingEntry("grep", grepResult).entry],
      initial: tampered
    }) as Chain.ChainError
    expect(error.code).toBe("replay_divergence")
    expect(error.message).toContain("different payload")
  })

  it("refuses catalog and entries together in the test harness", () => {
    expect(() =>
      runChain({
        author: Author.layerMock([]),
        catalog: {} as never,
        entries: []
      })
    ).toThrow("catalog or entries, not both")
  })

  it("refuses to replay a call settled under a redeclared entry", async () => {
    const { events } = await goldenRun()
    const redeclaredGrep = countingEntry("grep", grepResult)
    const error = await failChain({
      author: Author.layerMock([]),
      entries: [
        { ...redeclaredGrep.entry, description: "a different declaration" },
        countingEntry("edit", { ok: true }).entry
      ],
      initial: events.slice(0, 5)
    }) as { _tag: string; code: string; message: string }
    expect(error._tag).toBe("/chain/ChainError")
    expect(error.code).toBe("replay_divergence")
    expect(error.message).toContain("different declaration")
    expect(redeclaredGrep.count()).toBe(0)
  })

  it("fails with invalid_journal when a settled author result is not a script", async () => {
    const { events } = await goldenRun()
    const tampered = [events[0], { ...events[1], result: 42 }] as ReadonlyArray<Event.Event>
    const error = await failChain({
      author: Author.layerMock([]),
      initial: tampered
    }) as { _tag: string; code: string }
    expect(error._tag).toBe("/chain/ChainError")
    expect(error.code).toBe("invalid_journal")
  })

  it("propagates an exhausted mock author", async () => {
    const error = await failChain({ author: Author.layerMock([]) }) as { _tag: string; code: string }
    expect(error._tag).toBe("/chain/AuthorError")
    expect(error.code).toBe("exhausted")
  })

  it("pins the goal and envelope, and hands the prefix to the author seat", async () => {
    const seen: Array<Author.Input> = []
    const author = Author.layerFn((input) => {
      seen.push(input)
      return doneScript
    })
    const { events, outcome } = await runChain({
      author,
      envelope: { workspace: "agent" },
      goal: "build it",
      prefix: "SYSTEM"
    })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
    expect(events[0]).toEqual({ _tag: "ChainStarted", envelope: { workspace: "agent" }, goal: "build it" })
    expect((seen[0] as Author.Input).prefix).toBe("SYSTEM")
    expect((seen[0] as Author.Input).context).toEqual(["build it"])
  })

  it("normalizes a garbage author payload from a script to empty context", async () => {
    const seen: Array<Author.Input> = []
    const weird = flow(`const s = await ctx.call("author", "garbage")`, `return to(s)`)
    const author = Author.layerFn((input) => {
      seen.push(input)
      return seen.length === 1 ? weird : doneScript
    })
    const { outcome } = await runChain({ author })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
    expect((seen[1] as Author.Input).context).toEqual([])
  })
})
