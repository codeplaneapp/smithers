import { STORAGE_RECOVERY_EXPORT } from "../../flows/StorageRecoveryFlow"
import { createRecoveryDownload } from "../BrowserStorageRecovery"
import {
  createStorageRecoveryAction,
  RECOVERY_DOWNLOAD_LABEL,
  RECOVERY_PRIVATE_WARNING
} from "../StorageRecoveryAction"
import type { ControllerContext } from "./context"

export const createStorageRecoveryController = (ctx: ControllerContext) => {
  let browserDownload: ReturnType<typeof createRecoveryDownload> | undefined
  const action = createStorageRecoveryAction(
    ctx.services.storageRecoveryHost ?? {
      read: () => ctx.store.readRecovery(),
      download: (json) => (browserDownload ??= createRecoveryDownload()).download(json)
    },
    ctx.commandActor
  )
  ctx.onDispose(async () => {
    try {
      await action.dispose()
    } finally {
      browserDownload?.dispose()
    }
  })
  return {
    storageRecoveryState: action.state,
    exportStorageRecovery: action.run,
    promptStorageRecovery: async (): Promise<void> => {
      await ctx.store.dispatch({
        type: "message.appended",
        actor: ctx.commandActor,
        text: RECOVERY_PRIVATE_WARNING,
        action: { flow: STORAGE_RECOVERY_EXPORT, label: RECOVERY_DOWNLOAD_LABEL }
      }).isPersisted.promise
    }
  }
}
