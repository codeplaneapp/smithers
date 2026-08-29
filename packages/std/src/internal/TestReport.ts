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
  const failed = unique([
    // A test id never opens with a bracket, and `FAILED (failures=1)` is
    // unittest's summary line rather than a pytest id.
    ...collect(text, /^(?:FAILED|ERROR)[ \t]+([^\s(][^\s]*)/gm),
    ...collect(text, /^([^\s(][^\s]*)[ \t]+(?:FAILED|ERROR)\b/gm)
  ])
  const tally = count(text, /\b(\d+) passed\b/)
  const verbose = collect(text, /^(\S+)[ \t]+PASSED\b/gm).length
  const failures = count(text, /\b(\d+) failed\b/)
  if (tally === undefined && verbose === 0 && failed.length === 0 && failures === undefined) return undefined
  return { passed: tally ?? verbose, failed, parsed: true }
}

/**
 * unittest, whose failures name a method and a class in the opposite order to
 * the dotted id everything else uses.
 */
const unittest = (text: string): Report | undefined => {
  const ran = count(text, /^Ran (\d+) tests?\b/m)
  const outcomes = [...text.matchAll(/^(?:FAIL|ERROR):[ \t]+(\S+)[ \t]+\(([^)\s]+)\)/gm)]
  if (ran === undefined && outcomes.length === 0) return undefined
  const failed = unique(outcomes.map((match) => `${match[2]}.${match[1]}`))
  return { passed: Math.max(0, (ran ?? failed.length) - failed.length), failed, parsed: true }
}

/**
 * TAP, which several ecosystems emit and which names each test on its own line.
 */
const tap = (text: string): Report | undefined => {
  const failed = unique(collect(text, /^not ok\b[ \t]*\d*[ \t]*-?[ \t]*(.*\S)?/gm))
  const passed = collect(text, /^ok\b[ \t]*\d*[ \t]*-?[ \t]*(.*)$/gm).length
  if (passed === 0 && failed.length === 0) return undefined
  return { passed, failed, parsed: true }
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
  return { passed: 0, failed: [], parsed: false }
}

/**
 * How two runs of the same command differ, which is the whole of attribution.
 *
 * @category parsing
 * @since 0.1.0
 */
export const attribute = (
  current: ReadonlyArray<string>,
  base: ReadonlyArray<string>
): {
  readonly introduced: ReadonlyArray<string>
  readonly preexisting: ReadonlyArray<string>
  readonly fixed: ReadonlyArray<string>
} => {
  const before = new Set(base)
  const now = new Set(current)
  return {
    introduced: current.filter((id) => !before.has(id)),
    preexisting: current.filter((id) => before.has(id)),
    fixed: base.filter((id) => !now.has(id))
  }
}
