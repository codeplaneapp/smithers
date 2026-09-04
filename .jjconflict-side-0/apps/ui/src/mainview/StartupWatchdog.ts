import { createStartupErrorElement, startupErrorMessage } from "./StartupError"
import { createClientErrorReporter } from "./state/ClientErrors"
import type { ClientErrorReporter } from "./state/ClientErrors"

export interface StartupWatchdogOptions {
  readonly timeoutMs: number
  readonly document?: Document
  readonly window?: Window
  readonly clientErrors?: ClientErrorReporter
}

export interface StartupWatchdog {
  /** The app mounted. Nothing after this renders a failure panel. */
  readonly markMounted: () => void
  /** React reported a boot failure and is rendering its own panel; stand down. */
  readonly handleRenderFailure: (error: unknown) => void
  readonly reportFailure: (error: unknown) => void
  readonly stop: () => void
}

/**
 * Guards the failure mode where the app never mounts. This intentionally lives
 * outside React, because a React that never runs cannot report itself.
 *
 * Mounting is an explicit signal, never inferred from the DOM. Both entries
 * fill `#root` before the app exists — the SPA renders a Suspense fallback into
 * it, and the server renders the session shell into it — so "is `#root` empty"
 * answers "no" from the first frame and would disable this guard entirely.
 */
export const startStartupWatchdog = (options: StartupWatchdogOptions): StartupWatchdog => {
  const documentTarget = options.document ?? document
  const windowTarget = options.window ?? window
  const clientErrors = options.clientErrors ?? createClientErrorReporter()
  let firstBootError: unknown
  let settled = false
  const remember = (error: unknown): void => {
    if (firstBootError !== undefined || settled) return
    firstBootError = error
  }
  const onError = (event: ErrorEvent): void => {
    const error = event.error ?? event.message
    remember(error)
    clientErrors.report("error", error)
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    remember(event.reason)
    clientErrors.report("unhandledrejection", event.reason)
  }
  windowTarget.addEventListener("error", onError)
  windowTarget.addEventListener("unhandledrejection", onRejection)
  const stop = (): void => {
    settled = true
    windowTarget.clearTimeout(timer)
    windowTarget.removeEventListener("error", onError)
    windowTarget.removeEventListener("unhandledrejection", onRejection)
  }
  const reportFailure = (reason: unknown): void => {
    if (settled) return
    stop()
    console.error("Smithers failed to start", reason, firstBootError)
    const root = documentTarget.getElementById("root") ?? documentTarget.body
    root.textContent = ""
    root.append(createStartupErrorElement(documentTarget, startupErrorMessage(reason, firstBootError)))
  }
  const timer = windowTarget.setTimeout(() => {
    reportFailure(new Error(`Smithers did not finish starting within ${options.timeoutMs}ms.`))
  }, options.timeoutMs)
  return {
    markMounted: stop,
    handleRenderFailure: (error) => {
      if (settled) return
      stop()
      console.error("Smithers failed to start", error, firstBootError)
      clientErrors.report("error", error)
    },
    reportFailure,
    stop
  }
}

/** How long a boot may take before the watchdog calls it a failure. */
export const DEFAULT_BOOT_TIMEOUT_MS = 15_000

let browserInstance: StartupWatchdog | undefined

/**
 * The one watchdog a browser page has.
 *
 * An entry starts it and the tree it renders reports into it, so both halves
 * address the same watch. Never called while rendering on the server: the
 * Start entry reaches it only inside `ClientOnly`.
 */
export const browserStartupWatchdog = (
  options: Partial<StartupWatchdogOptions> = {}
): StartupWatchdog => (browserInstance ??= startStartupWatchdog({ timeoutMs: DEFAULT_BOOT_TIMEOUT_MS, ...options }))
