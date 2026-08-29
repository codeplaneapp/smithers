/**
 * The browser entry point.
 *
 * It reads the generated `routes.ui.gen.ts` once and never imports a page
 * itself: the generated module already imports every page, so a page that
 * imported it back would close an initialization cycle.
 *
 * Routing is by hash, which needs no server rules and matches the
 * `not_found_handling: single-page-application` the Worker's assets use.
 */
import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { layout, pages } from "../routes.ui.gen.ts"
import "virtual:smthrs-app/brand.css"
import "./styles.css"

const routeOf = (hash: string): string => {
  const path = hash.replace(/^#/, "")
  return path === "" ? "/" : path
}

const NotFound = ({ route }: { readonly route: string }) => (
  <section className="page">
    <h1>Not found</h1>
    <p className="page-lede">
      No page is routed at <code>{route}</code>. Add <code>app{route === "/" ? "" : route}/page.tsx</code> and run{" "}
      <code>pnpm routes</code>.
    </p>
  </section>
)

const App = () => {
  const [route, setRoute] = useState(() => routeOf(globalThis.location.hash))
  useEffect(() => {
    const onHashChange = () => setRoute(routeOf(globalThis.location.hash))
    globalThis.addEventListener("hashchange", onHashChange)
    return () => globalThis.removeEventListener("hashchange", onHashChange)
  }, [])

  const match = pages.find((page) => page.route === route)
  const body = match === undefined ? <NotFound route={route} /> : <match.component />
  const Layout = layout
  return Layout === undefined ? body : <Layout>{body}</Layout>
}

const root = document.getElementById("root")
if (root === null) throw new Error("index.html must contain <div id=\"root\">")
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
