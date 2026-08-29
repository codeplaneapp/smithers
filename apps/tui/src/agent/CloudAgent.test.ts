import { describe, expect, test } from "bun:test"
import type { AgentTurnFrame, FetchLike, StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import { createCloudAgent } from "./CloudAgent"

const request: StartAgentTurnRequest = {
  runId: "run-1",
  messages: [{ role: "user", content: "hello" }],
  instructions: "answer briefly"
}

const stream = (text: string): FetchLike => async () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      }
    })
  )

const run = async (text: string): Promise<ReadonlyArray<AgentTurnFrame>> => {
  const frames: Array<AgentTurnFrame> = []
  await new Promise<void>((resolve) => {
    const agent = createCloudAgent(
      (frame) => {
        frames.push(frame)
        if (frame.type === "done") resolve()
      },
      { fetchImpl: stream(text) }
    )
    expect(agent.start(request)).toEqual({ status: "started" })
  })
  return frames
}

describe("createCloudAgent", () => {
  test("reports a truncated stream as a failed turn", async () => {
    const frames = await run("{\"type\":\"delta\",\"kind\":\"text\",\"text\":\"partial\"}\n")
    expect(frames).toEqual([
      { runId: "run-1", type: "delta", kind: "text", text: "partial" },
      {
        runId: "run-1",
        type: "done",
        error: "The response stream ended before Smithers Cloud finished the turn."
      }
    ])
  })

  test("reports malformed frames instead of silently completing", async () => {
    const frames = await run("not-json\n")
    expect(frames).toEqual([
      { runId: "run-1", type: "done", error: "Smithers Cloud returned a malformed stream frame." }
    ])
  })
})
