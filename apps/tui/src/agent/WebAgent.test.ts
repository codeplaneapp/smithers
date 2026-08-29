import { describe, expect, test } from "bun:test"
import { TURN_PATH } from "smithers-shared/AgentApiRoutes"
import type { AgentTurnFrame, FetchLike, StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import { createWebAgent } from "./WebAgent"

const request: StartAgentTurnRequest = {
  runId: "run-1",
  messages: [{ role: "user", content: "hello" }],
  instructions: "answer briefly"
}

describe("createWebAgent", () => {
  test("decodes chunk-split boundary frames and rejects a foreign run", async () => {
    const encoder = new TextEncoder()
    const chunks = [
      "{\"runId\":\"other\",\"type\":\"delta\",\"kind\":\"text\",\"text\":\"wrong\"}\n" +
      "{\"runId\":\"run-1\",\"type\":\"delta\",\"kind\":\"text\",\"text\":\"hel",
      "lo\"}\n{\"runId\":\"run-1\",\"type\":\"done\",\"reason\":\"stop\"}"
    ]
    const calls: Array<{ readonly input: string; readonly init?: RequestInit }> = []
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ input: String(input), ...(init === undefined ? {} : { init }) })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
            controller.close()
          }
        }),
        { status: 200 }
      )
    }
    const frames: Array<AgentTurnFrame> = []
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const agent = createWebAgent(
      (frame) => {
        frames.push(frame)
        if (frame.type === "done") finish()
      },
      { baseUrl: "http://localhost:8787/", cookie: "session=test", fetchImpl }
    )

    expect(await agent.start(request)).toEqual({ status: "started" })
    await done

    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe(`http://localhost:8787${TURN_PATH}`)
    expect(calls[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      cookie: "session=test"
    })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(request)
    expect(frames).toEqual([
      { runId: "run-1", type: "delta", kind: "text", text: "hello" },
      { runId: "run-1", type: "done", reason: "stop" }
    ])
  })
})
