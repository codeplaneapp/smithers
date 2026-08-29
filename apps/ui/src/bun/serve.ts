/*
 * The local server without a window: what the Playwright T1 tier boots
 * (`bun src/bun/serve.ts`). Reads SMITHERS_LOCAL_PORT (default 0 = random)
 * and SMITHERS_CHAT_STUB, serves apps/ui/dist (or SMITHERS_DIST_DIR), and
 * prints SMITHERS_LOCAL_ORIGIN=http://127.0.0.1:<port> when listening.
 */
import { defaultDistDir, startLocalServer } from "./server"

const port = Number(Bun.env.SMITHERS_LOCAL_PORT ?? "0")
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`SMITHERS_LOCAL_PORT must be a port number, got ${JSON.stringify(Bun.env.SMITHERS_LOCAL_PORT)}`)
  process.exit(2)
}

const server = await startLocalServer({
  port,
  distDir: defaultDistDir(import.meta.dir),
  chatStub: Bun.env.SMITHERS_CHAT_STUB === "1"
})

const shutdown = (): void => {
  server.stop()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
