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
 * benchmark runs for days beside sibling lanes that edit `packages/smithers/agent/harness`,
 * and a cost column that stops working because another lane is mid-edit would
 * stop the benchmark. Cost needs four counters off one event type, so it takes
 * them off one event type.
 *
 * A readable journal with no `model-settled` events reports zero recorded
 * usage. Missing or unreadable journals and calls without a known price carry
 * `unknown: true`, so the budget cannot mistake absent accounting for zero.
 */
import { existsSync, statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { usd } from "../prices.ts"

const readJournalCost = (databasePath) => {
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
  let unknown = false
  let dollars = 0
  let priceSource = "no model-settled events"
  const usageBySeat = new Map()
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json)
    if (firstAt === undefined) firstAt = row.emitted_at_ms
    lastAt = row.emitted_at_ms
    if (row.event_type === "control.agent.turn-opened") {
      frames += 1
      seat = payload.seat
      continue
    }
    modelCalls += 1
    const counters = payload.usage
    if (!counters || ![counters.inputTokens, counters.outputTokens,
      counters.cachedInputTokens ?? 0, counters.reasoningTokens ?? 0]
      .every((value) => Number.isFinite(value) && value >= 0)) {
      unknown = true
      priceSource = "unknown: invalid model usage"
      continue
    }
    usage.inputTokens += payload.usage?.inputTokens ?? 0
    usage.cachedInputTokens += payload.usage?.cachedInputTokens ?? 0
    usage.outputTokens += payload.usage?.outputTokens ?? 0
    usage.reasoningTokens += payload.usage?.reasoningTokens ?? 0
    const seatUsage = usageBySeat.get(seat) ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
    seatUsage.inputTokens += counters.inputTokens
    seatUsage.cachedInputTokens += counters.cachedInputTokens ?? 0
    seatUsage.outputTokens += counters.outputTokens
    usageBySeat.set(seat, seatUsage)
  }
  for (const [model, counters] of usageBySeat) {
    const priced = usd(model, counters)
    if (!Number.isFinite(priced.usd)) {
      unknown = true
      priceSource = priced.source
    } else {
      dollars += priced.usd
      if (!unknown) priceSource = priced.source
    }
  }

  return {
    seat: seat ?? null,
    frames,
    modelCalls,
    spanMillis: firstAt === undefined ? 0 : lastAt - firstAt,
    usage,
    usd: unknown ? null : Math.round(dollars * 10_000) / 10_000,
    unknown,
    priceSource
  }
}

/**
 * Sums one journal's usage, explicitly marking unreadable accounting unknown.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readCost = (databasePath) => {
  try {
    return readJournalCost(databasePath)
  } catch (error) {
    return { usd: null, unknown: true, priceSource: `unknown: cannot read journal: ${error.message}` }
  }
}

const main = () => {
  const [, , target] = process.argv
  if (target === undefined) {
    console.error("usage: node lib/run-cost.mjs <journal-dir-or-engine.db>")
    process.exit(2)
  }
  const path = existsSync(target) && statSync(target).isDirectory() ? `${target}/engine.db` : target
  process.stdout.write(`${JSON.stringify(readCost(path))}\n`)
}

if (import.meta.filename === process.argv[1]) main()
