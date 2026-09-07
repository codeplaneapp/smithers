/*
 * The `browser` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `browser` flows registered as one aggregator block. */
export const browserFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  /* The browser tool + surface (§2d/§2d′): read a page; embed its card. */
  const BROWSER = {
    name: "browser.open",
    summary: "Open a web page as a card Smithers can read",
    runtime: ["agent", "browser.read"] as const,
    args: "<url>",
    capabilities: ["session:net-read"],
    input: Schema.Struct({ url: Schema.String }),
    handler: ({ url }: { readonly url: string }) => actions.openBrowser(url)
  }
  return [
  flow(BROWSER)
  ]
}
