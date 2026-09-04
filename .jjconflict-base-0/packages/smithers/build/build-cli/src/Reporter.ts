/**
 * The seam between target execution and the terminal.
 *
 * Execution reports events, a run beginning, a target starting, a target
 * settling, a free-form note, a warning, the end summary, and a renderer
 * decides what they look like. Three renderers ship. `plain` prints exactly
 * the lines the executors always printed, one per settled target and one
 * summary, which is what pipes, CI logs, and the existing tests read.
 * `stream` adds colour, glyphs, and aligned columns but never moves the
 * cursor, so it is safe wherever colour is. `tty` draws in place: running
 * targets spin at the bottom of the screen and settled targets scroll above
 * them in completion order, the way Bazel's progress bar and Nx's dynamic
 * renderer work.
 *
 * Every renderer writes to standard error. Standard output stays the
 * property of the structured envelope incur prints, so `--format json` is
 * never mixed with progress.
 *
 * @since 0.1.0
 */
import { performance } from "node:perf_hooks"
import * as Ansi from "./Ansi.ts"
import type { Summary, TargetReport } from "./Executor.ts"

/**
 * The `--ui` flag values. `auto` resolves to one of the other three from the
 * environment and the streams; see {@link resolveRenderer}.
 *
 * @category models
 * @since 0.1.0
 */
export const uiModes = ["auto", "tty", "stream", "plain"] as const

/**
 * One of {@link uiModes}.
 *
 * @category models
 * @since 0.1.0
 */
export type UiMode = (typeof uiModes)[number]

/**
 * A concrete renderer: `auto` resolved.
 *
 * @category models
 * @since 0.1.0
 */
export type Renderer = Exclude<UiMode, "auto">

/**
 * The stream a renderer writes to. `columns` is read on every paint so a
 * resize takes effect at the next frame.
 *
 * @category models
 * @since 0.1.0
 */
export interface Terminal {
  readonly write: (text: string) => void
  readonly isTTY: boolean
  readonly columns: number | undefined
}

/**
 * Wraps a process stream as a {@link Terminal}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const terminalOf = (stream: NodeJS.WriteStream): Terminal => ({
  write: (text) => {
    stream.write(text)
  },
  isTTY: stream.isTTY === true,
  get columns() {
    return stream.columns
  }
})

/**
 * Which streams are terminals, as {@link resolveRenderer} reads them.
 *
 * @category models
 * @since 0.1.0
 */
export interface Streams {
  readonly stdout: boolean
  readonly stderr: boolean
}

const nonEmpty = (value: string | undefined): boolean => value !== undefined && value !== ""

const isUiMode = (value: string | undefined): value is UiMode =>
  value !== undefined && (uiModes as ReadonlyArray<string>).includes(value)

/**
 * Picks the renderer one invocation draws with.
 *
 * An explicit mode wins, then `SMTHRS_UI` in the environment, in the manner
 * of Turborepo's `TURBO_UI` and Nx's `NX_TUI`. Under `auto`, an explicit
 * `--format` means a program is reading the output, so the renderer is
 * `plain`; `NO_COLOR` and `TERM=dumb` are `plain`; `CI` is `plain` unless
 * `FORCE_COLOR` asks for colour, in which case it is `stream`, the cursor
 * never moving in a log; two terminals get `tty`; a terminal on standard
 * error alone, or `FORCE_COLOR` under a pipe, gets `stream`; anything else is
 * `plain`.
 *
 * @category selection
 * @since 0.1.0
 */
export const resolveRenderer = (
  mode: UiMode,
  env: Ansi.Environment,
  streams: Streams,
  formatExplicit = false
): Renderer => {
  if (mode !== "auto") return mode
  const declared = env["SMTHRS_UI"]
  if (isUiMode(declared) && declared !== "auto") return declared
  if (formatExplicit) return "plain"
  if (nonEmpty(env["NO_COLOR"]) || env["TERM"] === "dumb") return "plain"
  const forced = Ansi.forcedColor(env) === true
  if (nonEmpty(env["CI"])) return forced ? "stream" : "plain"
  if (streams.stdout && streams.stderr) return "tty"
  if (streams.stderr || forced) return "stream"
  return "plain"
}

/**
 * What a run is about to do, reported once before any target starts so the
 * renderers can size their columns.
 *
 * @category models
 * @since 0.1.0
 */
export interface RunStart {
  readonly verb: string
  readonly pattern: string
  readonly jobs: number
  readonly targets: ReadonlyArray<{ readonly label: string; readonly target: string }>
}

/**
 * The events execution reports.
 *
 * `note` carries the free-form progress lines the executors already write,
 * `label  message` for a line about one target and `smthrs: message` for a
 * line about the run. `toolOutput` is the hook for a child process's streams;
 * no executor streams a child today, `ExecLive` captures both pipes and
 * folds their tails into the failure message, so nothing calls it yet.
 * `close` restores the terminal and must run even when execution throws.
 *
 * @category models
 * @since 0.1.0
 */
export interface Reporter {
  readonly renderer: Renderer
  readonly begin: (run: RunStart) => void
  readonly targetStarted: (label: string) => void
  readonly targetFinished: (report: TargetReport) => void
  readonly toolOutput: (label: string, stream: "stdout" | "stderr", chunk: string) => void
  readonly note: (line: string) => void
  readonly warn: (line: string) => void
  readonly summary: (summary: Summary) => void
  readonly close: () => void
}

/**
 * Renders a duration for status lines: tenths of a second from one second
 * up, whole milliseconds below.
 *
 * @category formatting
 * @since 0.1.0
 */
export const formatDuration = (durationMs: number): string =>
  durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${Math.round(durationMs)}ms`

/**
 * The status line the plain renderer prints for one settled target.
 *
 * @category formatting
 * @since 0.1.0
 */
export const plainLine = (report: TargetReport): string => {
  const line = `${report.label}  ${report.status}  ${formatDuration(report.durationMs)}`
  return report.error === undefined ? line : `${line}  ${report.error}`
}

/**
 * The end line the plain renderer prints for one run.
 *
 * @category formatting
 * @since 0.1.0
 */
export const plainSummary = (summary: Summary): string =>
  `${summary.results.length} targets: ${summary.counts.hit} hit, ${summary.counts.ran} ran, ` +
  `${summary.counts.failed} failed, ${summary.counts.skipped} skipped (${formatDuration(summary.durationMs)})`

const noop = (): void => {}

const lines = (chunk: string): ReadonlyArray<string> => {
  const split = chunk.split(/\r?\n/)
  if (split.at(-1) === "") split.pop()
  return split
}

/**
 * The renderer that prints the historical lines and nothing else.
 *
 * @category constructors
 * @since 0.1.0
 */
export const plain = (writeLine: (line: string) => void): Reporter => ({
  renderer: "plain",
  begin: noop,
  targetStarted: noop,
  targetFinished: (report) => writeLine(plainLine(report)),
  toolOutput: (label, _stream, chunk) => {
    for (const line of lines(chunk)) writeLine(`${label}: ${line}`)
  },
  note: writeLine,
  warn: writeLine,
  summary: (summary) => writeLine(plainSummary(summary)),
  close: noop
})

/**
 * What {@link make} needs beyond the renderer.
 *
 * `now` and `interval` exist for tests: a fake clock makes elapsed times
 * deterministic and `interval: false` stops the spinner timer so output is a
 * pure function of the events.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly renderer: Renderer
  readonly terminal: Terminal
  readonly env?: Ansi.Environment | undefined
  readonly now?: (() => number) | undefined
  readonly interval?: number | false | undefined
}

const glyph: Record<TargetReport["status"], string> = { ran: "✓", hit: "○", failed: "✗", skipped: "↷" }
const statusWord: Record<TargetReport["status"], string> = {
  ran: "",
  hit: "cached",
  failed: "failed",
  skipped: "skipped"
}
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const defaultInterval = 80
const maximumLiveRows = 12
const durationWidth = 7
const statusWidth = 7

/** Turborepo's per-task prefix palette, cycled in first-seen order. */
const prefixColors = ["cyan", "magenta", "green", "yellow", "blue"] as const

const labelNote = /^(\/\/\S*|:\S+) {2}(.*)$/s

const pretty = (options: MakeOptions, live: boolean): Reporter => {
  const terminal = options.terminal
  const env = options.env ?? process.env
  const c = Ansi.palette(env, terminal.isTTY)
  const now = options.now ?? (() => performance.now())
  const interval = options.interval ?? defaultInterval
  // A pty with no window size reports zero columns; that is unknown, not narrow.
  const columns = (): number => {
    const reported = terminal.columns
    return reported === undefined || reported <= 0 ? 80 : Math.max(24, reported)
  }
  let labelWidth = 0
  let total = 0
  let done = 0
  let startedAt = now()
  let pinned = 0
  let frame = 0
  let timer: NodeJS.Timeout | undefined
  let hidden = false
  const running = new Map<string, number>()
  const prefixes = new Map<string, (text: string) => string>()

  const restoreCursor = (): void => terminal.write(Ansi.showCursor)

  const liveLines = (): ReadonlyArray<string> => {
    const spinner = c.cyan(spinnerFrames[frame % spinnerFrames.length]!)
    const rows = [...running.entries()].slice(0, maximumLiveRows - 1).map(([label, since]) =>
      `${spinner} ${label.padEnd(labelWidth)}  ${c.dim(formatDuration(now() - since).padStart(durationWidth))}`
    )
    if (running.size > rows.length) rows.push(c.dim(`  … ${running.size - rows.length} more running`))
    const status = `${done}/${total} done · ${running.size} running · ${formatDuration(now() - startedAt)}`
    rows.push(c.dim(`  ${status}`))
    return rows
  }

  const paint = (scrolled: ReadonlyArray<string>): void => {
    if (!live) {
      if (scrolled.length > 0) terminal.write(`${scrolled.join("\n")}\n`)
      return
    }
    let out = pinned > 0 ? `${Ansi.cursorUp(pinned)}${Ansi.eraseDown}` : ""
    for (const line of scrolled) out += `${line}\n`
    const region = running.size === 0 ? [] : liveLines().map((line) => Ansi.truncate(line, columns() - 1))
    for (const line of region) out += `${line}\n`
    pinned = region.length
    if (out !== "") terminal.write(out)
  }

  const startTimer = (): void => {
    if (!live || interval === false || timer !== undefined) return
    timer = setInterval(() => {
      frame += 1
      paint([])
    }, interval)
    timer.unref()
  }

  const stopTimer = (): void => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }

  const finishedLines = (report: TargetReport): ReadonlyArray<string> => {
    const duration = formatDuration(report.durationMs).padStart(durationWidth)
    const word = statusWord[report.status].padEnd(statusWidth)
    const label = report.label.padEnd(labelWidth)
    const head = ((): string => {
      switch (report.status) {
        case "ran":
          return `${c.green(glyph.ran)} ${label}  ${word}  ${c.dim(duration)}`
        case "hit":
          return c.dim(`${glyph.hit} ${label}  ${word}  ${duration}`)
        case "failed":
          return `${c.red(glyph.failed)} ${c.red(c.bold(label))}  ${c.red(word)}  ${c.dim(duration)}`
        case "skipped":
          return `${c.yellow(glyph.skipped)} ${c.dim(label)}  ${c.yellow(word)}  ${c.dim(duration)}`
      }
    })()
    if (report.error === undefined) return [head]
    const [first, ...rest] = report.error.split("\n")
    const detail = [`    ${report.status === "failed" ? c.red(first ?? "") : c.dim(first ?? "")}`]
    // A line the producer indented is a finding, one item of a list; anything
    // else is a tool's own output and is shown as the tool wrote it.
    for (const line of rest) {
      if (line.trim() === "") continue
      detail.push(line.startsWith("  ") ? `      ${c.dim("•")} ${line.trim()}` : `    ${line}`)
    }
    return [head, ...detail]
  }

  const prefixFor = (label: string): (text: string) => string => {
    const existing = prefixes.get(label)
    if (existing !== undefined) return existing
    const color = c[prefixColors[prefixes.size % prefixColors.length]!]
    const styled = (text: string): string => `${color(`${label} │`)} ${text}`
    prefixes.set(label, styled)
    return styled
  }

  const warnLine = (line: string): string =>
    c.yellow(`⚠ ${line.startsWith("smthrs: ") ? line.slice("smthrs: ".length) : line}`)

  const noteLine = (line: string): string => {
    if (line.startsWith("smthrs: ")) return warnLine(line)
    const scoped = labelNote.exec(line)
    if (scoped !== null) return c.dim(`  ${scoped[1]}  ${scoped[2]}`)
    return c.dim(`  ${line}`)
  }

  const footer = (summary: Summary): ReadonlyArray<string> => {
    const counts = summary.counts
    const segments: Array<string> = []
    if (counts.ran > 0) segments.push(c.green(`${counts.ran} ran`))
    if (counts.hit > 0) segments.push(`${counts.hit} cached`)
    if (counts.failed > 0) segments.push(c.red(`${counts.failed} failed`))
    if (counts.skipped > 0) segments.push(c.yellow(`${counts.skipped} skipped`))
    segments.push(`${summary.results.length} total`)
    const fullCache = summary.results.length > 0 && counts.hit === summary.results.length
    const time = `${c.bold("Time:")} ${formatDuration(summary.durationMs)}`
    const tasks = `${c.bold("Tasks:")} ${segments.join(", ")}`
    const out = ["", `${tasks} · ${time}${fullCache ? ` ${c.magenta(c.bold(">>> FULL CACHE"))}` : ""}`]
    if (counts.failed > 0) {
      const failed = summary.results.filter((entry) => entry.status === "failed").map((entry) => entry.label)
      out.push(c.red(c.bold(`✗ ${counts.failed} of ${summary.results.length} targets failed: ${failed.join(", ")}`)))
    }
    return out
  }

  return {
    renderer: live ? "tty" : "stream",
    begin: (run) => {
      total = run.targets.length
      done = 0
      startedAt = now()
      labelWidth = Math.min(
        Math.max(0, ...run.targets.map((target) => target.label.length)),
        Math.max(20, columns() - durationWidth - statusWidth - 8)
      )
      const what = run.verb === "auto" ? run.pattern : `${run.verb} ${run.pattern}`
      const plural = total === 1 ? "target" : "targets"
      if (live) {
        hidden = true
        terminal.write(Ansi.hideCursor)
        process.once("exit", restoreCursor)
      }
      paint([`${c.cyan("▸")} ${c.bold(what)}  ${c.dim(`${total} ${plural} · ${run.jobs} jobs`)}`])
    },
    targetStarted: (label) => {
      running.set(label, now())
      startTimer()
      paint(live ? [] : [c.dim(`  ▸ ${label}`)])
    },
    targetFinished: (report) => {
      running.delete(report.label)
      done += 1
      if (running.size === 0) stopTimer()
      paint(finishedLines(report))
    },
    toolOutput: (label, _stream, chunk) => {
      const prefix = prefixFor(label)
      paint(lines(chunk).map(prefix))
    },
    note: (line) => paint([noteLine(line)]),
    warn: (line) => paint([warnLine(line)]),
    summary: (summary) => {
      running.clear()
      stopTimer()
      paint(footer(summary))
    },
    close: () => {
      stopTimer()
      running.clear()
      if (pinned > 0) {
        terminal.write(`${Ansi.cursorUp(pinned)}${Ansi.eraseDown}`)
        pinned = 0
      }
      if (hidden) {
        hidden = false
        process.removeListener("exit", restoreCursor)
        restoreCursor()
      }
    }
  }
}

/**
 * Builds the reporter for one renderer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Reporter => {
  switch (options.renderer) {
    case "plain":
      return plain((line) => options.terminal.write(`${line}\n`))
    case "stream":
      return pretty(options, false)
    case "tty":
      return pretty(options, true)
  }
}

/**
 * The reporter an executor runs under: the one it was given, else the plain
 * renderer over its `log` sink, else the plain renderer over standard error.
 * This is what keeps `log` callers, the tests among them, byte-for-byte where
 * they were.
 *
 * @category constructors
 * @since 0.1.0
 */
export const of = (options: {
  readonly reporter?: Reporter | undefined
  readonly log?: ((line: string) => void) | undefined
}): Reporter => {
  if (options.reporter !== undefined) return options.reporter
  const sink = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  return plain(sink)
}
