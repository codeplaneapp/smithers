import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { resolveTransport } from "./agent/transport"
import { ChatController } from "./state/ChatController"
import { TranscriptStore } from "./state/Transcript"
import { App } from "./ui/App"

/*
 * smithers-tui entry: a terminal clone of the Smithers MVP chat app.
 *
 *   bun run dev                              # chat upstream (SMITHERS_CHAT_URL / SMITHERS_CHAT_ORIGIN)
 *   bun run dev -- --origin http://localhost:8787   # product Worker (wrangler dev)
 *   SMITHERS_TUI_ORIGIN=https://canary.smithers.sh bun run dev
 *   SMITHERS_TUI_COOKIE=<session cookie>     # when the boundary needs a session
 *
 * Teardown discipline copied from the opencode TUI reference
 * (reference/opencode/packages/tui/src/app.tsx + util/renderer): the renderer
 * owns the terminal; Ctrl+C exits through the renderer so the alternate
 * screen and raw mode are always restored.
 */
const store = new TranscriptStore()
// The transport publishes into the controller; the controller owns the
// transport. Bind the publish callback first to break the cycle.
let controller: ChatController
const { transport, describe } = resolveTransport((frame) => controller.publish(frame))
controller = new ChatController(store, transport)

const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<App controller={controller} describe={describe} />)
