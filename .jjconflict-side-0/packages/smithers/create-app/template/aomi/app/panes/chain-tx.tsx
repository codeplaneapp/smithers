/** Pane `chain-tx`: one transaction and its receipt. */
import { definePane } from "@smthrs/create-app/ui"
import { KpiStat, StatusPill } from "@smthrs/ui"
import * as Schema from "effect/Schema"
import { AddressPill } from "../../src/ui/chain/AddressPill.tsx"
import { HashPill } from "../../src/ui/chain/HashPill.tsx"
import { TokenAmount } from "../../src/ui/chain/TokenAmount.tsx"

export const Pane = definePane({
  title: "Transaction",
  fullscreen: false,
  props: Schema.Struct({
    chain: Schema.String,
    hash: Schema.String,
    from: Schema.String,
    to: Schema.optionalKey(Schema.String),
    /** Wei as a decimal string. */
    value: Schema.String,
    status: Schema.Literals(["success", "reverted", "pending"]),
    blockNumber: Schema.optionalKey(Schema.Number),
    gasUsed: Schema.optionalKey(Schema.String)
  }),
  render: (props, context) => (
    <div className="aomi-pane-grid" data-fullscreen={context.fullscreen ? "true" : undefined}>
      <div className="aomi-pane-row">
        <HashPill hash={props.hash} kind="transaction" />
        <StatusPill status={props.status === "reverted" ? "failed" : props.status === "success" ? "ok" : "pending"} />
        <KpiStat label="Chain" value={props.chain} />
      </div>
      <div className="aomi-pane-row">
        <KpiStat label="From" value={<AddressPill address={props.from} />} />
        <KpiStat label="To" value={props.to === undefined ? "contract creation" : <AddressPill address={props.to} />} />
        <KpiStat label="Value" value={<TokenAmount amount={props.value} symbol="ETH" />} />
        <KpiStat label="Block" value={props.blockNumber ?? "—"} />
        <KpiStat label="Gas used" value={props.gasUsed ?? "—"} />
      </div>
    </div>
  )
})
