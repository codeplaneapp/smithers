/**
 * The turn entry the Durable Object calls. It defers loading the agent
 * runtime (`./turnImpl.ts` and everything under `@smthrs/*`) until the first
 * request: Cloudflare rejects a Worker whose module scope performs I/O, and
 * the runtime seeds identities at load. The lazy import also keeps the DO
 * cold start small.
 */
export type { TurnOptions, TurnSession } from "./turnImpl.ts"
import type { TurnOptions } from "./turnImpl.ts"

export const runTurn = (options: TurnOptions): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    async start(controller) {
      const { runTurn: run } = await import("./turnImpl.ts")
      const reader = run(options).getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      // The inner stream observes the caller's AbortSignal; nothing else to do.
      void reason
    }
  })
