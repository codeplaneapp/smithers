/**
 * The Worker.
 *
 * `/api/routes` reports what the router found, which is the cheapest way to
 * confirm a deploy is serving the app you think it is. `/api/turn` is where the
 * agent runs: build the host with `layerFor` from `@smthrs/create-app/runtime`,
 * bind the turn's card sink, and stream `TurnFrame` NDJSON back. Everything
 * else is served from the assets bucket without waking the Worker.
 */
import { flows, paneNames } from "../routes.gen.ts"

interface Env {
  readonly ASSETS: { readonly fetch: (request: Request) => Promise<Response> }
  readonly APP_NAME: string
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/api/routes") {
      return json({
        app: env.APP_NAME,
        panes: paneNames,
        flows: flows.map((flow) => ({ id: flow.id, file: flow.file }))
      })
    }

    if (url.pathname === "/api/turn") {
      // The agent host goes here. Until then the endpoint says so rather than
      // answering with something that looks like a model reply.
      return json({ error: "not_implemented", message: "Wire layerFor from @smthrs/create-app/runtime." }, 501)
    }

    return env.ASSETS.fetch(request)
  }
}
