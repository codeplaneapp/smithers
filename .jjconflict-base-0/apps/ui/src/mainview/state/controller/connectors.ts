import type { RepositoryAccess } from "@smthrs/rpc/NativeRepository"
import type { ControllerContext } from "./context"

export interface ConnectorController {
  readonly connectLocalRepository: (access: RepositoryAccess) => Promise<void>
  readonly makeConnectorReadOnly: (id: string) => void
  readonly askConnectorRemoval: (id: string) => string | void
  readonly cancelConnectorRemoval: () => void
  readonly removeConnector: (id: string) => string | void
}

export const createConnectorController = (
  ctx: ControllerContext
): ConnectorController => {
  const { store, repositories } = ctx

  const connectLocalRepository = async (access: RepositoryAccess): Promise<void> => {
    const operation = store.collections.connectorOperations.get("connector-operation")
    if (operation?.phase !== "idle") return
    store.dispatch({ type: "connector.local.requested", actor: "user", access })
    try {
      const result = await repositories.pickLocalRepository(access)
      switch (result.status) {
        case "connected":
          store.dispatch({
            type: "connector.local.connected",
            actor: "system",
            access,
            repository: result.repository
          })
          break
        case "cancelled":
          store.dispatch({ type: "connector.local.cancelled", actor: "user" })
          break
        case "error":
          store.dispatch({
            type: "connector.local.failed",
            actor: "system",
            message: result.message
          })
          break
      }
    } catch {
      store.dispatch({
        type: "connector.local.failed",
        actor: "system",
        message: "The native repository picker stopped responding. Try again."
      })
    }
  }

  const makeConnectorReadOnly = (id: string): void => {
    store.dispatch({
      type: "connector.access.changed",
      actor: "user",
      id,
      access: "read"
    })
  }

  const askConnectorRemoval = (id: string): string | void => {
    if (store.collections.connectors.get(id) === undefined) return `There is no connector with id ${id}.`
    store.dispatch({ type: "connector.removal.asked", actor: "user", id })
  }

  const cancelConnectorRemoval = (): void => {
    if (store.session().pendingConnectorRemovalId === null) return
    store.dispatch({ type: "connector.removal.asked", actor: "user", id: null })
  }

  const removeConnector = (id: string): string | void => {
    if (store.session().pendingConnectorRemovalId !== id) return "Ask before disconnecting this repository."
    store.dispatch({ type: "connector.removed", actor: "user", id })
  }

  return {
    connectLocalRepository,
    makeConnectorReadOnly,
    askConnectorRemoval,
    cancelConnectorRemoval,
    removeConnector
  }
}
