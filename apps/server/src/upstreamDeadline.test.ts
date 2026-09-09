import { describe, expect, test } from "bun:test"
import { upstreamDeadline } from "./upstreamDeadline"

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe("upstreamDeadline", () => {
  test("uses the deployment duration, defaulting invalid settings to 20 seconds", () => {
    expect(upstreamDeadline.timeoutMs({ UPSTREAM_TIMEOUT_MS: "20" })).toBe(20)
    for (const value of [undefined, "", "0", "-1", "NaN", "Infinity"]) {
      expect(upstreamDeadline.timeoutMs({ UPSTREAM_TIMEOUT_MS: value })).toBe(20_000)
    }
  })

  test("retains the timeout reason even when fetch rejects with a generic AbortError", async () => {
    const result = upstreamDeadline.run("test service", (signal) => new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
    }), 20)
    expect(await result.catch((error: unknown) => error)).toMatchObject({
      _tag: "UpstreamTimeoutError",
      seam: "test service",
      timeoutMs: 20,
      message: "test service did not answer within 20ms."
    })
  })

  test.each([false, true])("preserves caller cancellation (already aborted: %s)", async (alreadyAborted) => {
    const caller = new AbortController()
    const reason = new Error("client disconnected")
    let calls = 0
    if (alreadyAborted) caller.abort(reason)
    const result = upstreamDeadline.run("test service", (signal) => {
      calls++
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
        caller.abort(reason)
      })
    }, 20, caller.signal)
    expect(await result.catch((error: unknown) => error)).toBe(reason)
    expect(calls).toBe(alreadyAborted ? 0 : 1)
  })

  test("disarms the timer at headers while preserving body streaming and later cancellation", async () => {
    const caller = new AbortController()
    let fetchSignal: AbortSignal | undefined
    let body: ReadableStreamDefaultController<Uint8Array> | undefined
    const response = await upstreamDeadline.run("test service", async (signal) => {
      fetchSignal = signal
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller } }))
    }, 20, caller.signal)
    await wait(40)
    expect(fetchSignal?.aborted).toBe(false)
    body!.enqueue(new TextEncoder().encode("late body"))
    body!.close()
    expect(await response.text()).toBe("late body")
    const reason = new Error("client left")
    caller.abort(reason)
    expect(fetchSignal?.aborted).toBe(true)
    expect(fetchSignal?.reason).toBe(reason)
  })

  test("clears the timer after transport failure", async () => {
    let fetchSignal: AbortSignal | undefined
    const failure = new Error("connection reset")
    const result = upstreamDeadline.run("test service", async (signal) => {
      fetchSignal = signal
      throw failure
    }, 20)
    expect(await result.catch((error: unknown) => error)).toBe(failure)
    await wait(40)
    expect(fetchSignal?.aborted).toBe(false)
  })
})
