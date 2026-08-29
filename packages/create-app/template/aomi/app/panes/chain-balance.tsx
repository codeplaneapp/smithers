/**
 * Pane `chain-balance`: what an address holds on one chain.
 *
 * Amounts are base-unit decimal strings, the only lossless JSON form for a
 * uint256; `TokenAmount` scales them for display.
 */
import { definePane } from "@smthrs/create-app/ui"
import { KpiStat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@smthrs/ui"
import * as Schema from "effect/Schema"
import { AddressPill } from "../../src/ui/chain/AddressPill.tsx"
import { TokenAmount } from "../../src/ui/chain/TokenAmount.tsx"

const TokenBalance = Schema.Struct({
  symbol: Schema.String,
  /** Base units as a decimal string. */
  amount: Schema.String,
  decimals: Schema.Number,
  token: Schema.optionalKey(Schema.String)
})

export const Pane = definePane({
  title: "Balances",
  fullscreen: true,
  props: Schema.Struct({
    chain: Schema.String,
    address: Schema.String,
    label: Schema.optionalKey(Schema.String),
    /** Native currency in wei. */
    native: TokenBalance,
    tokens: Schema.Array(TokenBalance)
  }),
  render: (props, context) => (
    <div className="aomi-pane-grid" data-fullscreen={context.fullscreen ? "true" : undefined}>
      <div className="aomi-pane-row">
        <AddressPill address={props.address} label={props.label} />
        <KpiStat label="Chain" value={props.chain} />
        <KpiStat
          label={props.native.symbol}
          value={<TokenAmount amount={props.native.amount} decimals={props.native.decimals} />}
          hint="native balance"
        />
        <KpiStat label="Tokens" value={props.tokens.length} />
      </div>
      {props.tokens.length === 0 ? null : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Token</TableHead>
              <TableHead>Contract</TableHead>
              <TableHead>Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.tokens.map((token) => (
              <TableRow key={`${token.symbol}:${token.token ?? "native"}`}>
                <TableCell>{token.symbol}</TableCell>
                <TableCell>{token.token === undefined ? "—" : <AddressPill address={token.token} />}</TableCell>
                <TableCell>
                  <TokenAmount amount={token.amount} decimals={token.decimals} symbol={token.symbol} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
})
