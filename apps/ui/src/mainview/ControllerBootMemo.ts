import type { BootSession } from "./BootSession"
import type { AppController } from "./state/AppController"

export const createControllerBoot = (
  load: (session?: BootSession) => Promise<AppController>
): (session?: BootSession) => Promise<AppController> => {
  let current: { readonly session: BootSession | undefined; readonly boot: Promise<AppController> } | undefined
  return (session?: BootSession): Promise<AppController> => {
    if (current === undefined || current.session !== session) {
      current = { session, boot: load(session) }
    }
    return current.boot
  }
}
