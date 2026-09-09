import * as Schema from "effect/Schema"

const TokenBalance = Schema.Struct({
  symbol: Schema.String,
  /** Base units as a decimal string. */
  amount: Schema.String,
  decimals: Schema.Number,
  token: Schema.optionalKey(Schema.String)
})

/** Shared by the Worker producer and the chain-balance pane. */
export const ChainBalanceProps = Schema.Struct({
  chain: Schema.String,
  address: Schema.String,
  label: Schema.optionalKey(Schema.String),
  /** Native currency in wei. */
  native: TokenBalance,
  tokens: Schema.Array(TokenBalance)
})
