/** A headers deadline expiring, distinguishable from caller cancellation. */
class UpstreamTimeoutError extends Error {
  readonly _tag = "UpstreamTimeoutError"

  constructor(readonly seam: string, readonly timeoutMs: number) {
    super(`${seam} did not answer within ${timeoutMs}ms.`)
    this.name = "UpstreamTimeoutError"
  }
}

const timeoutMs = (env: { readonly UPSTREAM_TIMEOUT_MS?: string }): number => {
  const configured = Number(env.UPSTREAM_TIMEOUT_MS ?? "")
  return Number.isFinite(configured) && configured > 0 ? configured : 20_000
}

/**
 * Bound the wait for headers, then release the timer so bodies can stream.
 * Caller cancellation remains connected to the response body after headers.
 */
const run = async (
  seam: string,
  fetchHeaders: (signal: AbortSignal) => Promise<Response>,
  durationMs: number,
  callerSignal?: AbortSignal
): Promise<Response> => {
  const deadline = new AbortController()
  const signal = callerSignal === undefined
    ? deadline.signal
    : AbortSignal.any([deadline.signal, callerSignal])
  const timer = setTimeout(() => deadline.abort(new UpstreamTimeoutError(seam, durationMs)), durationMs)
  try {
    signal.throwIfAborted()
    return await fetchHeaders(signal)
  } catch (error) {
    // Fetch implementations can reject with AbortError instead of the reason.
    // Preserve which signal won, including the effective timeout duration.
    if (signal.aborted) throw signal.reason
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export const upstreamDeadline = { run, timeoutMs, TimeoutError: UpstreamTimeoutError }
