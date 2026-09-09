import { lazy, StrictMode, Suspense } from "react"
import { controllerBootPromise, ControllerProvider } from "./ControllerProvider"
import { SessionShell } from "./SessionShell"
import { MountedSignal, StartupErrorBoundary } from "./StartupBoundary"
import { browserStartupWatchdog } from "./StartupWatchdog"
import { createAppFetch } from "./runtime/LocalSession"
import { createClientErrorReporter } from "./state/ClientErrors"
import "@fontsource/inter/400.css"
import "@fontsource/inter/500.css"
import "@fontsource/inter/600.css"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import "./index.css"

/*
 * The whole app as one React component, so every host mounts the same tree:
 * main.tsx renders it into `#root` for the Vite build the local origin and the
 * Electrobun shell serve, and the smithers.sh site renders it as a
 * `client:only` island at `/owner/name`. The startup watchdog is constructed
 * at module scope, as main.tsx always did, because a React that never runs
 * cannot report itself; importing this module arms it.
 */

const GuidedApp = lazy(() => import("./App").then(({ GuidedApp }) => ({ default: GuidedApp })))

const watchdog = browserStartupWatchdog({ clientErrors: createClientErrorReporter({ fetchImpl: createAppFetch() }) })

export default function AppIsland() {
  return (
    <StrictMode>
      <StartupErrorBoundary onError={watchdog.handleRenderFailure}>
        <SessionShell>
          <Suspense fallback={null}>
            <ControllerProvider boot={controllerBootPromise()}>
              <MountedSignal onMounted={watchdog.markMounted} />
              <GuidedApp />
            </ControllerProvider>
          </Suspense>
        </SessionShell>
      </StartupErrorBoundary>
    </StrictMode>
  )
}
