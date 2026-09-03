/**
 * Browser entry point.
 *
 * The generated `routes.gen.ts` is the only route table: `pages` maps a path
 * to a component, `panes` is the pane registry the agent renders into, and
 * `layout` wraps everything. Nothing here hard-codes a path.
 */
import "virtual:smthrs-app/brand.css"
import "./styles.css"

import { SmithersUiStyles } from "@smthrs/ui"
import type { ReactNode } from "react"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { flows } from "../routes.gen.ts"
import { layout, pages, panes } from "../routes.ui.gen.ts"
import { startShortcuts } from "./shell/keys.ts"
import type { AppRegistry, RoutedFlowSummary } from "./shell/registry.ts"
import { RegistryContext } from "./shell/registry.ts"
import { redirect, startRouter } from "./shell/router.ts"
import { actions, useRoute } from "./shell/store.ts"
import { houseBridgeCss } from "./shell/theme.ts"

/** Where `/` sends the browser. The root page renders Build either way. */
const HOME = "/build"

const registry: AppRegistry = {
  panes,
  flows: flows.map((flow): RoutedFlowSummary => ({ id: flow.id, file: flow.file, chat: flow.spec.chat === true }))
}

const Layout = layout ?? (({ children }: { children: ReactNode }) => <>{children}</>)

function NotFound({ route }: { readonly route: string }) {
  return (
    <main className="aomi-page">
      <h1 className="aomi-heading">Not found</h1>
      <p className="aomi-tagline">{`No page is routed at ${route}.`}</p>
    </main>
  )
}

function Router() {
  const route = useRoute()
  const match = pages.find((page) => page.route === route)
  const Page = match?.component
  return (
    <RegistryContext value={registry}>
      <Layout>{Page === undefined ? <NotFound route={route} /> : <Page />}</Layout>
    </RegistryContext>
  )
}

function App() {
  return (
    <>
      <SmithersUiStyles withTheme extra={houseBridgeCss} />
      <Router />
    </>
  )
}

startRouter()
startShortcuts()
if (window.location.pathname === "/" && !window.location.hash.startsWith("#/")) redirect(HOME)
void actions.refreshSessions()

const container = document.getElementById("root")
if (container === null) throw new Error("index.html is missing #root")
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
