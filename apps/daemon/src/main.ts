import { getLogger } from "@/logging/logger"
import { createApp } from "@/server/app"
import {
  shutdownWorkspaceSmithersInstances,
  warmWorkspaceSmithersInstances,
} from "@/services/smithers-instance-service"
import { initializeWorkspaceService, listWorkspaces } from "@/services/workspace-service"

const bootstrapLogger = getLogger().child({ component: "bootstrap" })

bootstrapLogger.info({ event: "daemon.startup.begin" }, "Starting Mr. Burns daemon")

initializeWorkspaceService()
void warmWorkspaceSmithersInstances(listWorkspaces())

const app = createApp()
const server = Bun.serve(app)

let stopping = false

async function shutdown(signal: "SIGINT" | "SIGTERM") {
  if (stopping) {
    return
  }

  stopping = true
  bootstrapLogger.info({ event: "daemon.shutdown.begin", signal }, "Shutting down Mr. Burns daemon")

  try {
    await shutdownWorkspaceSmithersInstances()
    server.stop(true)
    bootstrapLogger.info({ event: "daemon.shutdown.complete", signal }, "Mr. Burns daemon stopped")
    process.exit(0)
  } catch (error) {
    bootstrapLogger.error(
      { event: "daemon.shutdown.failed", signal, err: error },
      "Failed shutting down daemon cleanly"
    )
    process.exit(1)
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT")
})

process.on("SIGTERM", () => {
  void shutdown("SIGTERM")
})

bootstrapLogger.info(
  {
    event: "daemon.startup.complete",
    port: app.port,
    url: `http://localhost:${app.port}`,
    hasFetchHandler: typeof server.fetch === "function",
  },
  "Mr. Burns daemon is listening"
)
