/**
 * A pane the agent can render with `ctx.call("ui/pane", { name: "message", props })`.
 *
 * The file name is the pane name, so this is `message`. The props schema is the
 * contract: props that fail to decode are refused before anything renders, and
 * the shell shows the schema's own message instead of a broken card.
 */
import { definePane } from "@smthrs/create-app/ui"
import * as Schema from "effect/Schema"

export const Pane = definePane({
  props: Schema.Struct({
    heading: Schema.String,
    body: Schema.String,
    tone: Schema.optionalKey(Schema.Literals(["neutral", "success", "warning"]))
  }),
  title: "Message",
  render: ({ body, heading, tone }) => (
    <div className={`pane pane-${tone ?? "neutral"}`}>
      <h3 className="pane-heading">{heading}</h3>
      <p className="pane-body">{body}</p>
    </div>
  )
})
