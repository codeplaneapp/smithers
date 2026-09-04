/**
 * One lane's seal, read back off the lane's own artifacts — for either arm.
 *
 *   node breach-scan.mjs --ledger f [--logs dir] [--journals dir] \
 *     [--label text] [--require none] [--out dir] [--json]
 *
 * `compare-codex-lanes.mjs` asserts the seal on the *codex* arm, as one column
 * of a two-lane comparison. This asks the same question of one lane on its own,
 * and of **either harness**, because from 2026-08-24 both arms run their
 * testbed on `--network none` and a claim made for one arm is worth nothing
 * unless the same evidence is produced for the other.
 *
 * Two assertions, and they are the two halves the `none` lane's report already
 * owes:
 *
 * - **every container was measured `none`.** The ledger carries what the lane
 *   *asked* for (`testbedNetwork`) and what `docker inspect` said the container
 *   was actually on at the instant it started (`testbedNetworkObserved`). The
 *   assertion reads the observation, never the request: a lane that judged
 *   itself by its request would be checking a variable against itself. A row
 *   with no observation at all fails the same way a `bridge` one does — an
 *   unmeasured container is not a sealed container.
 * - **zero successful egress, in every trace.** Under `none` this is redundant,
 *   which is the point: the breach column has to come out zero *by
 *   construction*, and a non-zero one means the constraint did not hold
 *   somewhere the ledger did not see.
 *
 * **An attempt is not an outcome, and under `none` the difference is the whole
 * report.** `breaches` in `compare-codex-lanes.mjs` deliberately does not read a
 * command's result — on a `bridge` lane a `docker exec … curl` is assumed to
 * have worked, because it would have. Under `--network none` it cannot: the
 * container has `lo` and nothing else, which is the fact `./network-dryrun.sh`
 * establishes against a real daemon. Counting those attempts as breaches failed
 * the first sealed lane that ran on 2026-08-25 — 6 of them, every one of which
 * the transcript showed dying on `Could not resolve host`.
 *
 * So for a container **observed** `none`, each in-container fetch is read to its
 * outcome, and the reading fails closed: the trace has to show the refusal,
 * either against that command or against another fetch in the same container.
 * An attempt in a container that is never shown refusing anything stays a
 * breach, because a fetch that left no evidence of failing inside a container
 * that cannot reach the network is a contradiction, and the scan reports
 * contradictions rather than resolving them in the lane's favour. For any other
 * container the old rule stands unchanged, so no `bridge` lane's report moves.
 *
 * None of that logic lives here. `egress`, `inContainerEgress`,
 * `provedUnnetworked` and `countedBreaches` are imported from
 * `compare-codex-lanes.mjs`, beside the patterns they extend, so the one-lane
 * scan and the two-lane comparison cannot reach different verdicts about the
 * same trace.
 *
 * **Where the trace lives differs per arm, and only that differs.** A codex run
 * writes one transcript, `logs/<id>.run.log`. A flows run writes a driver log of
 * the same name plus a journal, `journals/<id>/engine.db`, whose
 * `flows_journal_events.payload_json` holds every call the agent made and every
 * result it got back. Both are read as text and handed to the same patterns.
 *
 * It reads a ledger, some logs and some journals. No evaluator report, no
 * clock, no network. Running it twice over the same files produces the same
 * bytes.
 *
 * @since 0.1.0
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  countedBreaches,
  egress,
  inContainerEgress,
  provedUnnetworked,
  TESTBED_MODES
} from "./compare-codex-lanes.mjs"

/**
 * Every ledger row for one instance, folded into the fields a seal is read off.
 *
 * The ledger is append-only and an instance has several rows — `started`,
 * `ran`, `graded`, `cleaned` — with the testbed fields written on whichever row
 * the arm's driver writes them on. The fold takes the last non-empty value of
 * each field, so neither arm's row order is baked in here.
 *
 * @category conversions
 * @since 0.1.0
 */
export const foldLedger = (text) => {
  const instances = new Map()
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.kind !== "instance" || typeof row.id !== "string") continue
    const seen = instances.get(row.id) ?? { id: row.id, states: [] }
    seen.states.push(row.state)
    if (typeof row.testbedNetwork === "string" && row.testbedNetwork !== "") {
      seen.requested = row.testbedNetwork
    }
    if (typeof row.testbedNetworkObserved === "string" && row.testbedNetworkObserved !== "") {
      seen.observed = row.testbedNetworkObserved
    }
    if (typeof row.verdict === "string" && row.verdict !== "") seen.verdict = row.verdict
    instances.set(row.id, seen)
  }
  return [...instances.values()]
}

/**
 * Every byte of one flows journal that could carry a command or its output.
 *
 * `payload_json` is the whole event, so a command the agent ran and the output
 * it got back are both in it. Reading the column rather than re-deriving the
 * call structure is deliberate: a scan that understood the schema would stop
 * seeing a command the day the schema moved, and the question here is only
 * "does this text contain a fetch".
 *
 * @category conversions
 * @since 0.1.0
 */
export const journalText = (database) => {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const rows = db.prepare("select payload_json, meta_json from flows_journal_events").all()
    return rows.map((row) => `${row.payload_json ?? ""}\n${row.meta_json ?? ""}`).join("\n")
  } finally {
    db.close()
  }
}

/**
 * Everything written about one instance, as one string.
 *
 * A missing source is not a failure — a codex lane has no journals and a flows
 * lane's run log is its driver's — but an instance with *no* source at all is,
 * and it is reported as `no trace` rather than silently scanned as the empty
 * string, which would clear it.
 *
 * @category conversions
 * @since 0.1.0
 */
export const traceOf = (id, { logs, journals }) => {
  const parts = []
  if (logs !== undefined) {
    for (const suffix of ["run.log", "last.txt", "codex.log"]) {
      const path = join(logs, `${id}.${suffix}`)
      if (existsSync(path)) parts.push(readFileSync(path, "utf8"))
    }
  }
  if (journals !== undefined) {
    for (const name of [id, ...readdirSync(journals).filter((entry) => entry.startsWith(`${id}-`))]) {
      const database = join(journals, name, "engine.db")
      if (existsSync(database)) parts.push(journalText(database))
    }
  }
  return parts.length === 0 ? undefined : parts.join("\n")
}

/**
 * The scan itself: one row per instance, plus the two assertions.
 *
 * @category constructors
 * @since 0.1.0
 */
export const scan = ({ journals, ledger, logs, require: required }) => {
  const rows = foldLedger(readFileSync(ledger, "utf8")).map((instance) => {
    const text = traceOf(instance.id, { journals, logs })
    const found = text === undefined
      ? { attempts: 0, breaches: [], commands: [], refusals: 0, webSearches: [] }
      : egress(text)
    // A container the daemon reported on `none` has `lo` and nothing else, so a
    // fetch inside it is refused by construction — but the trace has to show it.
    // Anything else, including an attempt whose outcome the trace never records,
    // counts against the lane.
    const inContainer = text === undefined ? [] : inContainerEgress(text)
    const unnetworked = instance.observed === "none" && text !== undefined
      && provedUnnetworked(text, inContainer)
    const counted = countedBreaches(text, instance.observed)
    return {
      ...instance,
      attempts: found.attempts,
      breaches: counted,
      commands: found.commands,
      inContainerAttempts: inContainer.length,
      inContainerRefused: inContainer.length - counted.length,
      unnetworked,
      refusals: found.refusals,
      traced: text !== undefined,
      webSearches: found.webSearches
    }
  })
  rows.sort((left, right) => left.id.localeCompare(right.id))

  const observed = new Map()
  for (const row of rows) {
    const key = TESTBED_MODES.has(row.observed) ? row.observed : "unrecorded"
    observed.set(key, (observed.get(key) ?? 0) + 1)
  }
  const requested = new Set(rows.map((row) => row.requested ?? "unrecorded"))
  const claim = requested.size === 1 ? [...requested][0] : "mixed"

  const notSealed = rows.filter((row) => row.observed !== "none")
  const breached = rows.filter((row) => row.breaches.length > 0)
  const searched = rows.filter((row) => row.webSearches.length > 0)
  const untraced = rows.filter((row) => !row.traced)
  const failures = []
  const asserted = required === "none" || claim === "none"
  if (required !== undefined && claim !== required) {
    failures.push(`the lane's rows claim \`${claim}\`, and \`--require ${required}\` was given`)
  }
  if (asserted) {
    if (notSealed.length > 0) {
      failures.push(`${notSealed.length} container(s) were not observed \`none\``)
    }
    if (breached.length > 0) failures.push(`${breached.length} run(s) fetched from inside the testbed`)
    if (searched.length > 0) failures.push(`${searched.length} run(s) used a web-search tool`)
    if (untraced.length > 0) failures.push(`${untraced.length} run(s) left no trace to scan`)
  }
  return {
    asserted,
    breached,
    claim,
    failures,
    notSealed,
    observed: Object.fromEntries(observed),
    rows,
    searched,
    totals: {
      attempts: rows.reduce((sum, row) => sum + row.attempts, 0),
      breaches: rows.reduce((sum, row) => sum + row.breaches.length, 0),
      inContainerAttempts: rows.reduce((sum, row) => sum + row.inContainerAttempts, 0),
      inContainerRefused: rows.reduce((sum, row) => sum + row.inContainerRefused, 0),
      instances: rows.length,
      refusals: rows.reduce((sum, row) => sum + row.refusals, 0),
      webSearches: rows.reduce((sum, row) => sum + row.webSearches.length, 0)
    },
    untraced
  }
}

/**
 * The report, in markdown.
 *
 * @category rendering
 * @since 0.1.0
 */
export const render = (result, { label, ledger }) => {
  const lines = [`# Breach scan — ${label}`, ""]
  lines.push(`Ledger: \`${ledger}\``, "")
  lines.push(
    `${result.totals.instances} instances scanned. The lane's rows claim **${result.claim}**; `
      + `\`docker inspect\` observed ${
        Object.entries(result.observed).map(([mode, count]) => `**${count} ${mode}**`).join(", ")
      }.`,
    ""
  )
  lines.push("| | count |", "| --- | ---: |")
  lines.push(`| containers observed \`none\` | ${result.observed.none ?? 0} of ${result.totals.instances} |`)
  lines.push(`| egress commands attempted | ${result.totals.attempts} |`)
  lines.push(`| attempts the host proxy refused | ${result.totals.refusals} |`)
  lines.push(`| in-container fetches attempted | ${result.totals.inContainerAttempts} |`)
  lines.push(`| of those, the trace shows failing | ${result.totals.inContainerRefused} |`)
  lines.push(`| **fetches counted against the lane (breaches)** | **${result.totals.breaches}** |`)
  lines.push(`| web-search tool lines | ${result.totals.webSearches} |`)
  lines.push("")

  const attempted = result.rows.filter((row) => row.attempts > 0)
  if (attempted.length === 0) {
    lines.push("No run issued an egress command.", "")
  } else {
    lines.push("## Where the seal was pushed on", "")
    lines.push("| instance | attempts | refusals | breaches | first command |", "| --- | ---: | ---: | ---: | --- |")
    for (const row of attempted) {
      lines.push(
        `| ${row.id} | ${row.attempts} | ${row.refusals} | ${row.breaches.length} | \`${
          (row.commands[0] ?? "").replaceAll("|", "\\|").slice(0, 90)
        }\` |`
      )
    }
    lines.push("")
  }

  if (result.asserted && result.notSealed.length > 0) {
    lines.push("## The testbed was not sealed", "")
    for (const row of result.notSealed) {
      lines.push(`- ${row.id} — observed \`${row.observed ?? "nothing"}\`, requested \`${row.requested ?? "nothing"}\``)
    }
    lines.push("")
  }
  if (result.breached.length > 0) {
    lines.push("## Where the seal did not hold", "")
    lines.push(
      "Each of these ran a fetch inside the testbed that the trace does not show failing.",
      ""
    )
    for (const row of result.breached) {
      for (const line of row.breaches) lines.push(`- ${row.id} — \`${line}\``)
    }
    lines.push("")
  }
  if (result.searched.length > 0) {
    lines.push("## Web-search lines", "")
    for (const row of result.searched) lines.push(`- ${row.id} — ${row.webSearches.length}`)
    lines.push("")
  }
  if (result.untraced.length > 0) {
    lines.push("## No trace to scan", "")
    for (const row of result.untraced) lines.push(`- ${row.id}`)
    lines.push("")
  }

  const verdict = result.failures.length > 0
    ? `**Verdict: FAILED.** ${result.failures.join("; ")}.`
    : result.asserted
    ? "**Verdict: sealed.** Every container was observed `none`, and every fetch attempted inside one is shown "
      + "failing in the run's own trace."
    : `**Verdict: not asserted.** The lane's rows claim \`${result.claim}\`, so the counts above are a `
      + "reading of its traces and not a gate. Pass `--require none` to a lane that claims one."
  lines.push(verdict, "")
  return lines.join("\n")
}

const flag = (argv, name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 || argv[at + 1] === undefined ? fallback : argv[at + 1]
}

export const main = (argv) => {
  const ledger = flag(argv, "ledger")
  if (ledger === undefined) {
    console.error("usage: node breach-scan.mjs --ledger f [--logs dir] [--journals dir] [--require none]")
    return 2
  }
  const logs = flag(argv, "logs")
  const journals = flag(argv, "journals")
  const required = flag(argv, "require")
  const label = flag(argv, "label", ledger)
  const result = scan({
    journals: journals === undefined ? undefined : resolve(journals),
    ledger: resolve(ledger),
    logs: logs === undefined ? undefined : resolve(logs),
    require: required
  })
  const out = flag(argv, "out")
  const text = render(result, { label, ledger })
  if (argv.includes("--json")) console.log(JSON.stringify(result, undefined, 2))
  else console.log(text)
  if (out !== undefined) {
    writeFileSync(join(resolve(out), "breach-scan.md"), text)
    writeFileSync(join(resolve(out), "breach-scan.json"), `${JSON.stringify(result, undefined, 2)}\n`)
  }
  return result.failures.length === 0 ? 0 : 1
}

if (process.argv[1] === import.meta.filename) process.exit(main(process.argv.slice(2)))
