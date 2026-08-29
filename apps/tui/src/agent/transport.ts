import type { AgentTurnFrame } from "smithers-shared/NativeAgent"
import type { TuiTransport } from "../state/ChatController"
import { createCloudAgent } from "./CloudAgent"
import { createWebAgent } from "./WebAgent"

/*
 * Transport resolution. The default matches the native app's bun side: the
 * chat upstream directly (CloudAgent semantics, SMITHERS_CHAT_URL /
 * SMITHERS_CHAT_ORIGIN). Pointing at the product Worker boundary instead —
 * `wrangler dev` on http://localhost:8787, or a deployed origin — is the
 * `--origin <url>` flag or SMITHERS_TUI_ORIGIN.
 *
 * Auth on the Worker boundary: pass an existing session cookie through
 * SMITHERS_TUI_COOKIE; the TUI invents no new auth flow.
 */

export interface ResolvedTransport {
  readonly transport: TuiTransport
  /** One line describing where turns go, rendered in the status bar. */
  readonly describe: string
}

const DEFAULT_WORKER_ORIGIN = "http://localhost:8787"

const originFlag = (argv: ReadonlyArray<string>): string | undefined => {
  const index = argv.indexOf("--origin")
  if (index === -1) return undefined
  return argv[index + 1]?.trim() || undefined
}

export const resolveTransport = (
  publish: (frame: AgentTurnFrame) => void,
  argv: ReadonlyArray<string> = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): ResolvedTransport => {
  const workerOrigin = originFlag(argv) ?? env.SMITHERS_TUI_ORIGIN?.trim()
  if (workerOrigin !== undefined && workerOrigin !== "") {
    return {
      transport: createWebAgent(publish, {
        baseUrl: workerOrigin,
        ...(env.SMITHERS_TUI_COOKIE === undefined ? {} : { cookie: env.SMITHERS_TUI_COOKIE })
      }),
      describe: `worker ${workerOrigin}`
    }
  }
  if (argv.includes("--worker")) {
    return {
      transport: createWebAgent(publish, {
        baseUrl: DEFAULT_WORKER_ORIGIN,
        ...(env.SMITHERS_TUI_COOKIE === undefined ? {} : { cookie: env.SMITHERS_TUI_COOKIE })
      }),
      describe: `worker ${DEFAULT_WORKER_ORIGIN}`
    }
  }
  const chatUrl = env.SMITHERS_CHAT_URL?.trim() || "https://chat.smithers.sh/chat"
  return {
    transport: createCloudAgent(publish, {
      chatUrl: env.SMITHERS_CHAT_URL,
      origin: env.SMITHERS_CHAT_ORIGIN
    }),
    describe: `chat upstream ${chatUrl}`
  }
}
