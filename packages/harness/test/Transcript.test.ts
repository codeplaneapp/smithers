/**
 * Journal-to-transcript projection: what a resumed run rebuilds from what the
 * loop journaled, and what it refuses to rebuild from a payload that no longer
 * decodes. See `packages/harness/docs/concepts.md#durable-cell-loop`.
 */
import type { JournalEvent } from "@smthrs/journal"
import { ModelEvent, ModelRequest } from "@smthrs/model"
import { Option, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as Cell from "../src/Cell.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as Transcript from "../src/Transcript.ts"
import { entry, journal } from "./fixtures/journal.ts"

const project = (entries: ReadonlyArray<JournalEvent.Entry>): ReadonlyArray<ModelRequest.Message> =>
  Result.getOrThrow(Transcript.projectResult(entries))

describe("Transcript", () => {
  it("orders entries and ignores journal-only events", () => {
    const entries = [
      ...journal().filter((item) => item.seq < 8),
      entry(10, "denial", {}),
      entry(11, "flows.harness.turn-opened.v1", {}),
      entry(12, "unknown-event", {})
    ].reverse()
    expect(project(entries).map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant"
    ])
  })

  it("projects only drained steering in sequence order", () => {
    const entries = [
      entry(2, "steering", { messages: ["not drained"] }),
      entry(
        1,
        "flows.harness.steering-drained.v1",
        new AgentEvent.SteeringDrained({
          eventType: "flows.harness.steering-drained.v1",
          messages: [ModelRequest.Message.user("one"), ModelRequest.Message.user("two")]
        })
      )
    ]
    expect(project(entries)).toEqual([ModelRequest.Message.user("one"), ModelRequest.Message.user("two")])
  })

  it("omits empty assistant turns, preserves failed partial content, and strips its continuation metadata", () => {
    const messages = project([
      entry(
        1,
        "flows.harness.model-settled.v1",
        new AgentEvent.ModelSettled({
          eventType: "flows.harness.model-settled.v1",
          message: ModelRequest.Message.assistant([], {
            stopReason: "error",
            responseId: "empty-response"
          }),
          usage: ModelEvent.Usage.make({ inputTokens: 0, outputTokens: 0 })
        })
      ),
      entry(2, "flows.harness.model-delta.v1", {
        responseId: "failed-partial-response"
      }),
      entry(
        3,
        "flows.harness.model-settled.v1",
        new AgentEvent.ModelSettled({
          eventType: "flows.harness.model-settled.v1",
          message: ModelRequest.Message.assistant([
            ModelRequest.ThinkingPart.make({
              text: "Partial thought",
              signature: "provider-signature"
            }),
            ModelRequest.TextPart.make({ text: "Partial answer" })
          ], {
            stopReason: "error",
            responseId: "failed-response",
            itemIds: ["failed-item"]
          }),
          usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 2 })
        })
      ),
      entry(
        4,
        "flows.harness.model-settled.v1",
        new AgentEvent.ModelSettled({
          eventType: "flows.harness.model-settled.v1",
          message: ModelRequest.Message.assistant("complete", {
            stopReason: "stop",
            responseId: "settled-response"
          }),
          usage: ModelEvent.Usage.make({ inputTokens: 0, outputTokens: 0 })
        })
      )
    ])

    expect(messages).toEqual([
      ModelRequest.Message.assistant([
        ModelRequest.ThinkingPart.make({
          text: "Partial thought"
        }),
        ModelRequest.TextPart.make({ text: "Partial answer" })
      ], {
        stopReason: "error"
      }),
      ModelRequest.Message.assistant("complete", {
        stopReason: "stop",
        responseId: "settled-response"
      })
    ])
  })

  it("renders a compaction summary plus suffix without changing journal entries", () => {
    const entries = journal()
    const before = entries.map((entry) => entry.seq)
    const state = Result.getOrThrow(Transcript.projectStateResult(entries))
    expect(state.replaced).toBe("prefix-digest")
    expect(state.messages.map(({ kind }) => kind)).toEqual([
      "summary",
      "transcript"
    ])
    expect(entries.map((entry) => entry.seq)).toEqual(before)
  })

  it("returns a typed failure for malformed known payloads without throwing", () => {
    const result = Transcript.projectResult([entry(1, "flows.harness.model-settled.v1", { message: "bad" })])

    expect(Result.isFailure(result)).toBe(true)
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(Transcript.TranscriptError)
    expect(Result.isFailure(result) && result.failure.code).toBe("projection_failed")
  })

  it("keeps the projection error code stable", () => {
    const result = Transcript.projectStateResult([
      entry(1, "flows.harness.compaction-settled.v1", { summary: "bad" })
    ])

    expect(Result.isFailure(result) && result.failure.code).toBe("projection_failed")
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(Transcript.TranscriptError)
  })

  it("consumes versioned cell evidence and rebuilds the cell-selected context", () => {
    const source = Cell.source("console.log(\"keep exactly this\")")
    const call = new Cell.Call({
      flowName: "fs/list",
      input: { path: "." },
      capabilities: [],
      effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
      placement: Option.none(),
      identity: new Cell.CallIdentity({
        session: "lineage-1",
        frame: 1,
        cell: source.digest,
        ordinal: 0,
        declaration: "declaration-1",
        layers: ["composition-1"]
      })
    })
    const transition = new Cell.Continue({})
    const reason = new EngineLike.SuspendReason({
      code: "waiting-input",
      message: "choose a branch"
    })
    const events: ReadonlyArray<AgentEvent.AgentEvent> = [
      new AgentEvent.CompactionSettled({
        eventType: "flows.harness.compaction-settled.v1",
        replacedPrefixDigest: "old-prefix",
        summary: ModelRequest.Message.assistant("compacted", { stopReason: "stop" })
      }),
      new AgentEvent.ModelSettled({
        eventType: "flows.harness.model-settled.v1",
        message: ModelRequest.Message.assistant("cell source", { stopReason: "stop" }),
        usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 1 })
      }),
      new AgentEvent.CellProduced({ eventType: "flows.harness.cell-produced.v1", cell: source }),
      new AgentEvent.CellCallStarted({ eventType: "flows.harness.cell-call-started.v1", call }),
      new AgentEvent.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: call.flowName,
        identity: call.identity,
        result: new Cell.CallResult({ outcome: "success", value: ["alpha"] })
      }),
      new AgentEvent.CellSettled({
        eventType: "flows.harness.cell-settled.v1",
        cell: source.digest,
        outcome: new Cell.Settled({ transition })
      }),
      new AgentEvent.TransitionApplied({
        eventType: "flows.harness.transition-applied.v1",
        transition
      }),
      new AgentEvent.SteeringDrained({
        eventType: "flows.harness.steering-drained.v1",
        messages: [ModelRequest.Message.user("then steer")]
      }),
      new AgentEvent.Suspended({ eventType: "flows.harness.suspended.v1", reason }),
      new AgentEvent.Aborted({ eventType: "flows.harness.aborted.v1", reason: "host interrupted" })
    ]

    for (const event of events) {
      expect(event.eventType).toMatch(/\.v1$/)
      expect(Schema.decodeUnknownResult(AgentEvent.AgentEvent)(event)._tag).toBe("Success")
    }

    const projected = Result.getOrThrow(
      Transcript.projectStateResult(events.map((event, index) => entry(index + 1, event.eventType, event)))
    )
    // The transcript grows: the compaction summary leads, the model's own reply
    // follows, and the steer lands after it. A `continue` replaces nothing.
    expect(projected.messages.map(({ message }) => message)).toEqual([
      ModelRequest.Message.assistant("compacted", { stopReason: "stop" }),
      ModelRequest.Message.assistant("cell source", { stopReason: "stop" }),
      ModelRequest.Message.user("then steer")
    ])
    expect(projected.cell.produced).toEqual([source])
    expect(projected.cell.callsStarted).toEqual([call])
    expect(projected.cell.callsSettled).toHaveLength(1)
    expect(projected.cell.settled).toHaveLength(1)
    expect(projected.cell.transitions).toEqual([transition])
    expect(projected.cell.suspensions).toEqual([reason])
    expect(projected.cell.aborts).toEqual(["host interrupted"])
  })

  it("reconstructs rejected and raised cell observations", () => {
    const rejected = new AgentEvent.CellSettled({
      eventType: "flows.harness.cell-settled.v1",
      cell: "",
      outcome: new Cell.Rejected({ code: "no_cell", message: "emit a cell" })
    })
    const raised = new AgentEvent.CellSettled({
      eventType: "flows.harness.cell-settled.v1",
      cell: "cell-1",
      outcome: new Cell.Raised({ name: "RangeError", message: "off by one" })
    })
    const complete = new AgentEvent.TransitionApplied({
      eventType: "flows.harness.transition-applied.v1",
      transition: new Cell.Complete({ output: "done" })
    })
    expect(
      project([
        entry(1, rejected.eventType, rejected),
        entry(2, raised.eventType, raised),
        entry(3, complete.eventType, complete)
      ])
    )
      .toEqual([
        ModelRequest.Message.user("emit a cell"),
        ModelRequest.Message.user("The cell threw RangeError: off by one. Emit a corrected cell.")
      ])
  })

  it("projects an empty journal as an empty transcript", () => {
    const state = Result.getOrThrow(Transcript.projectStateResult([]))

    expect(state.messages).toEqual([])
    expect(state.replaced).toBeUndefined()
    expect(state.cell).toEqual({
      produced: [],
      printed: [],
      callsStarted: [],
      callsSettled: [],
      settled: [],
      transitions: [],
      suspensions: [],
      aborts: []
    })
    expect(Result.getOrThrow(Transcript.projectResult([]))).toEqual([])
  })

  it("rebuilds the window the next turn read, prints included", () => {
    // `CellPrinted` was journaled and never projected, so a transcript rebuilt
    // from a harness-native journal was missing the entire context channel:
    // what a cell printed IS what the next model turn reads.
    //
    // The journal carries the raw buffer and the controller sends
    // `printsObservation` of it, so the projection has to render the same way
    // or it rebuilds a window the run never had. An empty buffer is a message
    // too: the turn it opened told the model the realm still holds what the
    // cell bound. Replaying the raw text, or dropping the empty one, is a
    // window that differs from the one the model was actually sent.
    const source = Cell.source("console.log(\"found it\")")
    const events: ReadonlyArray<AgentEvent.AgentEvent> = [
      new AgentEvent.ModelSettled({
        eventType: AgentEvent.eventType.modelSettled,
        message: ModelRequest.Message.assistant("here is the cell", { stopReason: "stop" }),
        usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 1 })
      }),
      new AgentEvent.CellProduced({ eventType: AgentEvent.eventType.cellProduced, cell: source }),
      new AgentEvent.CellPrinted({
        eventType: AgentEvent.eventType.cellPrinted,
        cell: source.digest,
        text: "found it"
      }),
      new AgentEvent.CellSettled({
        eventType: AgentEvent.eventType.cellSettled,
        cell: source.digest,
        outcome: new Cell.Settled({ transition: new Cell.Continue({}) })
      }),
      new AgentEvent.CellPrinted({
        eventType: AgentEvent.eventType.cellPrinted,
        cell: source.digest,
        text: ""
      })
    ]
    const entries = events.map((event, index) =>
      entry(index + 1, event.eventType, Schema.encodeSync(AgentEvent.AgentEvent)(event))
    )

    const state = Result.getOrThrow(Transcript.projectStateResult(entries))

    expect(state.messages.map((item) => item.message.role)).toEqual(["assistant", "user", "user"])
    expect(state.messages[1]?.message).toEqual(
      ModelRequest.Message.user("What your cell printed:\nfound it")
    )
    expect(state.messages[2]?.message).toEqual(
      ModelRequest.Message.user(
        "Your cell printed nothing, so this turn opens with nothing new to read. Everything it bound is still in the realm; print what you need to look at."
      )
    )
    expect(state.cell.printed.map((event) => event.text)).toEqual(["found it", ""])
  })

  it("refuses a malformed print buffer rather than projecting a window without it", () => {
    const result = Transcript.projectStateResult([
      entry(1, AgentEvent.eventType.cellPrinted, { eventType: AgentEvent.eventType.cellPrinted, cell: 7 })
    ])

    expect(Result.isFailure(result) && result.failure.code).toBe("projection_failed")
  })

  it("keeps the journal event-type table in step with the event union", () => {
    // The literal used to be written three times: on the class, in the
    // controller's emitter, and again in this projection's decoder. A decoder
    // reading a literal the emitter no longer writes returns an empty
    // transcript and fails nothing.
    const declared = Object.values(AgentEvent.eventType)

    expect(new Set(declared).size).toBe(declared.length)
    for (const value of declared) expect(value).toMatch(/^flows\.harness\.[a-z-]+\.v1$/)
  })

  it("rejects malformed drained steering rather than projecting a partial turn", () => {
    const result = Transcript.projectStateResult([
      entry(1, "flows.harness.steering-drained.v1", { eventType: "flows.harness.steering-drained.v1" })
    ])

    expect(Result.isFailure(result) && result.failure.code).toBe("projection_failed")
    expect(Result.isFailure(result) && result.failure.message).toBe(
      "Invalid flows.harness.steering-drained.v1 payload at journal sequence 1"
    )
  })

  it("returns a typed failure when a payload cannot be decoded", () => {
    const state = Transcript.projectStateResult([
      entry(1, "flows.harness.model-settled.v1", { message: "bad" }),
      entry(2, "flows.harness.compaction-settled.v1", { replacedPrefixDigest: "prefix", summary: "bad" })
    ])

    expect(Result.isFailure(state)).toBe(true)
    if (Result.isFailure(state)) expect(state.failure.code).toBe("projection_failed")
  })

  it("keeps only the last compaction and everything sequenced after it", () => {
    const compaction = (seq: number, digest: string, summary: string) =>
      entry(
        seq,
        "flows.harness.compaction-settled.v1",
        new AgentEvent.CompactionSettled({
          eventType: "flows.harness.compaction-settled.v1",
          replacedPrefixDigest: digest,
          summary: ModelRequest.Message.user(summary)
        })
      )
    const settled = (seq: number, text: string) =>
      entry(
        seq,
        "flows.harness.model-settled.v1",
        new AgentEvent.ModelSettled({
          eventType: "flows.harness.model-settled.v1",
          message: ModelRequest.Message.assistant(text, { stopReason: "stop" }),
          usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 1 })
        })
      )

    const state = Result.getOrThrow(Transcript.projectStateResult([
      settled(1, "before the first"),
      compaction(2, "first-prefix", "first summary"),
      settled(3, "between"),
      compaction(4, "second-prefix", "second summary"),
      settled(5, "after the second")
    ]))

    expect(state.replaced).toBe("second-prefix")
    expect(state.messages).toEqual([
      { kind: "summary", message: ModelRequest.Message.user("second summary") },
      { kind: "transcript", message: ModelRequest.Message.assistant("after the second", { stopReason: "stop" }) }
    ])
  })

  it("projects only the summary when compaction is the last entry", () => {
    const entries = [
      ...journal().filter((item) => item.seq <= 8)
    ]

    const state = Result.getOrThrow(Transcript.projectStateResult(entries))

    expect(state.messages).toEqual([
      { kind: "summary", message: ModelRequest.Message.user("First turn summary") }
    ])
  })

  it("strips continuation metadata from an aborted turn as well as a failed one", () => {
    const messages = project([
      entry(
        1,
        "flows.harness.model-settled.v1",
        new AgentEvent.ModelSettled({
          eventType: "flows.harness.model-settled.v1",
          message: ModelRequest.Message.assistant([
            ModelRequest.ThinkingPart.make({ text: "half a thought", signature: "provider-signature" }),
            ModelRequest.TextPart.make({ text: "half an answer" })
          ], {
            stopReason: "aborted",
            responseId: "aborted-response",
            itemIds: ["aborted-item"]
          }),
          usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 0 })
        })
      )
    ])

    expect(messages).toEqual([
      ModelRequest.Message.assistant([
        ModelRequest.ThinkingPart.make({ text: "half a thought" }),
        ModelRequest.TextPart.make({ text: "half an answer" })
      ], { stopReason: "aborted" })
    ])
  })

  it("keeps the transcript whatever the transition was", () => {
    const settled = entry(
      1,
      "flows.harness.model-settled.v1",
      new AgentEvent.ModelSettled({
        eventType: "flows.harness.model-settled.v1",
        message: ModelRequest.Message.assistant("kept", { stopReason: "stop" }),
        usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 1 })
      })
    )
    const applied = (seq: number, transition: Cell.Transition) =>
      entry(
        seq,
        "flows.harness.transition-applied.v1",
        new AgentEvent.TransitionApplied({ eventType: "flows.harness.transition-applied.v1", transition })
      )

    const parked = project([
      settled,
      applied(2, new Cell.Park({ reason: "waiting-event", message: "waiting on CI" }))
    ])
    const continued = project([settled, applied(2, new Cell.Continue({}))])
    // The decode-only half, replayed. A journal from the r90–r96 waves carries
    // a `continue` that filed state and chose its successor's whole context,
    // and it is the one input that could still make this projection behave like
    // the deleted surface. It decodes, and the entries are not read: without
    // this case every transition under test is empty, so the branch that used
    // to replace the prefix could come back unnoticed.
    const filed = project([
      settled,
      applied(
        2,
        Schema.decodeUnknownSync(Cell.Transition)({
          _tag: "continue",
          state: { step: 2 },
          context: [{ role: "assistant", text: "only this" }],
          render: ["step"],
          recall: [1]
        })
      )
    ])

    // No transition replaces the transcript: what the model said stays said,
    // whichever way the frame ended.
    expect(parked).toEqual([ModelRequest.Message.assistant("kept", { stopReason: "stop" })])
    expect(continued).toEqual([ModelRequest.Message.assistant("kept", { stopReason: "stop" })])
    expect(filed).toEqual([ModelRequest.Message.assistant("kept", { stopReason: "stop" })])
  })

  it("projects a cell that settled cleanly without adding a correction message", () => {
    const settled = new AgentEvent.CellSettled({
      eventType: "flows.harness.cell-settled.v1",
      cell: "cell-1",
      outcome: new Cell.Settled({ transition: new Cell.Complete({ output: "done" }) })
    })

    const state = Result.getOrThrow(Transcript.projectStateResult([entry(1, settled.eventType, settled)]))

    expect(state.messages).toEqual([])
    expect(state.cell.settled).toHaveLength(1)
  })

  it.each([
    "flows.harness.cell-produced.v1",
    "flows.harness.cell-call-started.v1",
    "flows.harness.cell-call-settled.v1",
    "flows.harness.cell-settled.v1",
    "flows.harness.transition-applied.v1",
    "flows.harness.suspended.v1",
    "flows.harness.aborted.v1"
  ])("rejects malformed %s evidence", (eventType) => {
    const result = Transcript.projectStateResult([entry(1, eventType, { eventType })])
    expect(Result.isFailure(result) && result.failure.code).toBe("projection_failed")
  })
})
