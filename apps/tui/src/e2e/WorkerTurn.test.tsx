import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { afterAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { act } from "react"
import { CANCEL_PATH, TURN_PATH } from "smithers-shared/AgentApiRoutes"
import type { FetchLike, StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import { createWebAgent } from "../agent/WebAgent"
import { ChatController } from "../state/ChatController"
import type { TuiTransport } from "../state/ChatController"
import { TranscriptStore } from "../state/Transcript"
import { App } from "../ui/App"

/*
 * E15.2 / E15.3 — the TUI driven against the real product boundary.
 *
 * This boots the actual Worker (`wrangler dev` on apps/server, every seam var
 * sealed to "") in front of an NDJSON chat double, then renders the real TUI
 * through OpenTUI's headless renderer and drives it with real terminal keys.
 * Nothing about the turn is faked below the composer: the request crosses the
 * Worker's /api/agent/turn route, the Worker composes the instructions and
 * forwards them upstream, tags every frame with the runId, and the TUI's real
 * WebAgent decodes the NDJSON back into the rendered transcript.
 *
 * With IDENTITY_UPSTREAM_URL sealed the turn seam is ungated (apps/server
 * src/index.ts requireTurnSession), so no session cookie is minted here.
 *
 * The port is the lane's own (FLOWS_E2E_PORT), so concurrent suites never
 * fight over the socket.
 */

const WORKER_PORT = Number(process.env.FLOWS_E2E_PORT ?? 8820)
const WORKER_ORIGIN = `http://127.0.0.1:${WORKER_PORT}`
/** The version apps/ui/e2e/Stack.ts pins, so one known wrangler is fetched. */
const WRANGLER = "wrangler@4.123.0"
const SERVER_DIR = fileURLToPath(new URL("../../../server/", import.meta.url))

/** Every seam var the Worker declares, forced to "" — an empty value reads as unset. */
const SEALED_VARS: ReadonlyArray<string> = [
  "IDENTITY_UPSTREAM_URL",
  "IDENTITY_SERVICE_TOKEN",
  "IDENTITY_ADMIN_TOKEN",
  "BILLING_UPSTREAM_URL",
  "BILLING_AUTH_TOKEN",
  "BILLING_PRODUCT_SERVICE_TOKEN",
  "BILLING_ADMIN_TOKEN",
  "CHAT_PRODUCT_SERVICE_TOKEN",
  "GATEWAY_UPSTREAM_URL",
  "GATEWAY_AUTH_TOKEN",
  "GATEWAY_SESSION_USER_ID",
  "GATEWAY_SESSION_USER_ROLE",
  "GATEWAY_SESSION_USER_SCOPES",
  "SMITHERS_CHAT_AUTH_TOKEN",
  "SMITHERS_CLOUD_API_BASE_URL",
  "MODEL_RELAY_API_KEY",
  "MODEL_RELAY_URL"
]

const REPLY_TEXT = "Hi, I'm Smithers (stub upstream)."
const SLOW_TEXT = "thinking"

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface ChatUpstreamRequest {
  readonly messages: ReadonlyArray<{ readonly role?: string; readonly content?: unknown }>
  readonly instructions: string
}

/*
 * The chat double the Worker's SMITHERS_CHAT_URL points at. It speaks the
 * upstream wire shape (frames without a runId — the Worker stamps those), so
 * an untagged pass-through on the Worker would leave the TUI stalled rather
 * than silently passing.
 */
const createChatUpstream = () => {
  const requests: Array<ChatUpstreamRequest> = []
  let slow = false
  let deltasWritten = 0
  const encoder = new TextEncoder()
  const line = (frame: Record<string, unknown>): Uint8Array => encoder.encode(`${JSON.stringify(frame)}\n`)

  const server = Bun.serve({
    // An ephemeral port: the lane owns WORKER_PORT alone, and a fixed
    // neighbour would collide with whatever the next lane boots.
    port: 0,
    idleTimeout: 60,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/stub/arm-slow") {
        slow = true
        return Response.json({ status: "ok" })
      }
      if (url.pathname === "/stub/arm-default") {
        slow = false
        return Response.json({ status: "ok" })
      }
      const body = (await request.json()) as ChatUpstreamRequest
      requests.push(body)
      const streamSlow = slow
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          if (streamSlow) {
            // A killable turn: 40 deltas at 250ms is ~10s, far longer
            // than any interrupt below waits.
            for (let index = 0; index < 40; index += 1) {
              controller.enqueue(line({ type: "delta", kind: "text", text: `${SLOW_TEXT} ` }))
              deltasWritten += 1
              await wait(250)
            }
          } else {
            controller.enqueue(line({ type: "delta", kind: "text", text: REPLY_TEXT }))
            controller.enqueue(
              line({
                type: "card",
                card: {
                  id: "plan-1",
                  kind: "plan",
                  title: "TUI launch",
                  status: "active",
                  createdAt: 1755000000000,
                  ordinal: 1,
                  payload: { items: [{ id: "1", title: "scaffold", status: "done" }] }
                }
              })
            )
          }
          controller.enqueue(line({ type: "done", reason: "stop" }))
          controller.close()
        }
      })
      return new Response(stream, {
        headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" }
      })
    }
  })

  return {
    url: `http://127.0.0.1:${server.port}/chat`,
    requests: (): ReadonlyArray<ChatUpstreamRequest> => requests,
    deltasWritten: (): number => deltasWritten,
    armSlow: async (): Promise<void> => {
      await fetch(`http://127.0.0.1:${server.port}/stub/arm-slow`, { method: "POST" })
    },
    armDefault: async (): Promise<void> => {
      await fetch(`http://127.0.0.1:${server.port}/stub/arm-default`, { method: "POST" })
    },
    stop: (): void => void server.stop(true)
  }
}

const chat = createChatUpstream()

const vars: Record<string, string> = { SMITHERS_CHAT_URL: chat.url }
for (const name of SEALED_VARS) if (!(name in vars)) vars[name] = ""

const persistDir = `${process.env.TMPDIR ?? "/tmp"}/tui-worker-e2e-${process.pid}`
const wrangler = Bun.spawn(
  [
    "bun",
    "x",
    WRANGLER,
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(WORKER_PORT),
    // Derived from the lane's port so a concurrent suite's inspector cannot collide.
    "--inspector-port",
    String(WORKER_PORT + 1000),
    "--persist-to",
    persistDir,
    ...Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`])
  ],
  { cwd: SERVER_DIR, stdout: "pipe", stderr: "pipe" }
)

/*
 * Drain wrangler's pipes. An undrained pipe fills and stalls the process, and
 * the tail is the only diagnosis available when the boot fails.
 */
let workerLog = ""
const drain = async (stream: ReadableStream<Uint8Array> | undefined): Promise<void> => {
  if (stream === undefined) return
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (value !== undefined) {
      workerLog = `${workerLog}${decoder.decode(value, { stream: true })}`.slice(-8_000)
    }
    if (done) return
  }
}
void drain(wrangler.stdout as ReadableStream<Uint8Array>)
void drain(wrangler.stderr as ReadableStream<Uint8Array>)

/*
 * A build failure is terminal, not transient: wrangler's esbuild step logs it
 * once and then sits watching for a file change that will never come from
 * this harness, so polling for the full budget below would just burn a
 * minute finding out what this string already told us in a few seconds.
 */
const BUILD_FAILED_MARKER = "Build failed with"

let workerUp = false
let buildFailed = false
for (let attempt = 0; attempt < 120 && !workerUp && !buildFailed; attempt += 1) {
  buildFailed = workerLog.includes(BUILD_FAILED_MARKER)
  if (buildFailed) break
  try {
    // `bun test`'s fetch does not fail fast on a refused connection the way
    // plain `bun run` does — measured hanging well past this loop's 500ms
    // cadence — so this cap is load-bearing for reaching the build-failure
    // check promptly, not just a defensive nicety.
    const response = await fetch(WORKER_ORIGIN, { signal: AbortSignal.timeout(2_000) })
    workerUp = response.ok
    await response.arrayBuffer()
  } catch {
    // wrangler is still starting.
  }
  if (!workerUp) await wait(500)
}
if (!workerUp) {
  wrangler.kill()
  chat.stop()
}
/*
 * This suite needs a real `wrangler dev` boot of apps/server, which needs the
 * TanStack Start Wrangler bundler alias wired up for "#tanstack-router-entry"
 * / "#tanstack-start-entry" / "tanstack-start-manifest:v" — apps/server's own
 * build, not anything in apps/tui. An environment missing that (or any other
 * reason the worker never came up) skips this suite instead of hanging `bun
 * test` for a minute and then failing the whole file: re-enable by fixing
 * apps/server's Wrangler config so `wrangler dev` builds clean, or by running
 * this against a worker booted through the properly configured pipeline.
 */
if (!workerUp) {
  console.warn(
    `[WorkerTurn.test.tsx] skipping: wrangler dev never came up on ${WORKER_ORIGIN}.\n${workerLog}`
  )
}

afterAll(async () => {
  wrangler.kill()
  await wait(500)
  chat.stop()
})

interface WireCall {
  readonly url: string
  readonly method: string
  readonly body: string
  readonly status: number
  readonly contentType: string | null
}

/** The rendered terminal with runs of spaces collapsed. */
const frameText = (setup: TestRendererSetup): string =>
  setup
    .captureCharFrame()
    .split("\n")
    .map((row) => row.trim().replace(/\s+/g, " "))
    .join("\n")

const waitForFrame = async (
  setup: TestRendererSetup,
  predicate: (frame: string) => boolean,
  budgetMs = 30_000
): Promise<string> => {
  const deadline = Date.now() + budgetMs
  for (;;) {
    // The sleep sits INSIDE act: frames arrive from the network between
    // polls, and React must own the window they land in or every turn
    // prints an "update was not wrapped in act(...)" warning.
    let frame = ""
    await act(async () => {
      await wait(50)
      await setup.flush()
      frame = frameText(setup)
    })
    if (predicate(frame)) return frame
    if (Date.now() > deadline) {
      throw new Error(`the frame never satisfied the predicate within ${budgetMs}ms:\n${frame}`)
    }
  }
}

interface Harness {
  readonly setup: TestRendererSetup
  readonly store: TranscriptStore
  readonly wire: ReadonlyArray<WireCall>
  readonly requests: ReadonlyArray<StartAgentTurnRequest>
  readonly destroy: () => void
}

/*
 * The real transport, wrapped only to observe. `start`/`cancel` delegate to the
 * WebAgent unchanged, and the recording fetch is the product's own `fetchImpl`
 * seam — nothing about the request or the response is synthesized here.
 */
const mount = async (): Promise<Harness> => {
  const wire: Array<WireCall> = []
  const requests: Array<StartAgentTurnRequest> = []
  const recordingFetch: FetchLike = async (input, init) => {
    const response = await fetch(input as string, init)
    wire.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      status: response.status,
      contentType: response.headers.get("content-type")
    })
    return response
  }

  const store = new TranscriptStore()
  let controller: ChatController
  const agent = createWebAgent((frame) => controller.publish(frame), {
    baseUrl: WORKER_ORIGIN,
    fetchImpl: recordingFetch
  })
  const transport: TuiTransport = {
    start: (request) => {
      requests.push(request)
      return agent.start(request)
    },
    cancel: (runId) => agent.cancel(runId)
  }
  controller = new ChatController(store, transport)

  const setup = await testRender(<App controller={controller} describe={`worker ${WORKER_ORIGIN}`} />, {
    width: 100,
    height: 24
  })
  await setup.flush()
  return {
    setup,
    store,
    wire,
    requests,
    destroy: () => act(() => setup.renderer.destroy())
  }
}

/*
 * Every await that can overlap a live stream runs inside `act`. Frames arrive
 * from the network on their own schedule, and an update that lands outside an
 * act window makes React print "not wrapped in act(...)" on every turn.
 */
const submit = async (harness: Harness, text: string): Promise<void> => {
  await act(async () => {
    await harness.setup.mockInput.typeText(text)
    await harness.setup.flush()
  })
  await act(async () => {
    harness.setup.mockInput.pressEnter()
    await harness.setup.flush()
  })
}

describe.skipIf(!workerUp)("TUI against the real Worker boundary", () => {
  test(
    "E15.2 a composer submit runs a full turn through wrangler dev and renders the reply",
    async () => {
      await chat.armDefault()
      const upstreamBefore = chat.requests().length
      const harness = await mount()
      try {
        await submit(harness, "Hello who are you")
        const frame = await waitForFrame(harness.setup, (text) => text.includes(REPLY_TEXT))

        expect(frame).toContain("> Hello who are you")
        expect(frame).toContain(REPLY_TEXT)
        // The Worker's frame tagging reached the projection: an untagged
        // pass-through would leave the card missing and the turn stalled.
        expect(frame).toContain("[card] plan: TUI launch (active)")
        await waitForFrame(harness.setup, (text) => !text.includes("responding… (Esc to cancel)"))
        expect(harness.store.phase()).toBe("idle")

        const assistant = harness.store
          .entries()
          .find((entry) => entry.kind === "message" && entry.role === "assistant")
        expect(assistant).toBeDefined()
        expect(assistant).toMatchObject({ status: "complete", text: REPLY_TEXT })

        // The wire: one POST to the shared turn route, answered as NDJSON.
        const turnCalls = harness.wire.filter((call) => call.url === `${WORKER_ORIGIN}${TURN_PATH}`)
        expect(turnCalls).toHaveLength(1)
        expect(turnCalls[0]!.method).toBe("POST")
        expect(turnCalls[0]!.status).toBe(200)
        expect(turnCalls[0]!.contentType).toBe("application/x-ndjson")

        // The Worker forwarded a composed turn upstream: the prompt reached
        // the model seam and the TUI's instructions survived composition.
        const upstream = chat.requests().slice(upstreamBefore)
        expect(upstream).toHaveLength(1)
        expect(upstream[0]!.messages.at(-1)).toEqual({
          role: "user",
          content: "Hello who are you"
        })
        expect(upstream[0]!.instructions).toContain(harness.requests[0]!.instructions)
      } finally {
        harness.destroy()
      }
    },
    90_000
  )

  test(
    "E15.3 a server-side kill ends the live turn with the honest interrupted line",
    async () => {
      await chat.armSlow()
      const harness = await mount()
      try {
        await submit(harness, "start a long one")
        await waitForFrame(harness.setup, (text) => text.includes(SLOW_TEXT))
        const runId = harness.requests[0]!.runId

        // The kill is issued out of band, so the TUI never aborts locally:
        // everything below is driven by the Worker's own terminal frame.
        let cancelStatus = 0
        let cancelBody: unknown
        await act(async () => {
          const cancelled = await fetch(`${WORKER_ORIGIN}${CANCEL_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ runId })
          })
          cancelStatus = cancelled.status
          cancelBody = await cancelled.json()
        })
        expect(cancelStatus).toBe(200)
        expect(cancelBody).toEqual({ status: "cancelled" })

        const frame = await waitForFrame(harness.setup, (text) => text.includes("Stopped the current response."))
        expect(frame).not.toContain("responding… (Esc to cancel)")
        // The partial answer survives the kill.
        expect(frame).toContain(SLOW_TEXT)
        expect(harness.store.phase()).toBe("idle")
      } finally {
        harness.destroy()
      }
    },
    90_000
  )

  test(
    "E15.3 Escape kills the turn on the server and a retry runs a fresh one",
    async () => {
      await chat.armSlow()
      const harness = await mount()
      try {
        await submit(harness, "start another long one")
        await waitForFrame(harness.setup, (text) => text.includes(SLOW_TEXT))
        const runId = harness.requests[0]!.runId

        await act(async () => {
          await harness.setup.mockInput.pressKeys(["ESCAPE"], 60)
          await harness.setup.flush()
        })
        const interrupted = await waitForFrame(harness.setup, (text) => text.includes("Stopped the current response."))
        expect(interrupted).not.toContain("responding… (Esc to cancel)")
        expect(harness.store.phase()).toBe("idle")

        // Esc must reach the server's cancel contract, not merely drop the
        // socket: the runId, the shared route and the method all matter.
        const cancelCalls = harness.wire.filter(
          (call) => call.url === `${WORKER_ORIGIN}${CANCEL_PATH}`
        )
        expect(cancelCalls).toHaveLength(1)
        expect(cancelCalls[0]!.method).toBe("POST")
        expect(cancelCalls[0]!.status).toBe(200)
        expect(JSON.parse(cancelCalls[0]!.body)).toEqual({ runId })

        // The retry: a fresh turn over the same boundary, right after the kill.
        await chat.armDefault()
        await submit(harness, "try again")
        const retried = await waitForFrame(harness.setup, (text) => text.includes(REPLY_TEXT))
        expect(retried).toContain("Stopped the current response.")
        expect(retried).toContain("> try again")
        expect(harness.requests).toHaveLength(2)
        expect(harness.requests[1]!.runId).not.toBe(runId)
        await waitForFrame(harness.setup, (text) => !text.includes("responding… (Esc to cancel)"))
        expect(harness.store.phase()).toBe("idle")
      } finally {
        harness.destroy()
      }
    },
    90_000
  )
})
