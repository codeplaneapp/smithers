import { Effect } from "effect"
import type { BootSession } from "./BootSession"
import { createAgentSeat } from "./chain/ChainRuntime"
import { createLocalAgent } from "./native/LocalAgent"
import { nativeOpenExternal, nativeRepositories } from "./native/NativeBridge"
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
    const store = yield* promiseEffect("create app store", () => createAppStore())
    const agent = yield* Effect.sync(() => createAgentSeat(createLocalAgent()))
    const controller = yield* Effect.sync(() =>
      createAppController(store, nativeRepositories, agent, { openExternal: nativeOpenExternal })
    )

    if (session === undefined) {
      yield* promiseEffect("load identity session", () => controller.loadSession())
      // The local server's repositories (the chrome's repo chip) and harness
      // table (the `+` menu); absent seams answer nothing.
      yield* Effect.sync(() => void controller.loadRepos())
      yield* Effect.sync(() => void controller.loadHarnesses())
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
