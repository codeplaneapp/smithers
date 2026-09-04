/** Pane `chain-block`: one block header. */
import { definePane } from "@smthrs/create-app/ui"
import { KpiStat } from "@smthrs/ui"
import * as Schema from "effect/Schema"
import { HashPill } from "../../src/ui/chain/HashPill.tsx"

export const Pane = definePane({
  title: "Block",
  fullscreen: false,
  props: Schema.Struct({
    chain: Schema.String,
    number: Schema.Number,
    hash: Schema.String,
    /** Unix seconds, as the JSON-RPC reports it. */
    timestamp: Schema.Number,
    transactions: Schema.Number,
    gasUsed: Schema.optionalKey(Schema.String),
    gasLimit: Schema.optionalKey(Schema.String)
  }),
  render: (props, context) => (
    <div className="aomi-pane-grid" data-fullscreen={context.fullscreen ? "true" : undefined}>
      <div className="aomi-pane-row">
        <HashPill hash={props.hash} kind="block" />
        <KpiStat label="Chain" value={props.chain} />
        <KpiStat label="Number" value={props.number} />
        <KpiStat label="Transactions" value={props.transactions} />
        <KpiStat label="Mined" value={new Date(props.timestamp * 1000).toISOString()} />
        <KpiStat label="Gas" value={`${props.gasUsed ?? "—"} / ${props.gasLimit ?? "—"}`} />
      </div>
    </div>
  )
})
