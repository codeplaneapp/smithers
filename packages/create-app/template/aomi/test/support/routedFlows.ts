/**
 * The routed flows an e2e test runs, with the UI tool wired to a sink it can
 * read.
 *
 * `cachedModelTest` discovers routes from the filesystem by default, which
 * hands every flow the `ui` source TOOLS.ts composes: a sink that drops cards
 * and an empty pane registry. That source refuses every `ui/pane` call by name
 * ("No panes are registered in this app"), so a test running against it can
 * neither observe a card nor let the model succeed at rendering one. The
 * `routes` option exists for exactly this, and this helper is what it returns.
 *
 * Two things are replaced and nothing else:
 * - The pane registry, with the names routes.gen.ts registered, so `ui/pane`
 *   accepts the panes the shipped app actually has.
 * - The card sink, with one that appends to the caller's array, so the test
 *   asserts on the cards the turn requested instead of on the model's own
 *   report of them.
 *
 * Every other source (`tevm`, `flows`) is the declared one, and the flow, agent
 * and sandbox come straight from routes.gen.ts. A flow added to the app is
 * therefore routed here as soon as `pnpm routes` runs.
 */
import { defineTools } from "@smthrs/create-app/app"
import type { RoutedFlow } from "@smthrs/create-app/testing"
import type { AppCard } from "@smthrs/create-app/ui"
import * as Context from "effect/Context"
import { flows, paneNames } from "../../routes.gen.ts"
import { CardSink, makeCollecting, makePanes, PaneNames, uiSource } from "../../tools/ui.ts"

/**
 * The registered panes as `ui/pane` checks them.
 *
 * `fullscreen` lives in the pane component, and reading it would mean
 * importing `routes.ui.gen.ts` and with it React and every page of the app.
 * The flag only rides along on the emitted card, so a test reports `false`.
 */
const panes = paneNames.map((name) => ({ name, fullscreen: false }))

/**
 * The routed flows, with `ui` bound to `cards`.
 *
 * The array is the caller's, so the test declares it beside its assertions and
 * reads it after the run.
 */
export const routedFlows = (cards: Array<AppCard>): ReadonlyArray<RoutedFlow> => {
  const ui = uiSource(
    Context.add(Context.make(CardSink, makeCollecting(cards)), PaneNames, makePanes(panes))
  )
  return flows.map((route) => ({
    id: route.id,
    file: route.file,
    spec: route.spec,
    agent: route.agent,
    sandbox: route.sandbox,
    tools: defineTools(route.tools.sources.map((source) => source.name === ui.name ? ui : source))
  })) as unknown as ReadonlyArray<RoutedFlow>
}
