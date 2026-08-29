/**
 * What one archived journal says a run spent.
 *
 *   node lib/run-cost.mjs <journal-dir-or-engine.db>
 *
 * Prints one JSON object: the seat, the frame and model-call counts, the
 * journal's own span, the four token counters, and USD from the committed price
 * table in `prices.ts`.
 *
 * This reads the journal with `node:sqlite` and nothing else. It deliberately
 * does **not** go through `lib/journal-facts.mjs`, which imports the harness's
 * own modules to rebuild the controller's per-frame decisions: the full
 * benchmark runs for days beside sibling lanes that edit `packages/harness`,
 * and a cost column that stops working because another lane is mid-edit would
 * stop the benchmark. Cost needs four counters off one event type, so it takes
 * them off one event type.
 *
 * A journal with no `model-settled` events is reported at zero rather than
 * refused: a run that died before its first call spent nothing, and that is a
 * number the budget has to be able to add up.
 */
import { existsSync, statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { usd } from "../prices.ts"

/**
 * Sums one journal's usage.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readCost = (databasePath) => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  let rows
  try {
    rows = database.prepare(
      "select emitted_at_ms, event_type, payload_json from flows_journal_events"
        + " where event_type in ('control.agent.model-settled', 'control.agent.turn-opened')"
        + " order by seq"
    ).all()
  } finally {
    database.close()
  }

  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  let seat
  let frames = 0
  let modelCalls = 0
  let firstAt
  let lastAt
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json)
    if (firstAt === undefined) firstAt = row.emitted_at_ms
    lastAt = row.emitted_at_ms
    if (row.event_type === "control.agent.turn-opened") {
      frames += 1
      if (seat === undefined) seat = payload.seat
      continue
    }
    modelCalls += 1
    usage.inputTokens += payload.usage?.inputTokens ?? 0
    usage.cachedInputTokens += payload.usage?.cachedInputTokens ?? 0
    usage.outputTokens += payload.usage?.outputTokens ?? 0
    usage.reasoningTokens += payload.usage?.reasoningTokens ?? 0
  }

  const priced = usd(seat, usage)
  return {
    seat: seat ?? null,
    frames,
    modelCalls,
    spanMillis: firstAt === undefined ? 0 : lastAt - firstAt,
    usage,
    usd: priced.usd ?? null,
    priceSource: priced.source
  }
}

const main = () => {
  const [, , target] = process.argv
  if (target === undefined) {
    console.error("usage: node lib/run-cost.mjs <journal-dir-or-engine.db>")
    process.exit(2)
  }
  const path = existsSync(target) && statSync(target).isDirectory() ? `${target}/engine.db` : target
  if (!existsSync(path)) {
    // No journal is a real outcome — the run died before it wrote one — and the
    // budget still has to add up, so it is zero rather than an error.
    process.stdout.write(`${
      JSON.stringify({
        seat: null,
        frames: 0,
        modelCalls: 0,
        spanMillis: 0,
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        usd: null,
        priceSource: `no journal at ${path}`
      })
    }\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(readCost(path))}\n`)
}

if (import.meta.filename === process.argv[1]) main()
