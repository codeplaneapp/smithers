import { CHAT_CANCEL_PATH, CHAT_TURN_PATH } from "smithers-shared/AgentApiRoutes"
import { createWebAgent } from "./WebAgent"
import type { WebAgentOptions } from "./WebAgent"
import type { NativeAgent } from "./NativeBridge"

/**
 * The local app's agent seat: the page POSTs every turn to the local
 * origin's /api/chat/turn and reads the NDJSON AgentTurnFrame stream back
 * (LOCAL-APP.md, "HTTP and WebSocket API"). Same client inside the
 * Electrobun window and in Playwright chromium; the origin is the transport.
 */
export const createLocalAgent = (options: Omit<WebAgentOptions, "turnPath" | "cancelPath"> = {}): NativeAgent =>
  createWebAgent({ ...options, turnPath: CHAT_TURN_PATH, cancelPath: CHAT_CANCEL_PATH })
