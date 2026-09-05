// Shared by the main docs and package sites. Remove when 1.0 reaches npm.
import { defineRouteMiddleware } from "@astrojs/starlight/route-data"

export const onRequest = defineRouteMiddleware(({ locals }) => {
  locals.starlightRoute.entry.data.banner ??= {
    content: 'These docs describe the unpublished Smithers 1.0 release candidate. <a href="https://smithers.sh/docs/installation/#use-the-source-checkout-before-publication">Use the source checkout</a>; npm commands apply after publication.'
  }
})
