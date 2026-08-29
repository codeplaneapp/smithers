import { Effect } from "effect"
import type { BootSession } from "./BootSession"
import { createAgentSeat } from "./chain/ChainRuntime"
import { nativeOpenExternal, nativeRepositories, nativeShellAvailable } from "./native/NativeBridge"
import { createAppFetch } from "./runtime/LocalSession"
import { createBrowserFrameHistory } from "./runtime/FrameHistory"
import { createRuntime, loadBootstrap, unavailableAgent, unavailableRepositories } from "./runtime/Runtime"
import { createAppController } from "./state/AppController"
import type { AppController } from "./state/AppController"
import { createAppStore } from "./state/AppStore"

const promiseEffect = <A>(label: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new Error(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`)
  })

/*
 * Browser-only boot. Promise-shaped factories enter the Effect program at
 * this boundary.
 *
 * The local app's chat is the HTTP agent against the local origin
 * (LOCAL-APP.md). The in-page chain runtime is NOT bound: it spends a model
 * through the login-gated /api/model/stream, which the local origin does not
 * serve, so binding it would route every anonymous turn to a dead seam.
 */
const bootProgram = (session: BootSession | undefined) =>
  Effect.gen(function*() {
    const http = yield* Effect.sync(() => createAppFetch())
    const bootstrap = yield* promiseEffect("load runtime bootstrap", () => loadBootstrap(http))
    const runtime = yield* Effect.sync(() => createRuntime({
      bootstrap,
      http,
      nativeRepositories,
      ...(nativeShellAvailable ? { nativeOpenExternal } : {})
    }))
    const store = yield* promiseEffect("create app store", () => createAppStore())
    const agent = yield* Effect.sync(() => createAgentSeat(runtime.backend.agent ?? unavailableAgent()))
    const controller = yield* Effect.sync(() =>
      createAppController(
        store,
        runtime.backend.local?.repositories ?? unavailableRepositories,
        agent,
        {
          fetchImpl: runtime.http,
          bootstrap: runtime.bootstrap,
          frameHistory: createBrowserFrameHistory(window),
          ...(runtime.shell.kind === "native" ? { openExternal: runtime.shell.openExternal } : {})
        }
      )
    )

    if (session === undefined) {
      if (runtime.backend.identity === undefined) {
        yield* promiseEffect("record unavailable identity", () => controller.adoptSession({
          state: "unavailable",
          login: null,
          allowlisted: false,
          admin: false
        }))
      } else {
        yield* promiseEffect("load identity session", () => controller.loadSession())
      }
      if (runtime.backend.local !== undefined) {
        yield* Effect.sync(() => void controller.loadRepos())
        yield* Effect.sync(() => void controller.loadHarnesses())
      }
      if (controller.handleAuthReturn(window.location.search)) {
        window.history.replaceState(null, "", window.location.pathname)
      }
      return controller
    }

    yield* promiseEffect("adopt identity session", () => controller.adoptSession(session))
    if (session.authFailed) {
      yield* Effect.sync(() => {
        controller.handleAuthReturn("?auth=failed")
      })
    }
    return controller
  })

export const runControllerBoot = (session?: BootSession): Promise<AppController> =>
  Effect.runPromise(bootProgram(session))
