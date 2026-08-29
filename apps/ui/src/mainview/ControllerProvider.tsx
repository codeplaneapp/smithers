import { use } from "react"
import type { ReactNode } from "react"
import type { BootSession } from "./BootSession"
import { createControllerBoot } from "./ControllerBootMemo"
import { ControllerContext } from "./ControllerContext"
import type { AppController } from "./state/AppController"

/*
 * The boot module is reached through a dynamic import, not a static one. This
 * module is rendered on the server by the Start entry (`routes/__root.tsx`),
 * and the boot chain reaches `electrobun/view`, which reads `window` while its
 * own module body evaluates — a static import therefore throws "window is not
 * defined" before any component runs. The import happens when a browser asks
 * to boot, which is the only place a controller exists.
 */
export const controllerBootPromise = createControllerBoot((session?: BootSession) =>
  import("./ControllerBoot.client").then(({ runControllerBoot }) => runControllerBoot(session))
)

export function ControllerProvider({
  boot,
  children
}: {
  readonly boot: Promise<AppController>
  readonly children: ReactNode
}) {
  const controller = use(boot)
  return <ControllerContext value={controller}>{children}</ControllerContext>
}
