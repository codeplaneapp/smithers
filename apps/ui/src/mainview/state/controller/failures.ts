import type { CommandOutcome } from "../../flows/Commands"
import type { ControllerContext } from "./context"

/**
 * Launch Checklist D-4's exhausted-balance refusal, shared between the
 * `zeroBalanceGuard` that dispatches it as a transcript message and
 * `surfaceCommandFailure`, which recognizes it to skip its toast (the
 * refusal is already an embedded chat message; a toast would double-surface
 * it). Names the upgrade path per the definition of done: "how to proceed".
 */
export const ZERO_BALANCE_EXHAUSTED_TEXT =
  "Balance is at $0 — workflow runs pause until more balance is added. Run /billing.upgrade to add balance; chat stays free in the meantime."

export interface FailureController {
  readonly withToast: <T>(
    key: string,
    title: string,
    doneTitle: string,
    work: () => Promise<T | string>
  ) => Promise<T | string>
  readonly dismissToast: (id: string) => void
  readonly surfaceCommandFailure: (name: string, outcome: CommandOutcome) => void
}

export const createFailureController = (ctx: ControllerContext): FailureController => {
  /*
   * The 300ms toast law (2026-08-09): background work not settled within
   * 300ms states what is running on the shared toast stack; work under
   * 300ms never flashes anything. `work` answers true on success or the
   * honest failure line — a failure toast stays until dismissed, an ok
   * toast resolves into the result and dismisses itself.
   */
  /*
   * One toast per flow key, so a re-run of the same flow owns the slot: the
   * run counter keeps a finished run from resolving OR auto-dismissing the
   * toast a newer run is using — a running notice must never silently vanish
   * while the work it names is still in flight.
   */
  const withToast = async <T>(
    key: string,
    title: string,
    doneTitle: string,
    work: () => Promise<T | string>
  ): Promise<T | string> => {
    const run = (ctx.toastRuns.get(key) ?? 0) + 1
    ctx.toastRuns.set(key, run)
    let shown = false
    const debounce = setTimeout(() => {
      if (ctx.toastRuns.get(key) !== run) return
      shown = true
      ctx.store.dispatch({ type: "toast.shown", actor: "system", key, title })
    }, ctx.toastDebounceMs)
    ctx.unref(debounce)
    let outcome: T | string
    try {
      outcome = await work()
    } catch {
      // A thrown flow is still an honest failure — never a toast stuck "running".
      outcome = `${title.replace(/…$/, "")} didn't finish — the app hit an unexpected error.`
    } finally {
      clearTimeout(debounce)
    }
    // A newer run of the same flow owns the toast now; this one reports nothing.
    if (ctx.toastRuns.get(key) !== run) return outcome
    // Resolve whatever is on screen for this key — including a toast an
    // earlier (slower) run put up, or a failed one this run just retried.
    if (!shown && ctx.store.collections.toasts.get(`toast-${key}`) === undefined) {
      // Settled with nothing ever shown: the run slot is terminal, so the
      // counter entry leaves with it (the map otherwise grows one entry per
      // flow key and never lets go).
      ctx.toastRuns.delete(key)
      return outcome
    }
    // A string outcome is the honest failure line; anything else is success
    // (true, or a value the caller consumes — e.g. the browser tool's read).
    const ok = typeof outcome !== "string"
    ctx.store.dispatch({
      type: "toast.resolved",
      actor: "system",
      key,
      status: ok ? "ok" : "failed",
      // Settled work states its result, never the running sentence: an ok
      // toast reads as done for the seconds before it dismisses itself, and
      // a failure keeps the attempt's title with the honest line under it.
      ...(ok ? { title: doneTitle } : {}),
      detail: ok ? "" : (outcome as string)
    })
    if (ok) {
      const dismiss = setTimeout(() => {
        if (ctx.toastRuns.get(key) !== run) return
        ctx.store.dispatch({ type: "toast.dismissed", actor: "system", id: `toast-${key}` })
        // The auto-dismiss is the slot's terminal act: the counter entry
        // leaves once nothing stale can claim it. A newer run owns the key
        // by then, and the equality guard above already returned for it.
        ctx.toastRuns.delete(key)
      }, ctx.toastAutoDismissMs)
      ctx.unref(dismiss)
    } else {
      // A failure toast stays until dismissed, but the run that produced it
      // is over — its counter entry is terminal and leaves now. The toast
      // itself is keyed `toast-${key}` in the collection, so a later run of
      // the same flow still resolves it through the line above.
      ctx.toastRuns.delete(key)
    }
    return outcome
  }

  const dismissToast = (id: string): void => {
    ctx.store.dispatch({ type: "toast.dismissed", actor: "user", id })
  }

  /*
   * A failed flow has no channel of its own to answer into — dropping the
   * outcome reads as a silent no-op (the "did it even run?" bug). Every
   * invocation the human makes — a pointer press OR a name typed into the
   * composer — states its refusal as a toast; executes that render their own
   * error UI return void and never reach this. The zero-balance refusal is
   * the one exception: `zeroBalanceGuard` already dispatched it as an
   * embedded transcript message, so toasting it too would double-surface the
   * same refusal.
   */
  const surfaceCommandFailure = (name: string, outcome: CommandOutcome): void => {
    if (outcome.status !== "failed") return
    if (outcome.error === ZERO_BALANCE_EXHAUSTED_TEXT) return
    const key = `command.failed.${name}`
    ctx.store.dispatch({ type: "toast.shown", actor: "system", key, title: `/${name} didn't run` })
    ctx.store.dispatch({ type: "toast.resolved", actor: "system", key, status: "failed", detail: outcome.error })
  }

  return { withToast, dismissToast, surfaceCommandFailure }
}
