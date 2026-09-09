/**
 * The dollar figure both of the full benchmark's screens print.
 *
 * `fullbench-report.mjs` writes the checkpoint and `lib/fullbench-status.mjs`
 * writes the one-screen view, over the same ledger. A formatter copied into
 * each of them is a formatter that can disagree about the same row, so there
 * is one and both import it.
 *
 * It coerces rather than trusting the ledger's type because the driver is
 * shell. `SWB_FULLBENCH_BUDGET_USD=.50` is a budget `fullbench.sh` accepts, and
 * `lib/fullbench-row.mjs` only numbers a value with a digit before the decimal
 * point, so that budget reaches the ledger as the string `.50`.
 *
 * A value that is not a number at all prints as absent instead of stopping the
 * caller. The report generator runs inside the driver and the status screen is
 * read against a live one: losing a figure is not worth losing the pause notice
 * the line around it was carrying.
 */

/**
 * `value` as `$0.00`, or `—` when it is missing or is not a number.
 *
 * @category conversions
 * @since 0.1.0
 */
export const formatMoney = (value) => {
  const number = value === undefined || value === null || value === "" ? Number.NaN : Number(value)
  return Number.isFinite(number) ? `$${number.toFixed(2)}` : "—"
}
