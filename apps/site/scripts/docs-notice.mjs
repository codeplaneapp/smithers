import { defineRouteMiddleware } from "@astrojs/starlight/route-data"
import { onRequest as releaseNotice } from "../../docs/shared/release-notice.mjs"

export const onRequest = defineRouteMiddleware((context, next) => {
  const path = context.url.pathname.replace(/\/$/, "")
  const appPage = ["/docs", "/docs/app", "/docs/quickstart", "/docs/pricing"].includes(path) || path.startsWith("/docs/app/")
  if (appPage) {
    context.locals.starlightRoute.entry.data.banner ??= {
      content: 'Hosted private alpha for selected public repositories. <a href="/docs/app/account/">Learn about access</a>.'
    }
    return next()
  }
  return releaseNotice(context, next)
})
