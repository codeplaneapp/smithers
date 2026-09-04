/**
 * The Worker entry point: the Durable Object class and the fetch handler.
 *
 * Both halves live in their own modules. `AppSession` is the session's durable
 * state and `router.ts` is the API; this file only names them for wrangler,
 * which reads the default export and the class export from `main`.
 */
import { handle } from "./router.ts"
import { AppSession } from "./AppSession.ts"
import type { Env } from "./env.ts"

export { AppSession }
export { handle }

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handle(request, env)
} satisfies ExportedHandler<Env>
