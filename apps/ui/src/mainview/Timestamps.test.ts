import { describe, expect, test } from "bun:test"
import { timeLabel } from "./Timestamps"

/*
 * §28.9: the transcript is persisted, so a stamp is read on days other than
 * the one it was written on. A bare clock reading made a message from last
 * week indistinguishable from one three minutes ago.
 */

const at = (iso: string): number => new Date(iso).getTime()

describe("a transcript stamp says which day it belongs to", () => {
  const now = at("2026-08-19T14:00:00")

  test("a stamp from today is the time alone", () => {
    const label = timeLabel(at("2026-08-19T02:51:00"), now)
    expect(label).not.toContain("Yesterday")
    expect(label).toMatch(/2:51/)
  })

  test("a stamp from the previous calendar day says Yesterday", () => {
    expect(timeLabel(at("2026-08-18T23:51:00"), now)).toStartWith("Yesterday ")
  })

  test("an older stamp carries its date", () => {
    const label = timeLabel(at("2026-08-12T23:51:00"), now)
    expect(label).not.toContain("Yesterday")
    expect(label).toContain("12")
  })

  test("the hour is not zero-padded by hand", () => {
    expect(timeLabel(at("2026-08-19T02:51:00"), now)).not.toStartWith("02:")
  })

  test("a stamp from later today is still the time alone — a clock skew is not a day", () => {
    expect(timeLabel(at("2026-08-19T23:00:00"), now)).not.toContain("Yesterday")
  })
})
