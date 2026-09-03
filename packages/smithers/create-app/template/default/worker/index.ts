/**
 * The Worker: the API and the assets bucket. It is not an agent host, and this
 * template does not ship one.
 *
 * `/api/routes` reports what the router found, which is the cheapest way to
 * confirm a deploy is serving the app you think it is. `/api/turn` is a stub
 * that answers 501 on every request, so a scaffolded app never returns
 * something that looks like a model reply when nothing ran.
 *
 * To make it real: build the host with `layerFor` from
 * `@smthrs/create-app/runtime`, materialize the routed flow with
 * `materializeFlow`, bind the turn's card sink, and stream `TurnFrame` NDJSON
 * back. The `aomi` template's `worker/` directory is the worked example, one
 * Durable Object per session included.
 *
 * Everything the switch does not claim is served from the assets bucket
 * without waking this code.
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
      // The agent host goes here. Until then the endpoint refuses in one stable
      // shape rather than answering with something that looks like a model
      // reply. `app/page.tsx` renders this body verbatim.
      return json({
        error: "not_implemented",
        message:
          "This endpoint is an example stub. Build the host with layerFor from @smthrs/create-app/runtime and stream TurnFrame NDJSON; the aomi template is the worked example."
      }, 501)
    }

    return env.ASSETS.fetch(request)
  }
}
