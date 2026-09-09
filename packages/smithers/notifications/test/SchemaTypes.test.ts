/**
 * The reference promises that every schema export also names its decoded type.
 * These are compile-time assertions: each name below is used in type position,
 * so a schema that exports only a value fails `tsc -p tsconfig.test.json`.
 */
import { describe, expect, it } from "vitest"
import * as Notification from "../src/Notification.ts"
import * as SteerPayload from "../src/SteerPayload.ts"

const humanSteer: Notification.HumanSteer = {
  _tag: "human-steer",
  id: "steer",
  delivery: "steer",
  targetLineageId: "run/root",
  provenance: { sourceRunId: "s", sourceLineageId: "s/root", sourceTurn: 0, sourceActor: "human" },
  payload: { body: "ship it" }
}

const humanFollowup: Notification.HumanFollowup = { ...humanSteer, _tag: "human-followup", delivery: "queue" }

const systemEvent: Notification.SystemEvent = {
  ...humanSteer,
  _tag: "system-event",
  delivery: "queue",
  coalescingKey: "budget"
}

const message: SteerPayload.MessagePayload = { kind: "Message", body: "ship it" }
const seat: SteerPayload.SeatPayload = { kind: "Seat", seat: "reviewer" }
const thinking: SteerPayload.ThinkingPayload = { kind: "Thinking", thinking: "high" }
const tools: SteerPayload.ToolsPayload = { kind: "Tools", toolNames: ["grep"] }

describe("schema exports name their decoded type", () => {
  it("types each notification variant by its schema name", () => {
    expect([humanSteer, humanFollowup, systemEvent].map((value) => value._tag)).toEqual([
      "human-steer",
      "human-followup",
      "system-event"
    ])
  })

  it("types each steer payload variant by its schema name", () => {
    expect([message, seat, thinking, tools].map((value) => value.kind)).toEqual([
      "Message",
      "Seat",
      "Thinking",
      "Tools"
    ])
  })
})
