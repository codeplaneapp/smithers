import { StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { unavailableBootSession } from "./BootSession"
import { controllerBootPromise, ControllerProvider } from "./ControllerProvider"
import { SessionShell } from "./SessionShell"
import { MountedSignal, StartupErrorBoundary } from "./StartupBoundary"
import { browserStartupWatchdog } from "./StartupWatchdog"
import { createAppFetch } from "./runtime/LocalSession"
import { createClientErrorReporter } from "./state/ClientErrors"
import "./index.css"

const session = unavailableBootSession()
const watchdog = browserStartupWatchdog({ clientErrors: createClientErrorReporter({ fetchImpl: createAppFetch() }) })

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StartupErrorBoundary onError={watchdog.handleRenderFailure}>
      <Suspense fallback={<SessionShell session={session} />}>
        <ControllerProvider boot={controllerBootPromise()}>
          <MountedSignal onMounted={watchdog.markMounted} />
          <App />
        </ControllerProvider>
      </Suspense>
    </StartupErrorBoundary>
  </StrictMode>
)
