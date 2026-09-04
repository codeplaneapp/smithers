/**
 * The lazy turn wrapper, driven with an injected loader.
 *
 * `worker/turn.ts` defers importing the agent runtime until the first request,
 * so the real loader pulls in `@smthrs/*`, QuickJS, and the tools directory.
 * The wrapper's own contract has nothing to do with any of that: it forwards
 * the inner stream, and it must stop the inner stream when the consumer hangs
 * up. Its `cancel` used to be a no-op with a comment claiming the inner stream
 * watched the caller's AbortSignal, which only an explicit cancel request ever
 * aborted, so a hangup left the provider running.
 */
import { describe, expect, it } from "vitest"
import { runTurn, type TurnOptions } from "../worker/turn.ts"

// The wrapper reads no field of its options; it hands them straight to the
// loaded implementation. So a test supplies a marker rather than a whole fake
// session, and asserts the marker arrived.
const marker = { probe: "turn-options" } as unknown as TurnOptions

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** An inner stream that records the cancel reason its consumer sent. */
const innerStream = (
  chunks: ReadonlyArray<string>
): { readonly stream: ReadableStream<Uint8Array>; readonly cancels: Array<unknown> } => {
  const cancels: Array<unknown> = []
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes(chunks[index]!))
      index += 1
    },
    cancel(reason) {
      cancels.push(reason)
    }
  })
  return { stream, cancels }
}

const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}

describe("runTurn", () => {
  it("forwards the loaded implementation's stream and hands it the options", async () => {
    const seen: Array<TurnOptions> = []
    const inner = innerStream(["{\"type\":\"text\"}\n", "{\"type\":\"done\"}\n"])
    const text = await drain(runTurn(marker, async () => ({
      runTurn: (options: TurnOptions) => {
        seen.push(options)
        return inner.stream
      }
    })))
    expect(text).toBe("{\"type\":\"text\"}\n{\"type\":\"done\"}\n")
    expect(seen).toEqual([marker])
  })

  it("cancels the inner stream when the consumer hangs up", async () => {
    const inner = innerStream(["one", "two", "three"])
    const reader = runTurn(marker, async () => ({ runTurn: () => inner.stream })).getReader()
    await reader.read()
    await reader.cancel("client gone")
    expect(inner.cancels).toEqual(["client gone"])
  })

  it("cancels an implementation that only arrives after the hangup, and enqueues nothing", async () => {
    const inner = innerStream(["never delivered"])
    let deliver: (() => void) | undefined
    const loaded = new Promise<void>((resolve) => (deliver = resolve))
    const stream = runTurn(marker, async () => {
      await loaded
      return { runTurn: () => inner.stream }
    })
    const reader = stream.getReader()
    // Cancel while the loader is still pending: the wrapper holds no reader yet.
    await reader.cancel("client gone")
    deliver!()
    // One turn of the event loop is enough for the pending loader to settle and
    // for the wrapper to cancel what it was handed.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(inner.cancels).toEqual(["client gone"])
  })

  it("errors the stream when the implementation cannot be loaded", async () => {
    const stream = runTurn(marker, () => Promise.reject(new Error("module missing")))
    await expect(drain(stream)).rejects.toThrow("module missing")
  })
})
