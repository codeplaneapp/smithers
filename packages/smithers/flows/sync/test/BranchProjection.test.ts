import { JournalEvent } from "@smthrs/journal"
import { describe, expect, it } from "vitest"
import * as BranchProjection from "../src/BranchProjection.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"

const branchId = "live-branch" as BranchProtocol.BranchId
const runId = BranchProtocol.branchRunId(branchId)
const participant = (id: string) => id as BranchProtocol.ParticipantId

let nextSourceSeq = 0

const entry = (fields: {
  readonly seq: number
  readonly payload: unknown
  readonly runId?: JournalEvent.RunId
  readonly eventType?: string
  readonly participantId?: string
}) =>
  new JournalEvent.Entry({
    runId: fields.runId ?? runId,
    seq: fields.seq as JournalEvent.Seq,
    eventId: `event-${fields.seq}`,
    sourceId: BranchProtocol.commandSourceId(`event-${fields.seq}` as BranchProtocol.CommandId),
    sourceSeq: (nextSourceSeq += 1) as JournalEvent.SourceSeq,
    emittedAtMs: fields.seq,
    eventType: fields.eventType ?? BranchProtocol.CommandEvent,
    payload: fields.payload,
    meta: null
  })

const command = (fields: {
  readonly seq: number
  readonly commandId: string
  readonly participantId?: string
  readonly name?: string
  readonly args?: string
  readonly target?: string
}) =>
  entry({
    seq: fields.seq,
    ...(fields.participantId === undefined ? {} : { participantId: fields.participantId }),
    payload: {
      branchId,
      commandId: fields.commandId,
      participantId: fields.participantId ?? "alice",
      name: fields.name ?? BranchProtocol.SayCommand,
      args: fields.args ?? "",
      target: fields.target ?? ""
    }
  })

const field = (fields: { readonly seq: number; readonly participantId: string }): BranchProjection.Field => ({
  target: "title",
  value: `by-${fields.participantId}`,
  seq: fields.seq as JournalEvent.Seq,
  participantId: participant(fields.participantId)
})

describe("BranchProjection", () => {
  it("folds commands into an ordered chat projection", () => {
    const state = BranchProjection.project(branchId, [
      command({ seq: 0, commandId: "c1", args: "hello" }),
      command({ seq: 1, commandId: "c2", participantId: "bob", args: "hi back" }),
      command({ seq: 2, commandId: "c3", name: "goal", args: "ship it" })
    ])

    expect(state.seq).toBe(2)
    expect(state.messages.map((message) => message.text)).toEqual(["hello", "hi back"])
    expect(state.messages[1]?.participantId).toBe("bob")
    expect(state.commands.map((applied) => applied.name)).toEqual([
      BranchProtocol.SayCommand,
      BranchProtocol.SayCommand,
      "goal"
    ])
  })

  it("converges regardless of how many times a frame is delivered", () => {
    const entries = [
      command({ seq: 0, commandId: "c1", args: "hello" }),
      command({ seq: 1, commandId: "c2", args: "world" })
    ]
    const once = BranchProjection.project(branchId, entries)
    const thrice = BranchProjection.project(branchId, [...entries, ...entries, ...entries])

    expect(thrice).toEqual(once)
  })

  it("converges regardless of the order frames are delivered in", () => {
    const entries = [
      command({ seq: 0, commandId: "c1", args: "first" }),
      command({ seq: 1, commandId: "c2", participantId: "bob", args: "second" }),
      command({ seq: 2, commandId: "c3", args: "third" })
    ]
    const inOrder = BranchProjection.project(branchId, entries)
    const reversed = BranchProjection.project(branchId, [...entries].reverse())
    const interleaved = BranchProjection.project(branchId, [entries[2]!, entries[0]!, entries[2]!, entries[1]!])

    expect(reversed).toEqual(inOrder)
    expect(interleaved).toEqual(inOrder)
    expect(inOrder.messages.map((message) => message.text)).toEqual(["first", "second", "third"])
  })

  it("ignores a redelivery of the cursor tip, so a resumed read replays nothing", () => {
    const applied = BranchProjection.project(branchId, [command({ seq: 4, commandId: "c1", args: "hello" })])
    const replayed = BranchProjection.apply(applied, command({ seq: 4, commandId: "c-other", args: "again" }))

    expect(replayed).toBe(applied)
    expect(replayed.messages).toHaveLength(1)
  })

  it("ignores a command id it already applied even when the sequence advanced", () => {
    const state = BranchProjection.project(branchId, [
      command({ seq: 0, commandId: "c1", args: "hello" }),
      command({ seq: 1, commandId: "c1", args: "hello" })
    ])

    expect(state.seq).toBe(1)
    expect(state.messages).toHaveLength(1)
  })

  it("ignores entries belonging to another branch's run", () => {
    const foreign = BranchProtocol.branchRunId("other-branch" as BranchProtocol.BranchId)
    const state = BranchProjection.apply(
      BranchProjection.empty(branchId),
      entry({ seq: 0, runId: foreign, payload: { commandId: "c1", participantId: "mallory", name: "branch.say" } })
    )

    expect(state).toEqual(BranchProjection.empty(branchId))
  })

  it("advances the cursor past entries it cannot interpret", () => {
    const undecodable: ReadonlyArray<JournalEvent.Entry> = [
      entry({ seq: 0, eventType: "flows/engine/step", payload: { commandId: "c0", participantId: "a", name: "n" } }),
      entry({ seq: 1, payload: "not an object" }),
      entry({ seq: 2, payload: null }),
      entry({ seq: 3, payload: { participantId: "alice", name: "branch.say" } }),
      entry({ seq: 4, payload: { commandId: "c4", name: "branch.say" } }),
      entry({ seq: 5, payload: { commandId: "c5", participantId: "alice" } })
    ]
    const state = BranchProjection.project(branchId, undecodable)

    expect(state.seq).toBe(5)
    expect(state.commands).toEqual([])
  })

  it("defaults absent optional command fields instead of dropping the command", () => {
    const state = BranchProjection.project(branchId, [
      entry({ seq: 0, payload: { commandId: "c1", participantId: "alice", name: "branch.rename" } })
    ])

    expect(state.commands).toEqual([
      { seq: 0, commandId: "c1", participantId: "alice", name: "branch.rename", args: "", target: "" }
    ])
  })

  it("resolves conflicting durable edits by highest sequence, then by participant", () => {
    expect(BranchProjection.resolveField(undefined, field({ seq: 1, participantId: "alice" }))).toEqual(
      field({ seq: 1, participantId: "alice" })
    )
    expect(
      BranchProjection.resolveField(field({ seq: 1, participantId: "alice" }), field({ seq: 2, participantId: "bob" }))
    ).toEqual(field({ seq: 2, participantId: "bob" }))
    expect(
      BranchProjection.resolveField(field({ seq: 2, participantId: "bob" }), field({ seq: 1, participantId: "alice" }))
    ).toEqual(field({ seq: 2, participantId: "bob" }))
    expect(
      BranchProjection.resolveField(field({ seq: 1, participantId: "alice" }), field({ seq: 1, participantId: "bob" }))
    ).toEqual(field({ seq: 1, participantId: "bob" }))
    expect(
      BranchProjection.resolveField(field({ seq: 1, participantId: "bob" }), field({ seq: 1, participantId: "alice" }))
    ).toEqual(field({ seq: 1, participantId: "bob" }))
  })

  it("keeps one deterministic winner per edited field, sorted by target", () => {
    const state = BranchProjection.project(branchId, [
      command({ seq: 0, commandId: "e1", name: "branch.rename", args: "Alice's title", target: "title" }),
      command({ seq: 1, commandId: "e2", name: "branch.note", args: "shared note", target: "note" }),
      command({
        seq: 2,
        commandId: "e3",
        participantId: "bob",
        name: "branch.rename",
        args: "Bob's title",
        target: "title"
      }),
      command({ seq: 3, commandId: "e4", name: "branch.assign", args: "alice", target: "assignee" })
    ])

    expect(state.fields).toEqual([
      { target: "assignee", value: "alice", seq: 3, participantId: "alice" },
      { target: "note", value: "shared note", seq: 1, participantId: "alice" },
      { target: "title", value: "Bob's title", seq: 2, participantId: "bob" }
    ])
  })

  it("starts empty at a cursor of -1", () => {
    expect(BranchProjection.empty(branchId)).toEqual({
      branchId,
      seq: -1,
      messages: [],
      commands: [],
      fields: []
    })
  })
})
