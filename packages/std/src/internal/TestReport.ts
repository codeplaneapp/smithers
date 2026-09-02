/**
 * What a test runner said, read out of what it printed.
 *
 * A suite's answer is two facts — how many passed, and which ones failed — and
 * a runner spends twenty to thirty kilobytes of stdout saying them. Paying a
 * model to read that is the expensive way to learn a number, and the measured
 * program shows what it costs: sixteen frames on sphinx-8721 existed because a
 * pre-existing failure was never isolated, and the failure *names* were in the
 * output all along.
 *
 * The parsers below recognise the report shapes the standard runners print.
 * Precision is the design constraint, exactly as in `Probe`: a parser claims a
 * reading only when the output carries its own shape — a tally line, or an
 * outcome line — and otherwise reports nothing parsed, which leaves the caller
 * the raw tail it would have had anyway. A wrong failure set is worse than no
 * failure set, because attribution is built on it.
 *
 * @since 0.1.0
 */

/**
 * One run's outcome as this module could read it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Report {
  readonly passed: number
  readonly failed: ReadonlyArray<string>
  readonly reportedFailed: number | undefined
  readonly parsed: boolean
}

const unique = (ids: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(ids)]

const collect = (text: string, pattern: RegExp): ReadonlyArray<string> => {
  const found: Array<string> = []
  for (const match of text.matchAll(pattern)) {
    const id = match[1]
    if (id !== undefined) found.push(id)
  }
  return found
}

const count = (text: string, pattern: RegExp): number | undefined => {
  const match = pattern.exec(text)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/**
 * pytest, in every verbosity it is normally run at.
 *
 * The short summary (`-rA`, and the default on failure) prints one
 * `FAILED path::id - reason` line per failure, and the tally line prints the
 * counts. Verbose mode prints `path::id PASSED`, which is what makes a
 * passed-count available when the tally was cut off by a capture limit.
 */
const pytest = (text: string): Report | undefined => {
  const summaryFailed = collect(text, /^(?:FAILED|ERROR)[ \t]+(.+?)(?:[ \t]+-[ \t]+.*)?$/gm)
  const outcomes = [...text.matchAll(/^(.+?)[ \t]+(PASSED|FAILED|ERROR)(?:[ \t]+.*)?$/gm)]
  const verboseFailed = outcomes.flatMap((match) => match[2] === "FAILED" || match[2] === "ERROR" ? [match[1]!] : [])
  const verbosePassed = unique(outcomes.flatMap((match) => match[2] === "PASSED" ? [match[1]!] : [])).length
  const failed = unique([...summaryFailed, ...verboseFailed])
  const tally = count(text, /\b(\d+) passed\b/)
  const failures = count(text, /\b(\d+) failed\b/)
  const errors = count(text, /\b(\d+) errors?\b/)
  const hasTally = tally !== undefined || failures !== undefined || errors !== undefined
  const reportedFailed = hasTally
    ? (failures ?? 0) + (errors ?? 0)
    : outcomes.length > 0
    ? unique(verboseFailed).length
    : undefined
  if (!hasTally && outcomes.length === 0 && summaryFailed.length === 0) return undefined
  return {
    passed: tally ?? verbosePassed,
    failed,
    reportedFailed,
    parsed: reportedFailed !== undefined && failed.length === reportedFailed
  }
}

/**
 * unittest, whose failures name a method and a class in the opposite order to
 * the dotted id everything else uses.
 */
const unittest = (text: string): Report | undefined => {
  const ran = count(text, /^Ran (\d+) tests?\b/m)
  const outcomes = [...text.matchAll(/^(?:FAIL|ERROR):[ \t]+(\S+)[ \t]+\(([^)\s]+)\)/gm)]
  const summary = /^FAILED \(([^)]*)\)\s*$/m.exec(text)?.[1]
  const ok = /^OK(?: \([^)]*\))?\s*$/m.test(text)
  if (ran === undefined && outcomes.length === 0 && summary === undefined && !ok) return undefined
  const failed = unique(outcomes.map((match) => `${match[2]}.${match[1]}`))
  const reportedFailed = summary === undefined
    ? ok ? 0 : undefined
    : [...summary.matchAll(/(?:failures|errors)=(\d+)/g)].reduce((total, match) => total + Number(match[1]), 0)
  const passed = ran === undefined || reportedFailed === undefined ? 0 : Math.max(0, ran - reportedFailed)
  return {
    passed,
    failed,
    reportedFailed,
    parsed: ran !== undefined && reportedFailed !== undefined && failed.length === reportedFailed &&
      passed + failed.length === ran
  }
}

/**
 * TAP, which several ecosystems emit and which names each test on its own line.
 */
const tap = (text: string): Report | undefined => {
  const failed = unique(collect(text, /^not ok\b[ \t]*\d*[ \t]*-?[ \t]*(.*\S)?/gm))
  const passed = collect(text, /^ok\b[ \t]*\d*[ \t]*-?[ \t]*(.*)$/gm).length
  if (passed === 0 && failed.length === 0) return undefined
  return { passed, failed, reportedFailed: failed.length, parsed: true }
}

/**
 * Reads one run's report, or says plainly that it could not.
 *
 * @category parsing
 * @since 0.1.0
 */
export const parse = (text: string): Report => {
  // unittest first: its two signals — a `Ran N tests` tally and `FAIL:`/`ERROR:`
  // outcome lines — appear in no other runner's output, while its summary line
  // is close enough to pytest's wording to be misread the other way round.
  for (const reader of [unittest, pytest, tap]) {
    const report = reader(text)
    if (report !== undefined) return report
  }
  return { passed: 0, failed: [], reportedFailed: undefined, parsed: false }
}

/**
 * How two runs of the same command differ, which is the whole of attribution.
 *
 * @category parsing
 * @since 0.1.0
 */
export const attribute = (
  current: Report,
  base: Report
): {
  readonly introduced: ReadonlyArray<string>
  readonly preexisting: ReadonlyArray<string>
  readonly fixed: ReadonlyArray<string>
} | undefined => {
  if (!current.parsed || !base.parsed) return undefined
  const before = new Set(base.failed)
  const now = new Set(current.failed)
  return {
    introduced: current.failed.filter((id) => !before.has(id)),
    preexisting: current.failed.filter((id) => before.has(id)),
    fixed: base.failed.filter((id) => !now.has(id))
  }
}
