import { describe, expect, test } from "bun:test"
import type { Card } from "smithers-shared/Cards"
import type { AgentTurnFrame, StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import { createWebAgent } from "./WebAgent"

const request: StartAgentTurnRequest = {
  runId: "run-1",
  messages: [{ role: "user", content: "Hello who are you" }],
  instructions: "Be brief."
}

const ndjsonResponse = (lines: ReadonlyArray<unknown>, init?: ResponseInit): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
        controller.close()
      }
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" }, ...init }
  )

const collect = (): { frames: AgentTurnFrame[]; push: (frame: AgentTurnFrame) => void } => {
  const frames: AgentTurnFrame[] = []
  return { frames, push: (frame) => frames.push(frame) }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("createWebAgent", () => {
  test("posts the turn to the same-origin boundary and streams frames to subscribers", async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const agent = createWebAgent({
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
        return ndjsonResponse([
          { runId: "run-1", type: "delta", kind: "reasoning", text: "thinking" },
          { runId: "run-1", type: "delta", kind: "text", text: "Hi, I'm Smithers." },
          { runId: "run-1", type: "done" }
        ])
      }
    })
    const { frames, push } = collect()
    agent.subscribe(push)

    const result = await agent.startTurn(request)
    expect(result).toEqual({ status: "started" })
    await flush()

    expect(calls[0]?.url).toBe("/api/agent/turn")
    expect(calls[0]?.body).toEqual(request)
    expect(frames).toEqual([
      { runId: "run-1", type: "delta", kind: "reasoning", text: "thinking" },
      { runId: "run-1", type: "delta", kind: "text", text: "Hi, I'm Smithers." },
      { runId: "run-1", type: "done" }
    ])
  })

  test("drops frames for other runs and malformed lines without failing the turn", async () => {
    const agent = createWebAgent({
      fetchImpl: async () =>
        ndjsonResponse([
          "not-json",
          { runId: "other-run", type: "delta", kind: "text", text: "stray" },
          { runId: "run-1", type: "delta", kind: "text", text: "kept" },
          { runId: "run-1", type: "done" }
        ])
    })
    const { frames, push } = collect()
    agent.subscribe(push)

    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await flush()
    expect(frames).toEqual([
      { runId: "run-1", type: "delta", kind: "text", text: "kept" },
      { runId: "run-1", type: "done" }
    ])
  })

  test("a stream that ends without a done frame is an honest failure, not a silent stall", async () => {
    const agent = createWebAgent({
      fetchImpl: async () => ndjsonResponse([{ runId: "run-1", type: "delta", kind: "text", text: "partial" }])
    })
    const { frames, push } = collect()
    agent.subscribe(push)

    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await flush()
    expect(frames[frames.length - 1]).toEqual({
      runId: "run-1",
      type: "done",
      error: "The response stream ended before Smithers finished the turn."
    })
  })

  test("returns an honest error when the boundary responds with an HTTP failure", async () => {
    const agent = createWebAgent({
      fetchImpl: async () => new Response("upstream exploded", { status: 502 })
    })
    const result = await agent.startTurn(request)
    expect(result.status).toBe("error")
    if (result.status === "error") {
      expect(result.message).toContain("HTTP 502")
      expect(result.message).toContain("upstream exploded")
    }
  })

  test("returns an error when the boundary is unreachable", async () => {
    const agent = createWebAgent({
      fetchImpl: async () => {
        throw new Error("connection refused")
      }
    })
    const result = await agent.startTurn(request)
    expect(result).toEqual({
      status: "error",
      message: "Could not reach the Smithers web agent: connection refused"
    })
  })

  test("cancelTurn aborts the local stream and notifies the server boundary", async () => {
    const calls: string[] = []
    const agent = createWebAgent({
      fetchImpl: async (input) => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith("/cancel")) return new Response("{}", { status: 200 })
        return new Response(new ReadableStream<Uint8Array>({ start: () => {} }), {
          status: 200
        })
      }
    })
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await agent.cancelTurn("run-1")
    expect(calls).toContain("/api/agent/turn/cancel")
  })

  test("cancelTurn aborts a turn that is still waiting on the boundary to respond", async () => {
    let aborted = false
    const agent = createWebAgent({
      fetchImpl: (input, init) => {
        if (String(input).endsWith("/cancel")) return Promise.resolve(new Response("{}"))
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true
            reject(new DOMException("The operation was aborted.", "AbortError"))
          })
        })
      }
    })
    const started = agent.startTurn(request)
    await Promise.resolve()
    await agent.cancelTurn("run-1")
    expect(aborted).toBe(true)
    // The user stopped the turn, so this is not reported back as a failed turn.
    expect((await started).status).toBe("started")
  })

  test("surfaces the boundary's JSON error message rather than a raw JSON body", async () => {
    const agent = createWebAgent({
      fetchImpl: async () =>
        new Response(JSON.stringify({ status: "error", message: "That turn is already running." }), {
          status: 409,
          headers: { "content-type": "application/json" }
        })
    })
    const result = await agent.startTurn(request)
    expect(result).toEqual({
      status: "error",
      message: "Smithers web agent failed (HTTP 409): That turn is already running."
    })
  })

  /*
   * §24.3 — the app's honesty must not depend on every upstream writing
   * user-facing prose. A model provider answers a nested wire error and a
   * Worker crash answers an HTML page; both used to be pasted into the chat.
   */
  test("a provider rate-limit body is classified, never pasted into the chat", async () => {
    const agent = createWebAgent({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "rate_limit_error",
              message: "Number of request tokens has exceeded your per-minute rate limit"
            }
          }),
          { status: 429, headers: { "content-type": "application/json" } }
        )
    })
    const result = await agent.startTurn(request)
    const message = result.status === "error" ? result.message : ""
    expect(message).toContain("rate-limiting")
    expect(message).toContain("429")
    expect(message).not.toContain("rate_limit_error")
    expect(message).not.toContain("{")
  })

  test("a Cloudflare HTML error page never reaches the transcript", async () => {
    const agent = createWebAgent({
      fetchImpl: async () =>
        new Response("<!DOCTYPE html><html><body>Error 1101 Worker threw exception</body></html>", {
          status: 500,
          headers: { "content-type": "text/html" }
        })
    })
    const result = await agent.startTurn(request)
    const message = result.status === "error" ? result.message : ""
    expect(message).toContain("500")
    expect(message).not.toContain("<")
    expect(message).not.toContain("1101")
  })

  /*
   * The turn ceiling's refusal is written to be read by a person: it names a
   * loop and says nothing was charged, because someone who trips it hit a bug
   * and must never be sent to billing. That is only true if the sentence
   * actually reaches the transcript, which is what this pins.
   */
  test("surfaces the turn ceiling's refusal verbatim, so the user reads the real reason", async () => {
    const agent = createWebAgent({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            status: "error",
            code: "turn_rate_limited",
            message:
              "That is more than 1000 model calls in an hour, which no conversation reaches by hand — something is looping. Chat resumes on its own in about 12 minutes. Nothing was charged and your balance is untouched."
          }),
          { status: 429, headers: { "content-type": "application/json", "retry-after": "720" } }
        )
    })
    const result = await agent.startTurn(request)
    expect(result.status).toBe("error")
    expect(result.status === "error" ? result.message : "").toContain("something is looping")
    expect(result.status === "error" ? result.message : "").toContain("balance is untouched")
    expect(result.status === "error" ? result.message : "").not.toContain("upgrade")
  })

  test("rejects a duplicate runId while a turn is active", async () => {
    const agent = createWebAgent({
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ start: () => {} }), { status: 200 })
    })
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    const duplicate = await agent.startTurn(request)
    expect(duplicate.status).toBe("error")
  })

  test("passes card frames from the boundary through to subscribers", async () => {
    const statusCard: Card = {
      id: "card-status",
      kind: "status",
      title: "Working",
      status: "active",
      createdAt: 1,
      ordinal: 1,
      payload: { progress: 0.5 }
    }
    const agent = createWebAgent({
      fetchImpl: async () =>
        ndjsonResponse([
          { runId: "run-1", type: "card", card: statusCard },
          { runId: "run-1", type: "card", card: { id: "card-bad", kind: "nonsense" } },
          { runId: "run-1", type: "done" }
        ])
    })
    const { frames, push } = collect()
    agent.subscribe(push)

    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await flush()
    expect(frames).toEqual([
      { runId: "run-1", type: "card", card: statusCard },
      { runId: "run-1", type: "done" }
    ])
  })
})
