import { describe, expect, test } from "bun:test"
import type { AgentChatMessage } from "smithers-shared/NativeAgent"
import {
  boundToolResult,
  boundTurnRequest,
  contextMessages,
  estimateTextTokens,
  MAX_TURN_REQUEST_BYTES,
  selectCompactionSlice,
  turnRequestBytes,
  utf8Bytes
} from "./AgentTurnPolicy"
import type { Message } from "./AppState"

/** `AgentChatMessage` is a union: a chat turn, or a tool call/result item. */
const textOf = (message: AgentChatMessage | undefined): string =>
  message !== undefined && "content" in message ? message.content : ""

const message = (ordinal: number, role: Message["role"], text: string, act?: string): Message => ({
  id: `m-${ordinal}`,
  role,
  text,
  status: "complete",
  createdAt: ordinal,
  ordinal,
  ...(act === undefined ? {} : { act })
})

describe("agent turn production policy", () => {
  test("measures the exact UTF-8 request body rather than JS code units", () => {
    const request = { runId: "r", messages: [{ role: "user" as const, content: "🙂" }], instructions: "" }
    expect(turnRequestBytes(request)).toBe(utf8Bytes(JSON.stringify(request)))
    expect(utf8Bytes("🙂")).toBe(4)
    expect(estimateTextTokens("12345")).toBe(2)
  })

  test("injects a hidden Pi-compatible compaction summary and retains only newer messages", () => {
    const messages = [
      message(0, "user", "old question"),
      message(1, "smithers", "old answer"),
      message(2, "user", "new question")
    ]
    expect(
      contextMessages(messages, { summary: "User chose blue.", throughOrdinal: 1, sourceMessageCount: 2, createdAt: 1 })
    ).toEqual([
      {
        role: "user",
        content:
          "The conversation history before this point was compacted into the following summary:\n\n<summary>\nUser chose blue.\n</summary>"
      },
      { role: "user", content: "new question" }
    ])
  })

  test("excludes tool-act rows from both ordinary and compacted context", () => {
    const messages = [
      message(0, "user", "question"),
      message(1, "smithers", "Smithers ran /x", "tool"),
      message(2, "smithers", "answer")
    ]
    expect(contextMessages(messages)).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" }
    ])
  })

  test("cuts only before a complete user turn", () => {
    const messages = [
      message(0, "user", "u0"),
      message(1, "smithers", "a0"),
      message(2, "user", "u1"),
      message(3, "smithers", "a1"),
      message(4, "user", "u2")
    ]
    const slice = selectCompactionSlice(messages, 1)
    expect(slice?.compact.map((entry) => entry.text)).toEqual(["u0", "a0", "u1", "a1"])
    expect(slice?.keep.map((entry) => entry.text)).toEqual(["u2"])
    expect(slice?.throughOrdinal).toBe(3)
  })

  test("does not claim it can compact when no complete old turn exists", () => {
    expect(selectCompactionSlice([message(0, "user", "only")], 1)).toBeUndefined()
    expect(selectCompactionSlice([message(0, "user", "u"), message(1, "smithers", "a")], 1)).toBeUndefined()
  })

  test("tool outputs pass through losslessly under both limits", () => {
    expect(boundToolResult("ok\nvalue", 100, 10)).toEqual({
      modelOutput: "ok\nvalue",
      truncated: false,
      totalBytes: 8,
      totalLines: 2
    })
  })

  test("tool outputs truncate by line count with an explicit evidence marker", () => {
    const bounded = boundToolResult("one\ntwo\nthree", 200, 2)
    expect(bounded.truncated).toBe(true)
    expect(bounded.modelOutput).toStartWith("one\ntwo")
    expect(bounded.modelOutput).not.toContain("three")
    expect(bounded.modelOutput).toContain("13 bytes, 3 lines total")
  })

  test("tool outputs truncate on UTF-8 byte boundaries without replacement characters", () => {
    const bounded = boundToolResult("🙂".repeat(100), 100, 1_000)
    expect(bounded.truncated).toBe(true)
    expect(utf8Bytes(bounded.modelOutput)).toBeLessThanOrEqual(100)
    expect(bounded.modelOutput).not.toContain("�")
    expect(bounded.modelOutput).toContain("400 bytes")
  })

  test("zero and marker-only budgets remain deterministic", () => {
    const bounded = boundToolResult("large", 0, 0)
    expect(bounded.truncated).toBe(true)
    expect(bounded.modelOutput).toContain("Tool result truncated")
  })
})

/*
 * §4.13 — a long conversation must not wedge the seam permanently.
 *
 * Measured on canary: seven long answers pushed POST /api/agent/turn past the
 * upstream body limit, and from that point every turn failed the same way —
 * including `say ok`, and including `/clear`, which runs a model turn of its
 * own into the same wall. The only escape was clearing the origin's storage
 * from outside the app.
 */
describe("one turn request is bounded to the boundary's body limit", () => {
  const turn = (messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>) => ({
    runId: "turn-1",
    messages,
    instructions: "be snappy"
  })

  test("a request that already fits is passed through untouched", () => {
    const request = turn([{ role: "user", content: "hello" }])
    const bounded = boundTurnRequest(request)
    expect(bounded.dropped).toBe(0)
    expect(bounded.request).toBe(request)
  })

  test("the oldest messages are dropped until the turn fits, and the newest survives", () => {
    const long = "x".repeat(20_000)
    const request = turn([
      { role: "user", content: long },
      { role: "assistant", content: long },
      { role: "user", content: long },
      { role: "assistant", content: long },
      { role: "user", content: "and now say ok" }
    ])
    expect(turnRequestBytes(request)).toBeGreaterThan(MAX_TURN_REQUEST_BYTES)
    const bounded = boundTurnRequest(request)
    expect(bounded.dropped).toBeGreaterThan(0)
    expect(turnRequestBytes(bounded.request)).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
    expect(textOf(bounded.request.messages.at(-1))).toBe("and now say ok")
  })

  test("what was dropped is stated, never silently missing", () => {
    const long = "y".repeat(40_000)
    const bounded = boundTurnRequest(
      turn([
        { role: "user", content: long },
        { role: "assistant", content: long },
        { role: "user", content: "still here?" }
      ])
    )
    expect(textOf(bounded.request.messages[0])).toContain("dropped to fit this turn's size limit")
    expect(textOf(bounded.request.messages[0])).toContain("say you may no longer have it")
  })

  test("a tool leg's call and output are never split by the bound", () => {
    const long = "z".repeat(20_000)
    // Three context messages, then a two-message tool leg plus the prompt.
    const bounded = boundTurnRequest(
      turn([
        { role: "user", content: long },
        { role: "assistant", content: long },
        { role: "user", content: long },
        { role: "assistant", content: "call: issues.list" },
        { role: "user", content: "result: two issues" }
      ]),
      2
    )
    expect(turnRequestBytes(bounded.request)).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
    expect(bounded.request.messages.slice(-2).map(textOf)).toEqual([
      "call: issues.list",
      "result: two issues"
    ])
  })

  test("a single message over the limit is still sent, so the seam refuses it honestly", () => {
    // Dropping the user's own words to hide the refusal would be the worse
    // answer: the boundary's message already names what happened.
    const bounded = boundTurnRequest(turn([{ role: "user", content: "q".repeat(80_000) }]))
    expect(bounded.dropped).toBe(0)
    expect(bounded.request.messages).toHaveLength(1)
  })
})
