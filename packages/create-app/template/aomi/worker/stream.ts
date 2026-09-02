/**
 * One cleanup path for a streamed response, guaranteed to run once.
 *
 * A turn's `busy` flag and its AbortController belong to the stream, not to the
 * request that returned it, so they have to be cleared where the stream ends.
 * `AppSession.turn` used to do that in a `TransformStream`'s `flush`, and
 * `flush` runs on exactly one of the three endings a stream has: it does not
 * run when the readable side is cancelled, and it does not run when the source
 * errors. A browser that navigated away therefore left `busy` true forever, and
 * every later turn on that session answered 409 until the Durable Object was
 * evicted.
 *
 * So this wrapper is an explicit `ReadableStream` rather than a transform: the
 * settle hook is called from close, from error, and from cancel, and a flag
 * makes it exactly once. Nothing here depends on `transformer.cancel`, which is
 * the hook that would have to be trusted otherwise.
 */

/**
 * What {@link track} calls as the stream ends.
 */
export interface TrackHooks {
  /** Runs exactly once, whichever way the stream ended: close, source error, or cancel. */
  readonly onSettle: () => void
  /**
   * Runs once before `onSettle` when the CONSUMER cancelled, with the reason.
   *
   * This is where a hangup turns into real cancellation: the session aborts the
   * turn's AbortController here, which is the signal the turn itself watches.
   */
  readonly onCancel?: (reason: unknown) => void
}

/**
 * Forwards `source` and runs `hooks.onSettle` exactly once, however it ends.
 */
export const track = (source: ReadableStream<Uint8Array>, hooks: TrackHooks): ReadableStream<Uint8Array> => {
  const reader = source.getReader()
  let settled = false
  const settle = (): void => {
    if (settled) return
    settled = true
    hooks.onSettle()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          settle()
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (cause) {
        // A source failure is the stream's ending too: settle before the error
        // reaches the consumer, or a failed provider call leaves the session
        // busy exactly the way a hangup used to.
        settle()
        controller.error(cause)
      }
    },
    async cancel(reason) {
      hooks.onCancel?.(reason)
      settle()
      await reader.cancel(reason)
    }
  })
}
