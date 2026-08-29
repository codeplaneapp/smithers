import { describe, expect, test } from "bun:test"
import { scrubToolEcho } from "./MessageScrub"

describe("the tool-echo scrub", () => {
  test("strips an inline execute blob and keeps the prose around it", () => {
    expect(
      scrubToolEcho(
        "Let me check.{\"action\":\"execute\",\"name\":\"repos.watch\",\"args\":\"\"}Here is the chooser."
      )
    ).toBe("Let me check.Here is the chooser.")
  })

  test("strips list blobs and multiple blobs", () => {
    expect(
      scrubToolEcho("{\"action\":\"list\"} and then {\"action\":\"execute\",\"name\":\"world\"} done")
    ).toBe("and then done")
  })

  test("handles nested braces and escaped quotes inside args", () => {
    expect(
      scrubToolEcho("ok {\"action\":\"execute\",\"name\":\"send\",\"args\":\"{\\\"a\\\":1} and \\\"b\\\"\"} fine")
    ).toBe("ok fine")
  })

  test("leaves ordinary JSON prose alone", () => {
    const text = "The config is {\"retries\": 3} — set it in settings."
    expect(scrubToolEcho(text)).toBe(text)
  })

  test("leaves unbalanced text alone", () => {
    const text = "It starts with {\"action\":\"execute\" and never closes"
    expect(scrubToolEcho(text)).toBe(text)
  })
})
