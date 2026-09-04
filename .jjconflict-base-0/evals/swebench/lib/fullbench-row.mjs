/**
 * Builds one manifest row out of `--key value` pairs.
 *
 *   node lib/fullbench-row.mjs --kind instance --id django__django-1 --state ran \
 *     --patchBytes 512 --cost-json '{"usd":1.2}'
 *
 * The driver is shell, the manifest is JSON, and a value spliced from shell
 * into a `printf` format string is how a ledger ends up with a line that does
 * not parse — a patch size that is empty, a verdict carrying a quote, a reason
 * carrying a newline. So the shell never writes JSON: it hands the pieces to
 * this, which is the only thing that spells the row.
 *
 * Two conveniences, both of which the driver uses:
 *
 * - a flag in `--kebab-case` becomes a `camelCase` key, so shell reads well and
 *   the ledger reads as JSON;
 * - `--<name>-json '<json>'` sets `<name>` to the parsed value, which is how a
 *   nested object (the cost record `lib/run-cost.mjs` prints) gets in.
 *
 * A value that is entirely digits, or digits with one decimal point, becomes a
 * number, so byte counts, timestamps and dollar budgets are arithmetic rather
 * than strings. Everything else is a string; no instance id, verdict, state or
 * image ref is ever spelled that way.
 */
const camel = (flag) => flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())

const main = () => {
  const argv = process.argv.slice(2)
  const row = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === undefined || !flag.startsWith("--") || value === undefined) {
      console.error(`fullbench-row.mjs: expected --key value pairs, got '${flag}'`)
      process.exit(2)
    }
    const name = flag.slice(2)
    if (name.endsWith("-json")) {
      try {
        row[camel(name.slice(0, -"-json".length))] = JSON.parse(value)
      } catch (error) {
        console.error(`fullbench-row.mjs: ${flag} is not JSON: ${error.message}`)
        process.exit(2)
      }
      continue
    }
    row[camel(name)] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value
  }
  process.stdout.write(JSON.stringify(row))
}

main()
