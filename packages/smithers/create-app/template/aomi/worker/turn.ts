/**
 * The turn entry the Durable Object calls. It defers loading the agent
 * runtime (`./turnImpl.ts` and everything under `@smthrs/*`) until the first
 * request: Cloudflare rejects a Worker whose module scope performs I/O, and
 * the runtime seeds identities at load. The lazy import also keeps the DO
 * cold start small.
 *
 * Cancellation propagates. The outer `cancel` used to be a no-op whose comment
 * claimed the inner stream watched the caller's AbortSignal, but that signal is
 * aborted only by an explicit `POST /api/agent/turn/cancel` and never by a
 * hangup, so a browser that navigated away left the inner stream reading and
 * the provider working. The reader is held here and cancelled instead, and a
 * cancel that lands while the dynamic import is still in flight is remembered
 * so the implementation is cancelled the moment it arrives.
 */
export type { TurnOptions, TurnSession } from "./turnImpl.ts"
import type { TurnOptions } from "./turnImpl.ts"

/**
 * Loads the turn implementation.
 *
 * Injectable for the same reason `RoutesBinOptions.write` and
 * `CachedModelTestOptions.routes` are: this wrapper's contract is forwarding
 * and cancellation, and proving that must not require the agent runtime, the
 * tools directory, or QuickJS.
 */
export type TurnLoader = () => Promise<{
  readonly runTurn: (options: TurnOptions) => ReadableStream<Uint8Array>
}>

export const runTurn = (
  options: TurnOptions,
  load: TurnLoader = () => import("./turnImpl.ts")
): ReadableStream<Uint8Array> => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let cancelled = false
  let reason: unknown
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Inside the try: a module that fails to load must error the stream
        // rather than reject `start` with nothing watching.
        const { runTurn: run } = await load()
        reader = run(options).getReader()
        if (cancelled) {
          await reader.cancel(reason)
          return
        }
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
    async cancel(next) {
      cancelled = true
      reason = next
      await reader?.cancel(next)
    }
  })
}
