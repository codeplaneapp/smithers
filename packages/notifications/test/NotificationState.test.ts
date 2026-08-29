import { describe, expect, it } from "vitest"
import type { Notification } from "../src/Notification.ts"
import { coalesceKey } from "../src/Notification.ts"
import * as NotificationState from "../src/NotificationState.ts"

const notification = (
  id: string,
  _tag: "human-steer" | "human-followup" | "system-event",
  payload = id,
  coalescingKey?: string
): Notification => ({
  id,
  _tag,
  payload,
  coalescingKey,
  delivery: _tag === "human-steer" ? "steer" : "queue",
  targetLineageId: "run/root",
  provenance: {
    sourceRunId: "source",
    sourceLineageId: "source/root",
    sourceTurn: 0,
    sourceActor: "test"
  }
} as Notification)

describe("NotificationState", () => {
  it("preserves FIFO order and promotes one queued item at a time", () => {
    let state = NotificationState.empty(4)
    state = NotificationState.admit(state, notification("first", "human-followup"), 1).state
    state = NotificationState.admit(state, notification("second", "human-followup"), 2).state

    const first = NotificationState.promoteQueued(state)
    const second = NotificationState.promoteQueued(first.state)

    expect(first.promoted.map((item) => item.notification.id)).toEqual(["first"])
    expect(second.promoted.map((item) => item.notification.id)).toEqual(["second"])
  })

  it("promotes all steers through the inclusive cutoff", () => {
    let state = NotificationState.empty(4)
    state = NotificationState.admit(state, notification("before", "human-steer"), 4).state
    state = NotificationState.admit(state, notification("at", "human-steer"), 5).state
    state = NotificationState.admit(state, notification("after", "human-steer"), 6).state
    state = NotificationState.admit(state, notification("queued", "human-followup"), 3).state

    const promoted = NotificationState.promoteSteers(state, 5)

    expect(promoted.promoted.map((item) => item.notification.id)).toEqual(["before", "at"])
    expect(promoted.state.items.map((item) => item.notification.id)).toEqual(["after", "queued"])
  })

  it("coalesces system events with a later payload and earlier sequence", () => {
    let state = NotificationState.empty(5)
    let decision: NotificationState.AdmissionDecision | undefined
    for (let index = 1; index <= 5; index++) {
      const admission = NotificationState.admit(
        state,
        notification(`system-${index}`, "system-event", `payload-${index}`, "progress"),
        index
      )
      state = admission.state
      decision = admission.decision
    }

    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ seq: 1, notification: { id: "system-5", payload: "payload-5" } })
    expect(decision).toBe("coalesced")
  })

  it("never coalesces human follow-ups", () => {
    let state = NotificationState.empty(5)
    const decisions: Array<NotificationState.AdmissionDecision> = []
    for (let index = 1; index <= 5; index++) {
      const admission = NotificationState.admit(state, notification(`human-${index}`, "human-followup"), index)
      state = admission.state
      decisions.push(admission.decision)
    }

    expect(state.items.map((item) => item.notification.id)).toEqual([
      "human-1",
      "human-2",
      "human-3",
      "human-4",
      "human-5"
    ])
    expect(decisions).toEqual(["admitted", "admitted", "admitted", "admitted", "admitted"])
  })

  it("reports full capacity without dropping a human notification", () => {
    let state = NotificationState.empty(2)
    state = NotificationState.admit(state, notification("one", "human-followup"), 1).state
    state = NotificationState.admit(state, notification("two", "human-followup"), 2).state
    const rejected = NotificationState.admit(state, notification("three", "human-followup"), 3)

    expect(rejected.decision).toBe("rejected-full")
    expect(rejected.state.items.map((item) => item.notification.id)).toEqual(["one", "two"])
  })

  it("replays the recorded admission decision instead of recomputing capacity", () => {
    const empty = NotificationState.empty(0)
    const human = notification("human", "human-followup")
    const admitted = NotificationState.applyAdmission(empty, human, 1, "admitted")
    expect(admitted.items.map((item) => item.notification.id)).toEqual(["human"])
    expect(NotificationState.applyAdmission(admitted, notification("rejected", "human-followup"), 2, "rejected-full"))
      .toBe(admitted)

    const unkeyed = NotificationState.applyAdmission(
      admitted,
      notification("unkeyed", "human-followup"),
      2,
      "coalesced"
    )
    const first = NotificationState.applyAdmission(
      unkeyed,
      notification("system-1", "system-event", "first", "progress"),
      3,
      "coalesced"
    )
    const replaced = NotificationState.applyAdmission(
      first,
      notification("system-2", "system-event", "second", "progress"),
      4,
      "coalesced"
    )
    expect(replaced.items.at(-1)).toMatchObject({ seq: 3, notification: { id: "system-2", payload: "second" } })
  })

  it("removes durable promoted ids during replay", () => {
    let state = NotificationState.empty(3)
    state = NotificationState.admit(state, notification("one", "human-followup"), 1).state
    state = NotificationState.admit(state, notification("two", "human-followup"), 2).state

    expect(NotificationState.applyPromoted(state, ["one"]).items.map((item) => item.notification.id)).toEqual(["two"])
  })

  it("promotes only notifications for the target lineage", () => {
    const root = notification("root", "human-steer")
    const child = { ...notification("child", "human-steer"), targetLineageId: "run/root/child" }
    let state = NotificationState.empty(3)
    state = NotificationState.admit(state, root, 1).state
    state = NotificationState.admit(state, child, 2).state

    const promoted = NotificationState.promoteSteers(state, 2, "run/root/child")
    expect(promoted.promoted.map((item) => item.notification.id)).toEqual(["child"])
    expect(promoted.state.items.map((item) => item.notification.id)).toEqual(["root"])
  })

  it("filters pending classes and handles empty promotion transitions", () => {
    let state = NotificationState.empty(Number.NaN)
    expect(state.capacity).toBe(0)
    state = NotificationState.empty(3)
    state = NotificationState.admit(state, notification("steer", "human-steer"), 1).state
    state = NotificationState.admit(state, notification("queue", "human-followup"), 2).state

    expect(NotificationState.pending(state, "steer").map((item) => item.notification.id)).toEqual(["steer"])
    expect(NotificationState.pending(state, "queue", "other").map((item) => item.notification.id)).toEqual([])
    expect(NotificationState.promoteQueued(state, "other").promoted).toEqual([])
    expect(NotificationState.applyPromoted(state, [])).toBe(state)
  })

  it("does not coalesce system events without a coalescing key", () => {
    let state = NotificationState.empty(3)
    state = NotificationState.admit(state, notification("one", "system-event"), 1).state
    state = NotificationState.admit(state, notification("two", "system-event"), 2).state
    expect(state.items.map((item) => item.notification.id)).toEqual(["one", "two"])
    expect(coalesceKey(notification("keyed", "system-event", "value", "progress"))).toBe("progress")
    expect(coalesceKey(notification("human", "human-followup"))).toBeNull()
  })
})
