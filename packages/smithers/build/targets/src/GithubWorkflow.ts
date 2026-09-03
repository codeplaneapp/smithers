/**
 * Reading and rendering GitHub Actions workflow files.
 *
 * A generated CI pipeline is only worth anything if it still runs the gates
 * the repository requires. `GithubCiGen` used to render five hard-coded steps
 * whose whole pipeline was one `pnpm dlx @smthrs/build-cli ci //...` invocation, and it
 * declared `.github/workflows/ci.yml` as its output — so building the root
 * target replaced a multi-job pipeline (typecheck, lint, circular-dependency
 * guard, browser bundle gate, release pack smoke test, Rust fmt/clippy/test,
 * WASM reproducibility, Bun, macOS, Windows) with a single job that ran none
 * of them.
 *
 * This module supplies the two halves of the fix: a renderer that can express a
 * real multi-job pipeline rather than a fixed five-step one, and a workflow
 * reader, so the rendered pipeline can be checked against the gates the
 * repository declared before a single byte is written.
 *
 * The reader is a targeted GitHub-workflow scanner, not a general YAML
 * implementation. It handles exactly the constructs a workflow uses — nested
 * block maps, block sequences at their own or their key's indentation,
 * `run: |` and conservatively folded `run: >` block scalars, flow maps
 * (`with: { node-version: 22 }`), quoted scalars, and comments — and REFUSES
 * anything it does not understand rather than guessing. Failing closed is the
 * point: a gate this module could not see is reported missing, never assumed
 * present. Taking a YAML dependency was rejected because the workspace
 * dependency policy is closed and `js-yaml` is only present transitively.
 *
 * @since 0.1.0
 */

import { Buffer } from "node:buffer"

/**
 * Maximum encoded workflow size accepted by the structural parser.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumWorkflowBytes = 1024 * 1024

/**
 * One step of a workflow job.
 *
 * @category models
 * @since 0.1.0
 */
export interface WorkflowStep {
  readonly name: string | undefined
  readonly uses: string | undefined
  readonly run: string | undefined
  /** The declared run shell, or `undefined` for the GitHub runner default. */
  readonly shell: string | undefined
  /** The raw `if:` expression, or `undefined` when the step declares none. */
  readonly condition: string | undefined
  /** The raw `continue-on-error:` value, or `undefined` when unset. */
  readonly continueOnError: string | undefined
}

/**
 * One job of a workflow.
 *
 * @category models
 * @since 0.1.0
 */
export interface WorkflowJob {
  readonly id: string
  readonly name: string | undefined
  readonly runsOn: string | undefined
  /** A reusable workflow reference, for a job that delegates with `uses:`. */
  readonly uses: string | undefined
  /** The raw `if:` expression, or `undefined` when the job declares none. */
  readonly condition: string | undefined
  /** The raw `continue-on-error:` value, or `undefined` when unset. */
  readonly continueOnError: string | undefined
  readonly steps: ReadonlyArray<WorkflowStep>
}

/**
 * A parsed workflow file.
 *
 * @category models
 * @since 0.1.0
 */
export interface Workflow {
  readonly name: string | undefined
  readonly jobs: ReadonlyArray<WorkflowJob>
}

/**
 * A workflow file could not be read as a GitHub Actions workflow.
 *
 * @category errors
 * @since 0.1.0
 */
export class WorkflowParseError extends Error {
  override readonly name = "WorkflowParseError"
  readonly line: number

  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`)
    this.line = line
  }
}

interface Line {
  readonly number: number
  readonly indent: number
  readonly text: string
}

/** Strips a trailing comment that is not inside a quoted scalar. */
const stripComment = (text: string): string => {
  let quote: string | undefined
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (quote !== undefined) {
      if (quote === "\"" && character === "\\") {
        index += 1
        continue
      }
      if (quote === "'" && character === "'" && text[index + 1] === "'") {
        index += 1
        continue
      }
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === "\"") {
      quote = character
      continue
    }
    // A `#` only opens a comment at the start of the line or after a space,
    // which is YAML's own target and keeps `${{ ... }}` and URLs intact.
    if (character === "#" && (index === 0 || text[index - 1] === " ")) {
      return text.slice(0, index)
    }
  }
  return text
}

/** Decodes the quoted scalar forms the scanner deliberately supports. */
const decodeScalar = (value: string, line: number): string => {
  const trimmed = value.trim()
  if (!trimmed.startsWith("\"") && !trimmed.startsWith("'")) return trimmed
  const quote = trimmed[0]!
  if (trimmed.length < 2 || !trimmed.endsWith(quote)) {
    throw new WorkflowParseError(line, `unterminated quoted scalar ${JSON.stringify(trimmed)}`)
  }
  if (quote === "\"") {
    try {
      const decoded: unknown = JSON.parse(trimmed)
      if (typeof decoded === "string") return decoded
    } catch {
      // YAML has more double-quoted escapes than JSON. Refusing those is
      // conservative: decoding only a subset can change shell quoting and
      // invent a command boundary that GitHub never receives.
    }
    throw new WorkflowParseError(line, `unsupported double-quoted scalar ${JSON.stringify(trimmed)}`)
  }
  const inner = trimmed.slice(1, -1)
  let decoded = ""
  for (let index = 0; index < inner.length; index++) {
    const character = inner[index]!
    if (character !== "'") {
      decoded += character
      continue
    }
    if (inner[index + 1] !== "'") {
      throw new WorkflowParseError(line, `unsupported single-quoted scalar ${JSON.stringify(trimmed)}`)
    }
    decoded += "'"
    index += 1
  }
  return decoded
}

/**
 * Splits the source into significant lines, rejecting tab indentation, which
 * YAML forbids and which would silently shift the structure this scanner
 * derives from indentation.
 */
const significantLines = (source: string): ReadonlyArray<Line> => {
  const lines: Array<Line> = []
  const raw = source.split("\n")
  for (let index = 0; index < raw.length; index++) {
    const original = raw[index]!
    if (original.includes("\t") && original.slice(0, original.search(/\S|$/)).includes("\t")) {
      throw new WorkflowParseError(index + 1, "tab indentation is not valid YAML")
    }
    const withoutComment = stripComment(original)
    if (withoutComment.trim() === "") continue
    lines.push({
      number: index + 1,
      indent: withoutComment.length - withoutComment.trimStart().length,
      text: withoutComment.trimEnd()
    })
  }
  return lines
}

/**
 * Reads a block scalar (`|`, `>`, and their chomping variants). Explicit
 * indentation indicators are refused because this scanner does not implement
 * their distinct indentation targets.
 * Literal scalars preserve line breaks. Folded scalars join every physical
 * line with a space: YAML preserves a few breaks around blank or more-indented
 * lines, but treating those as spaces is deliberately conservative for a gate
 * scanner. It may cost a match; it can never invent a command boundary that
 * the shell does not receive.
 */
const readBlockScalar = (
  source: ReadonlyArray<string>,
  startLine: number,
  parentIndent: number,
  folded: boolean
): { readonly text: string; readonly next: number } => {
  const body: Array<string> = []
  let index = startLine
  // YAML takes a block scalar's indentation from its first non-empty line,
  // not from the key's indentation plus one.
  let contentIndent: number | undefined
  while (index < source.length) {
    const line = source[index]!
    if (line.trim() === "") {
      body.push("")
      index += 1
      continue
    }
    const indent = line.length - line.trimStart().length
    if (indent <= parentIndent) break
    if (contentIndent === undefined) contentIndent = indent
    if (indent < contentIndent) {
      throw new WorkflowParseError(index + 1, "block scalar content is indented less than its first content line")
    }
    body.push(line.slice(contentIndent))
    index += 1
  }
  while (body.length > 0 && body[body.length - 1] === "") body.pop()
  return { text: body.join(folded ? " " : "\n"), next: index }
}

/**
 * A `key: |` line that opens a block scalar. The key may be quoted, because a
 * quoted key is still a key: missing one would leave the scalar's body to the
 * structural walk, which reads it as YAML and refuses the workflow.
 */
const blockScalarLine = /^\s*(?:-\s+)?(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+):\s*([|>][+-]?\d*)\s*$/

/**
 * Whether a line opens a block-sequence item.
 *
 * YAML lets a block sequence sit at its key's own indentation, which is how
 * `needs:` and `steps:` are most often written:
 *
 * ```yaml
 *     needs:
 *     - build
 * ```
 *
 * A scanner that took indentation alone would leave those items outside the
 * block they belong to and then refuse the workflow for a shape that is
 * ordinary YAML.
 */
const sequenceItem = (line: Line): boolean => line.text.trimStart().startsWith("- ") || line.text.trim() === "-"

/** Whether a line still belongs to the block opened at `indent`. */
const inBlock = (line: Line, indent: number): boolean =>
  line.indent > indent || (line.indent === indent && sequenceItem(line))

/**
 * Parses a GitHub Actions workflow.
 *
 * A duplicate mapping key — a repeated top-level key, job id, job field, or
 * step field — is refused at every level this scanner reads. YAML forbids one
 * and the last occurrence wins, so accepting it would let a gate match a job,
 * a `steps:` block, or a `run:` script that GitHub never executes.
 *
 * @category parsing
 * @since 0.1.0
 */
export const parseWorkflow = (source: string): Workflow => {
  if (Buffer.byteLength(source, "utf8") > maximumWorkflowBytes) {
    throw new WorkflowParseError(1, `workflow source is larger than ${maximumWorkflowBytes} bytes`)
  }
  const raw = source.split("\n")
  const lines = significantLines(source)
  // Block scalars are consumed from the RAW lines (blank and comment lines
  // inside a script are content, not structure), so the structural walk skips
  // every line a scalar swallowed.
  const consumed = new Set<number>()
  const scalars = new Map<number, string>()
  for (const line of lines) {
    // A script line that happens to look like `key: |2` is shell text, not a
    // nested YAML scalar. Its enclosing scalar has already claimed the line.
    if (consumed.has(line.number)) continue
    const scalar = blockScalarLine.exec(line.text)
    if (scalar === null) continue
    if (/\d/.test(scalar[1]!)) {
      throw new WorkflowParseError(line.number, "explicit block-scalar indentation is not supported")
    }
    const block = readBlockScalar(raw, line.number, line.indent, scalar[1]!.startsWith(">"))
    scalars.set(line.number, block.text)
    for (let number = line.number + 1; number <= block.next; number++) consumed.add(number)
  }
  const structural = lines.filter((line) => !consumed.has(line.number))

  let name: string | undefined
  const jobs: Array<WorkflowJob> = []
  const jobIds = new Set<string>()
  const topKeys = new Set<string>()
  let index = 0

  const entry = (line: Line): { readonly key: string; readonly value: string; readonly item: boolean } => {
    const item = sequenceItem(line)
    const body = item ? line.text.trimStart().replace(/^-\s*/, "") : line.text.trim()
    // A key may be quoted, and a quoted key may carry a `:` of its own, so the
    // separator is looked for past the closing quote. Reading `"a: b": c` as
    // the key `"a` would invent a job id and a step field that do not exist.
    const quote = body[0]
    let from = 0
    if (quote === "\"" || quote === "'") {
      let close = -1
      for (let cursor = 1; cursor < body.length; cursor++) {
        if (quote === "\"" && body[cursor] === "\\") {
          cursor += 1
          continue
        }
        if (quote === "'" && body[cursor] === "'" && body[cursor + 1] === "'") {
          cursor += 1
          continue
        }
        if (body[cursor] === quote) {
          close = cursor
          break
        }
      }
      if (close === -1) {
        throw new WorkflowParseError(line.number, `unterminated quoted key in ${JSON.stringify(body)}`)
      }
      from = close + 1
    }
    const separator = body.indexOf(":", from)
    if (separator === -1) {
      throw new WorkflowParseError(line.number, `expected a "key: value" mapping entry, found ${JSON.stringify(body)}`)
    }
    // The key is unquoted, because `"test":` and `test:` are the same key. A
    // gate or a required job pinned to `test` must see the job either way, and
    // the duplicate-key check must see the two spellings as one key.
    return { key: decodeScalar(body.slice(0, separator), line.number), value: body.slice(separator + 1).trim(), item }
  }

  const eventName = (value: string, line: number): string => {
    const decoded = decodeScalar(value, line)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(decoded)) {
      throw new WorkflowParseError(line, `${JSON.stringify(decoded)} is not a supported workflow event name shape`)
    }
    return decoded
  }

  while (index < structural.length) {
    const line = structural[index]!
    if (line.indent !== 0) {
      throw new WorkflowParseError(line.number, "unexpected indentation at the top level")
    }
    const top = entry(line)
    if (top.item) {
      throw new WorkflowParseError(line.number, "expected a mapping entry at the top level, not a sequence item")
    }
    // A repeated top-level key is the same defect as a repeated job id, one
    // level up: YAML keeps the LAST `jobs:` mapping, so gates matched against
    // the shadowed one would be reported present while GitHub runs none of it.
    if (topKeys.has(top.key)) {
      throw new WorkflowParseError(line.number, `duplicate top-level key ${JSON.stringify(top.key)}`)
    }
    topKeys.add(top.key)
    if (top.key === "name" && top.value !== "") {
      name = decodeScalar(top.value, line.number)
      index += 1
      continue
    }
    if (top.key === "on") {
      const scalar = scalars.get(line.number)
      index += 1
      const block: Array<Line> = []
      while (index < structural.length && inBlock(structural[index]!, 0)) {
        block.push(structural[index]!)
        index += 1
      }
      const value = scalar ?? decodeScalar(top.value, line.number)
      if (block.length === 0 && (value === "" || value === "{}" || value === "[]")) {
        throw new WorkflowParseError(line.number, "workflow declares no trigger")
      }
      if (block.length > 0) {
        if (value !== "") {
          throw new WorkflowParseError(line.number, "a workflow trigger cannot have both an inline value and a block")
        }
        const indent = block[0]!.indent
        const events = new Set<string>()
        let sequence: boolean | undefined
        for (const eventLine of block) {
          if (eventLine.indent < indent) {
            throw new WorkflowParseError(eventLine.number, "inconsistent indentation in the workflow trigger block")
          }
          if (eventLine.indent !== indent) continue
          const item = sequenceItem(eventLine)
          if (sequence !== undefined && sequence !== item) {
            throw new WorkflowParseError(eventLine.number, "workflow trigger block mixes a mapping and a sequence")
          }
          sequence = item
          const event = item
            ? eventName(eventLine.text.trimStart().replace(/^-\s*/, ""), eventLine.number)
            : eventName(entry(eventLine).key, eventLine.number)
          if (events.has(event)) {
            throw new WorkflowParseError(eventLine.number, `duplicate workflow event ${JSON.stringify(event)}`)
          }
          events.add(event)
        }
        if (events.size === 0) throw new WorkflowParseError(line.number, "workflow declares no trigger")
      } else if (value.startsWith("[")) {
        if (!value.endsWith("]")) {
          throw new WorkflowParseError(line.number, "unterminated inline workflow event sequence")
        }
        const events = value.slice(1, -1).split(",").map((event) => event.trim())
        if (events.length === 0 || events.some((event) => event === "")) {
          throw new WorkflowParseError(line.number, "workflow declares no trigger")
        }
        const decoded = events.map((event) => eventName(event, line.number))
        if (new Set(decoded).size !== decoded.length) {
          throw new WorkflowParseError(line.number, "workflow event sequence contains a duplicate event")
        }
      } else if (value.startsWith("{") || value.endsWith("}")) {
        throw new WorkflowParseError(line.number, "inline workflow event mappings are not supported")
      } else {
        eventName(value, line.number)
      }
      continue
    }
    if (top.key === "defaults" || top.key === "<<") {
      throw new WorkflowParseError(
        line.number,
        `top-level ${JSON.stringify(top.key)} is not supported by the gate scanner`
      )
    }
    if (top.key !== "jobs") {
      // Skip the whole block of any top-level key that is not `jobs`.
      index += 1
      while (index < structural.length && inBlock(structural[index]!, 0)) index += 1
      continue
    }
    if (top.value !== "") {
      throw new WorkflowParseError(line.number, "inline `jobs` mappings are not supported")
    }
    index += 1
    while (index < structural.length && structural[index]!.indent > 0) {
      const jobLine = structural[index]!
      const jobIndent = jobLine.indent
      const job = entry(jobLine)
      if (job.item) {
        throw new WorkflowParseError(jobLine.number, "expected a job mapping entry, not a sequence item")
      }
      if (job.value !== "") {
        throw new WorkflowParseError(jobLine.number, `job ${JSON.stringify(job.key)} must be a block mapping`)
      }
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(job.key)) {
        throw new WorkflowParseError(jobLine.number, `${JSON.stringify(job.key)} is not a valid GitHub Actions job id`)
      }
      let jobName: string | undefined
      let runsOn: string | undefined
      let jobUses: string | undefined
      let jobCondition: string | undefined
      let jobContinueOnError: string | undefined
      const steps: Array<WorkflowStep> = []
      const jobKeys = new Set<string>()
      index += 1
      while (index < structural.length && structural[index]!.indent > jobIndent) {
        const bodyLine = structural[index]!
        const bodyIndent = bodyLine.indent
        const field = entry(bodyLine)
        if (field.item) {
          throw new WorkflowParseError(
            bodyLine.number,
            `expected a mapping entry in job ${JSON.stringify(job.key)}, not a sequence item`
          )
        }
        // A second `steps:` in one job shadows the first, so its steps never
        // run. Concatenating them would report a gate present that GitHub
        // never executes.
        if (jobKeys.has(field.key)) {
          throw new WorkflowParseError(
            bodyLine.number,
            `duplicate key ${JSON.stringify(field.key)} in job ${JSON.stringify(job.key)}`
          )
        }
        jobKeys.add(field.key)
        if (field.key === "defaults" || field.key === "<<") {
          throw new WorkflowParseError(
            bodyLine.number,
            `${JSON.stringify(field.key)} in job ${JSON.stringify(job.key)} is not supported by the gate scanner`
          )
        }
        if (field.key === "name") {
          jobName = decodeScalar(field.value, bodyLine.number)
          index += 1
          continue
        }
        if (field.key === "runs-on") {
          runsOn = decodeScalar(field.value, bodyLine.number)
          index += 1
          continue
        }
        if (field.key === "uses") {
          jobUses = decodeScalar(field.value, bodyLine.number)
          index += 1
          continue
        }
        // A conditional job is not proof that a gate still runs, so the
        // condition is carried out of the scan rather than dropped. An `if:`
        // whose value is not on the key's own line reads as the empty string,
        // which is not the always-true literal and therefore fails closed.
        if (field.key === "if") {
          jobCondition = scalars.get(bodyLine.number) ?? decodeScalar(field.value, bodyLine.number)
          index += 1
          while (index < structural.length && inBlock(structural[index]!, bodyIndent)) index += 1
          continue
        }
        if (field.key === "continue-on-error") {
          jobContinueOnError = decodeScalar(field.value, bodyLine.number)
          index += 1
          continue
        }
        if (field.key !== "steps") {
          index += 1
          while (index < structural.length && inBlock(structural[index]!, bodyIndent)) index += 1
          continue
        }
        if (field.value !== "") {
          throw new WorkflowParseError(bodyLine.number, "`steps` must be a block sequence")
        }
        index += 1
        while (index < structural.length && inBlock(structural[index]!, bodyIndent)) {
          const stepLine = structural[index]!
          const first = entry(stepLine)
          if (!first.item) {
            throw new WorkflowParseError(stepLine.number, "expected a `-` sequence item inside `steps`")
          }
          // A sequence item's own fields are indented to where its first key
          // starts, which is two past the `-`.
          const fieldIndent = stepLine.indent + stepLine.text.trimStart().indexOf("- ") + 2
          let stepName: string | undefined
          let uses: string | undefined
          let run: string | undefined
          let shell: string | undefined
          let stepCondition: string | undefined
          let stepContinueOnError: string | undefined
          const stepKeys = new Set<string>()
          const take = (
            key: string,
            value: string,
            lineNumber: number,
            lineIndent: number
          ): void => {
            // Same target again: the last duplicate wins, so a step whose first
            // `run:` is shadowed would lend its text to a gate for nothing.
            if (stepKeys.has(key)) {
              throw new WorkflowParseError(
                lineNumber,
                `duplicate key ${JSON.stringify(key)} in a step of job ${JSON.stringify(job.key)}`
              )
            }
            stepKeys.add(key)
            const scalar = scalars.get(lineNumber)
            const resolved = scalar ?? decodeScalar(value, lineNumber)
            if (key === "name") stepName = resolved
            else if (key === "uses") uses = resolved
            else if (key === "run") run = resolved
            else if (key === "shell") shell = resolved
            else if (key === "if") stepCondition = resolved
            else if (key === "continue-on-error") stepContinueOnError = resolved
            void lineIndent
          }
          take(first.key, first.value, stepLine.number, stepLine.indent)
          index += 1
          while (index < structural.length && structural[index]!.indent >= fieldIndent) {
            const nested = structural[index]!
            const nestedEntry = entry(nested)
            if (nestedEntry.item) break
            if (nested.indent === fieldIndent) {
              take(nestedEntry.key, nestedEntry.value, nested.number, nested.indent)
              index += 1
              while (index < structural.length && structural[index]!.indent > fieldIndent) index += 1
              continue
            }
            index += 1
          }
          if ((uses === undefined) === (run === undefined)) {
            throw new WorkflowParseError(
              stepLine.number,
              `a step of job ${JSON.stringify(job.key)} must declare exactly one of \`uses\` or \`run\``
            )
          }
          if ((uses ?? run)!.trim() === "") {
            throw new WorkflowParseError(
              stepLine.number,
              `a step of job ${JSON.stringify(job.key)} has an empty ${uses === undefined ? "run" : "uses"} value`
            )
          }
          if (stepKeys.has("<<")) {
            throw new WorkflowParseError(
              stepLine.number,
              `a YAML merge in a step of job ${JSON.stringify(job.key)} is not supported by the gate scanner`
            )
          }
          if (shell !== undefined && shell.trim() === "") {
            throw new WorkflowParseError(stepLine.number, `a step of job ${JSON.stringify(job.key)} has an empty shell`)
          }
          steps.push({
            name: stepName,
            uses,
            run,
            shell,
            condition: stepCondition,
            continueOnError: stepContinueOnError
          })
        }
      }
      if (jobUses !== undefined) {
        if (jobUses.trim() === "") {
          throw new WorkflowParseError(
            jobLine.number,
            `reusable job ${JSON.stringify(job.key)} has an empty uses value`
          )
        }
        if (runsOn !== undefined || jobKeys.has("steps")) {
          throw new WorkflowParseError(
            jobLine.number,
            `reusable job ${JSON.stringify(job.key)} cannot also declare runs-on or steps`
          )
        }
      } else {
        if (runsOn === undefined || runsOn.trim() === "") {
          throw new WorkflowParseError(jobLine.number, `job ${JSON.stringify(job.key)} declares no runner`)
        }
        if (!jobKeys.has("steps") || steps.length === 0) {
          throw new WorkflowParseError(jobLine.number, `job ${JSON.stringify(job.key)} declares no steps`)
        }
      }
      // A duplicate mapping key is invalid YAML, and GitHub keeps the LAST
      // one: a gate matched against the shadowed job would be reported present
      // while the pipeline never runs it. Refuse instead of choosing.
      if (jobIds.has(job.key)) {
        throw new WorkflowParseError(jobLine.number, `duplicate job id ${JSON.stringify(job.key)}`)
      }
      jobIds.add(job.key)
      jobs.push({
        id: job.key,
        name: jobName,
        runsOn,
        uses: jobUses,
        condition: jobCondition,
        continueOnError: jobContinueOnError,
        steps
      })
    }
  }
  if (!topKeys.has("on")) throw new WorkflowParseError(1, "workflow is missing the required top-level `on` trigger")
  if (!topKeys.has("jobs")) throw new WorkflowParseError(1, "workflow is missing the required top-level `jobs` mapping")
  if (jobs.length === 0) throw new WorkflowParseError(1, "workflow declares no jobs")
  return { name, jobs }
}

/**
 * A command a workflow must still run.
 *
 * `command` is matched as a WHOLE COMMAND at a shell command boundary of some
 * step's `run` body — never as a substring. It must start where the shell would
 * start reading a command (the beginning of the script, or after `\n`, `;`,
 * `&`, `&&`, `|`, `||`, a subshell or command-substitution `(`, or one of the
 * `if`/`then`/`else`/`elif`/`while`/`until`/`do`/`{`/`}`/`!`/`time`/`sudo`/
 * `exec` words that introduce one, across a `\`-newline line continuation), it
 * must sit outside every quoted string, and the character after it must end a
 * shell word. So `echo pnpm run check` and `"pnpm run check"` do not satisfy a
 * `pnpm run check` gate, while `if ! cmp a b; then`, `(cd x && bun …)`,
 * `corepack enable && \` + `pnpm run check`, and
 * `pnpm install --frozen-lockfile --ignore-scripts` still do. Arguments and
 * flags after the declared command are allowed; a longer command name
 * (`pnpm run checkall`) is not.
 *
 * A gate whose command names an action instead matches a step's `uses` value
 * exactly, or the same action at any version (`actions/checkout` matches
 * `actions/checkout@v4`). It never matches a `uses` that merely contains it.
 *
 * `job`, when given, also requires the command to appear in that job, which is
 * how a gate that must run on a specific platform (macOS, Windows, Bun) is
 * pinned to it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Gate {
  readonly name: string
  readonly command: string
  readonly job?: string | undefined
}

/** Removes a shell comment from one script line, respecting quoting. */
const stripShellComment = (line: string): string => {
  let quote: string | undefined
  for (let index = 0; index < line.length; index++) {
    const character = line[index]!
    if (quote !== undefined) {
      if (character === "\\" && quote === "\"") {
        index += 1
        continue
      }
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === "\"") {
      quote = character
      continue
    }
    // A `#` opens a shell comment at the start of a word only, which keeps
    // `${{ ... }}`, `$#`, and `a#b` intact.
    if (character === "#" && (index === 0 || /\s/.test(line[index - 1]!))) return line.slice(0, index)
  }
  return line
}

/**
 * Strips shell comments from a `run` script, line by line.
 *
 * A gate proves a command still RUNS. Commented-out text is not a command, and
 * a workflow whose only remaining occurrence of `pnpm run check` sits behind a
 * `#` runs no typecheck — so the comment is removed before matching and the
 * gate is reported missing. Quoting state is not carried across lines, which
 * fails closed: a `#` inside a multi-line quoted string is treated as a
 * comment, costing a gate a match rather than inventing one.
 *
 * @category verification
 * @since 0.1.0
 */
export const stripShellComments = (script: string): string => script.split("\n").map(stripShellComment).join("\n")

/** Characters that end one shell command and open the next. */
const commandSeparators = new Set(["\n", ";", "&", "|", "(", ")"])

/**
 * Words that introduce a command rather than being one. `sudo`, `exec`, and
 * `time` run the command that follows them; the rest are shell keywords whose
 * next word is a command. `for`, `case`, and `select` are deliberately absent:
 * the word after them is a variable or a value, not a command.
 */
const commandIntroducers = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
  "time",
  "sudo",
  "exec"
])

/** A `NAME=value` prefix, which the shell applies before running the command. */
const assignmentPrefix = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Skips a quoted string, returning the index just past its closing quote. */
const skipQuoted = (script: string, open: number): number => {
  const quote = script[open]!
  let index = open + 1
  while (index < script.length) {
    const character = script[index]!
    // A backslash escapes inside `"…"` only; inside `'…'` it is literal.
    if (quote === "\"" && character === "\\") {
      index += 2
      continue
    }
    if (character === quote) return index + 1
    index += 1
  }
  // An unterminated quote swallows the rest of the script, which fails closed:
  // it can only cost a gate a match, never invent one.
  return script.length
}

/**
 * Skips a here-document, returning the index at the end of its terminator line.
 *
 * A here-document body is DATA the shell feeds to a command's stdin, never
 * commands it runs, so `cat <<'EOF' … pnpm run check … EOF` runs no typecheck.
 * The remainder of the opening line is skipped with the body, and an
 * unterminated here-document swallows the rest of the script: both can only
 * cost a gate a match, never invent one.
 */
const skipHereDocument = (script: string, open: number): number => {
  let index = open + 2
  const stripTabs = script[index] === "-"
  if (stripTabs) index += 1
  while (script[index] === " " || script[index] === "\t") index += 1
  let delimiter = ""
  while (index < script.length) {
    const character = script[index]!
    if (character === "'" || character === "\"") {
      const close = skipQuoted(script, index)
      delimiter += script.slice(index + 1, Math.max(index + 1, close - 1))
      index = close
      continue
    }
    if (/[\s;&|()<>]/.test(character)) break
    delimiter += character
    index += 1
  }
  const newline = script.indexOf("\n", index)
  if (delimiter === "" || newline === -1) return script.length
  let offset = newline + 1
  for (const line of script.slice(offset).split("\n")) {
    if (line === delimiter || (stripTabs && line.replace(/^\t+/, "") === delimiter)) {
      return Math.min(script.length, offset + line.length)
    }
    offset += line.length + 1
  }
  return script.length
}

/**
 * Returns the end of a shell function definition beginning at `start`.
 *
 * A function body is deferred code: merely declaring
 * `check() { pnpm run check; }` does not run the command. The gate scanner
 * therefore skips the complete balanced body. If the body is malformed, the
 * rest of the script is swallowed, which fails closed. Calling the function
 * later is also not expanded by this deliberately small scanner; callers that
 * require a gate should spell the required command directly.
 */
const functionDefinitionEnd = (script: string, start: number): number | undefined => {
  const header = script.slice(start).match(
    /^(?:(?:function[ \t\n]+[A-Za-z_][A-Za-z0-9_]*(?:[ \t\n]*\([ \t\n]*\))?)|(?:[A-Za-z_][A-Za-z0-9_]*[ \t\n]*\([ \t\n]*\)))[ \t\n]*\{/
  )
  if (header === null) return undefined
  let index = start + header[0].length
  let depth = 1
  while (index < script.length) {
    const character = script[index]!
    if (character === "'" || character === "\"") {
      index = skipQuoted(script, index)
      continue
    }
    if (character === "\\") {
      index += 2
      continue
    }
    if (character === "<" && script[index + 1] === "<" && script[index + 2] !== "<") {
      index = skipHereDocument(script, index)
      continue
    }
    if (character === "{") depth += 1
    if (character === "}") {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  return script.length
}

/**
 * One command the shell would run, as a half-open range of the script.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommandSpan {
  /** The offset of the command's first word. */
  readonly start: number
  /** The offset just past the command's last word, before its separator. */
  readonly end: number
}

/**
 * The commands the shell would run, each as the range its words occupy.
 *
 * This is the whole of the fail-closed gate contract: a command is only proof
 * that something RUNS when the shell would run it, so `echo pnpm run check`,
 * `"…; pnpm run check"`, and `xpnpm run check` yield no command span at the
 * gate's text. Constructs this scanner does not model (backticks, `eval`)
 * simply produce no span there, which reports the gate missing rather than
 * accepting text that may not run.
 *
 * A span ends where the shell stops reading the command: at a separator, at a
 * here-document, or at the end of the script. That is what lets a caller hold
 * the WHOLE command to a policy — {@link performsInstall} checks the install's
 * own flags — rather than only its first words.
 *
 * Shell-level control flow is the one thing it deliberately looks THROUGH: a
 * command inside an `if`, a loop body, or a `case` arm is reported as run,
 * because the flows pipeline's own byte-comparison gate lives inside
 * `if ! cmp …; then`. A workflow-level `if:` is the opposite — see
 * {@link alwaysRuns} — because GitHub may skip the whole job or step.
 *
 * @category verification
 * @since 0.1.0
 */
export const commandSpans = (script: string): ReadonlyArray<CommandSpan> => {
  const spans: Array<{ readonly start: number; end: number }> = []
  let open: { readonly start: number; end: number } | undefined
  let index = 0
  let expectCommand = true
  while (index < script.length) {
    const character = script[index]!
    if (character === " " || character === "\t") {
      index += 1
      continue
    }
    if (expectCommand) {
      const functionEnd = functionDefinitionEnd(script, index)
      if (functionEnd !== undefined) {
        index = functionEnd
        open = undefined
        // A following command still needs its own shell separator. Without
        // one, `f() { :; }pnpm run check` is a syntax error, not proof that
        // the shell starts another command at `pnpm`.
        expectCommand = false
        continue
      }
    }
    if (commandSeparators.has(character)) {
      open = undefined
      expectCommand = true
      index += 1
      continue
    }
    if (character === "'" || character === "\"") {
      // A quoted first word is not a command name this scanner will vouch for.
      index = skipQuoted(script, index)
      if (open !== undefined) open.end = index
      expectCommand = false
      continue
    }
    if (character === "\\") {
      // A backslash-newline is a line continuation: the shell joins the two
      // lines, so it neither ends the current command nor cancels a pending
      // one. `pnpm install --frozen-lockfile && \` still starts a command on
      // the next line, and reading the continuation as an ordinary escape
      // would report that command missing.
      if (script[index + 1] !== "\n") {
        if (open !== undefined) open.end = index + 2
        // Any other unquoted backslash escapes the next character, so
        // `echo \; pnpm run check` passes the `;` to `echo` and starts no
        // second command. Reading it as a separator would invent a command
        // boundary the shell does not have.
        expectCommand = false
      }
      index += 2
      continue
    }
    // `<<<` is a here-string, whose word is on this line; `<<` opens a body.
    if (character === "<" && script[index + 1] === "<" && script[index + 2] !== "<") {
      index = skipHereDocument(script, index)
      open = undefined
      expectCommand = true
      continue
    }
    const start = index
    while (index < script.length) {
      const next = script[index]!
      if (next === " " || next === "\t" || commandSeparators.has(next)) break
      if (next === "'" || next === "\"") {
        index = skipQuoted(script, index)
        continue
      }
      // The same escape target inside a word: `a\;b` is one argument, not two
      // commands.
      index += next === "\\" ? 2 : 1
    }
    if (expectCommand) {
      open = { start, end: index }
      spans.push(open)
      const word = script.slice(start, index)
      if (!commandIntroducers.has(word) && !assignmentPrefix.test(word)) expectCommand = false
    } else if (open !== undefined) {
      open.end = index
    }
  }
  return spans
}

/**
 * The offsets at which the shell would start reading a command.
 *
 * @category verification
 * @since 0.1.0
 */
export const commandStarts = (script: string): ReadonlyArray<number> => commandSpans(script).map((span) => span.start)

/** Whether a character ends the shell word a command name occupies. */
const endsWord = (character: string | undefined): boolean =>
  character === undefined || character === " " || character === "\t" ||
  character === "<" || character === ">" || commandSeparators.has(character)

/**
 * Whether a `run` script runs the given command.
 *
 * The command must begin at a shell command boundary and end at a word
 * boundary, so arguments and flags may follow it but a longer command name may
 * not. Shell comments come off first: commented-out text is not a command.
 *
 * @category verification
 * @since 0.1.0
 */
export const runsCommand = (script: string, command: string): boolean => {
  const wanted = command.trim()
  if (wanted === "") return false
  const text = stripShellComments(script)
  return commandStarts(text).some((start) => text.startsWith(wanted, start) && endsWord(text[start + wanted.length]))
}

/**
 * Whether a step's `uses` value is the action a gate names.
 *
 * The value must BE the action, either at the pinned reference the gate
 * declares or at any version of an unversioned one. A `uses` that merely
 * contains the gate's text — `my-org/actions/checkout@v4` against
 * `actions/checkout@v4` — is a different action and does not satisfy it.
 *
 * @category verification
 * @since 0.1.0
 */
export const usesAction = (uses: string, command: string): boolean => {
  const value = uses.trim()
  const wanted = command.trim()
  return wanted !== "" && (value === wanted || (!wanted.includes("@") && value.startsWith(`${wanted}@`)))
}

/**
 * Whether a parsed `if:` is provably always true.
 *
 * Only the literal is accepted. Anything else — `false`, a context expression,
 * a value the scanner could not read — leaves the job or step conditional, and
 * a conditional job or step is not proof that a required gate runs.
 *
 * @category verification
 * @since 0.1.0
 */
export const alwaysRuns = (condition: string | undefined): boolean => {
  if (condition === undefined) return true
  const normalized = condition.trim()
  if (normalized === "true") return true
  const expression = normalized.match(/^\$\{\{\s*(.*?)\s*\}\}$/)
  return expression !== null && expression[1] === "true"
}

/** Shell declarations for which the scanner can prove a `run` body executes. */
const executableShells = new Set(["bash", "sh", "pwsh", "powershell", "cmd"])

/**
 * Whether GitHub will execute a run body through a shell the scanner models.
 *
 * @category verification
 * @since 0.1.0
 */
export const executesRunScript = (shell: string | undefined): boolean =>
  shell === undefined || executableShells.has(shell.trim().toLowerCase())

/**
 * The declared required jobs a workflow does not unconditionally run.
 *
 * A required job is required to RUN, on the same terms as a gate: a job
 * carrying an `if:` is one GitHub may skip, so `if: false` on a required job is
 * a job the pipeline does not have. A job that exists but is conditional is
 * reported as `id (conditional)`, because "missing" would send an operator
 * looking for a job that is right there in the file.
 *
 * `continue-on-error` stays out of it, exactly as it does for a gate: a
 * required job asserts that the job runs, not that its failure blocks a merge,
 * and the advisory platform lanes are jobs that do run.
 *
 * @category verification
 * @since 0.1.0
 */
export const missingRequiredJobs = (
  workflow: Workflow,
  requiredJobs: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const declared = new Set(workflow.jobs.map((job) => job.id))
  const unconditional = new Set(
    workflow.jobs.filter((job) => alwaysRuns(job.condition)).map((job) => job.id)
  )
  return requiredJobs
    .filter((id) => !unconditional.has(id))
    .map((id) => declared.has(id) ? `${id} (conditional)` : id)
}

/**
 * Reports the declared gates a workflow no longer runs.
 *
 * A gate is satisfied only by an UNCONDITIONAL job and step: `if: false`, and
 * every other condition that is not the always-true literal, is a job or step
 * GitHub may skip, so it cannot prove an unconditional gate. `continue-on-error`
 * is deliberately not treated the same way — a gate asserts that a command is
 * still run, not that its failure blocks a merge, and the advisory macOS and
 * Windows lanes of a real pipeline are exactly the jobs a platform-pinned gate
 * exists to pin.
 *
 * @category verification
 * @since 0.1.0
 */
export const missingGates = (
  workflow: Workflow,
  gates: ReadonlyArray<Gate>
): ReadonlyArray<Gate> =>
  gates.filter((gate) => {
    const jobs = (gate.job === undefined
      ? workflow.jobs
      : workflow.jobs.filter((job) => job.id === gate.job)).filter((job) => alwaysRuns(job.condition))
    return !jobs.some((job) =>
      job.steps.filter((step) => alwaysRuns(step.condition)).some((step) =>
        (step.run !== undefined && executesRunScript(step.shell) && runsCommand(step.run, gate.command)) ||
        (step.uses !== undefined && usesAction(step.uses, gate.command))
      )
    )
  })

/**
 * One supported lockfile install, with the only flags it may carry.
 *
 * @category models
 * @since 0.1.0
 */
export interface SupportedInstall {
  /** The exact install command. */
  readonly command: string
  /** The workspace-binary runner that install pins. */
  readonly exec: string
  /** Valueless flags that cannot omit a dependency the lockfile pins. */
  readonly flags: ReadonlyArray<string>
  /** `--flag=value` flags that cannot omit a dependency the lockfile pins. */
  readonly valueFlags: ReadonlyArray<string>
}

/**
 * The lockfile installs a generated pipeline may run, and the flags each one
 * may carry.
 *
 * A generated pipeline that installs with anything else — `pnpm dlx`, a bare
 * `npm install`, a fetch-from-the-network one-liner — is not reproducible and
 * is not a supported way to set a workspace up, so the renderer refuses it.
 *
 * The flag lists are ALLOWLISTS, and they are the second half of the same
 * guarantee. `pnpm install --frozen-lockfile --lockfile-only` writes a lockfile
 * and installs nothing; `--prod`, `--production`, and `--omit=dev` drop the dev
 * dependencies the workspace CLI lives in; `--filter=…` installs a slice of the
 * workspace. Each one leaves the install gate satisfied and the pinned binary
 * missing, which is a guaranteed-red or silently incomplete pipeline. Only
 * flags that cannot omit a pinned dependency are listed, and an unrecognized
 * flag is refused rather than guessed at.
 *
 * @category constants
 * @since 0.1.0
 */
export const supportedInstalls: ReadonlyArray<SupportedInstall> = [
  {
    command: "pnpm install --frozen-lockfile",
    exec: "pnpm exec",
    flags: [
      "--ignore-scripts",
      "--prefer-offline",
      "--prefer-frozen-lockfile",
      "--strict-peer-dependencies",
      "--no-strict-peer-dependencies",
      "--no-color",
      "--silent"
    ],
    valueFlags: ["--reporter", "--loglevel", "--child-concurrency", "--network-concurrency"]
  },
  {
    command: "npm ci",
    exec: "npm exec --no-install --",
    flags: [
      "--ignore-scripts",
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
      "--no-color",
      "--foreground-scripts",
      "--silent"
    ],
    valueFlags: ["--loglevel"]
  },
  {
    command: "yarn install --immutable",
    exec: "yarn run",
    flags: ["--immutable-cache", "--check-cache", "--inline-builds", "--no-immutable-cache"],
    valueFlags: []
  },
  {
    command: "bun install --frozen-lockfile",
    exec: "bun run",
    flags: ["--ignore-scripts", "--no-progress", "--no-summary", "--no-verify", "--silent"],
    valueFlags: ["--concurrent-scripts"]
  }
]

/**
 * Install commands that respect a lockfile.
 *
 * @category constants
 * @since 0.1.0
 */
export const supportedInstallCommands: ReadonlyArray<string> = supportedInstalls.map((install) => install.command)

/** The value half of a `--flag=value` an install may carry. */
const flagValue = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The supported install a command line is, or `undefined` when it is none of
 * them.
 *
 * Extra flags are allowed only when {@link supportedInstalls} lists them for
 * that package manager. An unknown flag, a flag that can omit a pinned
 * dependency, and anything that could reach the shell or the network are all
 * refused, because each of them satisfies an install gate while leaving the
 * workspace incomplete.
 *
 * @category verification
 * @since 0.1.0
 */
export const supportedInstallOf = (command: string): string | undefined => {
  // A backslash-newline is a line continuation the shell removes before it
  // reads the words, so `pnpm install --frozen-lockfile \` + `--ignore-scripts`
  // is the one command it spells. `commandSpans` follows the continuation, and
  // the flag policy has to read the same words it does.
  const normalized = command.replace(/\\\n[ \t]*/g, " ").trim()
  for (const install of supportedInstalls) {
    if (normalized === install.command) return install.command
    if (!normalized.startsWith(`${install.command} `)) continue
    const suffix = normalized.slice(install.command.length).trim()
    const allowed = suffix.split(/\s+/).every((flag) => {
      const separator = flag.indexOf("=")
      if (separator === -1) return install.flags.includes(flag)
      return install.valueFlags.includes(flag.slice(0, separator)) && flagValue.test(flag.slice(separator + 1))
    })
    if (allowed) return install.command
  }
  return undefined
}

/**
 * Whether a command line is a supported lockfile install.
 *
 * @category verification
 * @since 0.1.0
 */
export const isSupportedInstall = (command: string): boolean => supportedInstallOf(command) !== undefined

/**
 * The command prefix that runs a workspace binary the matching lockfile
 * install already put in the tree.
 *
 * Each one resolves the binary from `node_modules`, so the version that runs is
 * the version the lockfile pinned. `npm exec --no-install` fails rather than
 * fetching. None of them may reach a registry: a generated pipeline that
 * fetched its own CLI would run a package the lockfile never approved, and the
 * install step would be decorative.
 *
 * @category constants
 * @since 0.1.0
 */
export const workspaceExecCommands: Readonly<Record<string, string>> = Object.fromEntries(
  supportedInstalls.map((install) => [install.command, install.exec])
)

/**
 * The workspace-binary runner for a supported lockfile install, or `undefined`
 * when the install is not supported.
 *
 * @category verification
 * @since 0.1.0
 */
export const workspaceExec = (install: string): string | undefined => {
  const supported = supportedInstallOf(install)
  return supported === undefined ? undefined : workspaceExecCommands[supported]
}

/**
 * Whether a `run` script actually performs the given lockfile install.
 *
 * The install has to be a command the SHELL RUNS, which is the same boundary
 * target a gate uses: it must occupy a whole {@link commandSpans} span, after
 * shell comments come off. A mention inside a comment, an `echo` argument, a
 * quoted string, or a here-document body installs nothing and does not count,
 * even though every one of them is a line of the script that reads like the
 * install.
 *
 * The WHOLE command is held to the same policy as the declared install, not
 * merely its prefix. `pnpm install --frozen-lockfile --prod` starts with the
 * declared base and installs none of the dev dependencies the pinned workspace
 * CLI lives in, so it does not perform the declared install; the allowlisted
 * `pnpm install --frozen-lockfile --ignore-scripts` does.
 *
 * @category verification
 * @since 0.1.0
 */
export const performsInstall = (script: string, install: string): boolean => {
  const declared = supportedInstallOf(install)
  if (declared === undefined) return false
  const text = stripShellComments(script)
  return commandSpans(text).some((span) => supportedInstallOf(text.slice(span.start, span.end)) === declared)
}
