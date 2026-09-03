/** Pane `chain-contract`: the result of one or more contract reads. */
import { definePane } from "@smthrs/create-app/ui"
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@smthrs/ui"
import * as Schema from "effect/Schema"
import { AddressPill } from "../../src/ui/chain/AddressPill.tsx"

const Read = Schema.Struct({
  /** Solidity function name, e.g. "balanceOf". */
  name: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Decoded result rendered as text; a struct arrives pre-formatted. */
  result: Schema.String
})

export const Pane = definePane({
  title: "Contract",
  fullscreen: true,
  props: Schema.Struct({
    chain: Schema.String,
    address: Schema.String,
    name: Schema.optionalKey(Schema.String),
    reads: Schema.Array(Read)
  }),
  render: (props, context) => (
    <div className="aomi-pane-grid" data-fullscreen={context.fullscreen ? "true" : undefined}>
      <div className="aomi-pane-row">
        <AddressPill address={props.address} label={props.name} />
        <Badge variant="secondary">{props.chain}</Badge>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Function</TableHead>
            <TableHead>Arguments</TableHead>
            <TableHead>Result</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.reads.map((read) => (
            <TableRow key={`${read.name}(${(read.args ?? []).join(",")})`}>
              <TableCell>{read.name}</TableCell>
              <TableCell>{(read.args ?? []).join(", ") || "—"}</TableCell>
              <TableCell>{read.result}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
})
