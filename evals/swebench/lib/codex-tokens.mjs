/**
 * The token count the Codex CLI prints in its footer, if it printed one.
 *
 *   node lib/codex-tokens.mjs <run.log>
 *
 * `codex exec` ends a session with a usage footer. Two spellings have shipped,
 * and both are read here:
 *
 *     tokens used              tokens used: 46,469
 *     46,469
 *
 * It is one number — the CLI publishes no input/cached/output split — so it can
 * be compared against the sum of our own four counters and against nothing else.
 * Anything that prices it would be inventing the split, and the bundle says so
 * rather than printing a dollar figure the footer cannot support.
 *
 * A log with no footer answers `null`: a run killed by its timeout never printed
 * one, and "we do not know" is the honest column for it. The CLI prints the
 * footer to the same stream as the transcript, so a scan starts at the end and
 * takes the last footer — a session that printed one per turn is read at its
 * total rather than at its first turn.
 *
 * Spends nothing, needs no docker, needs no dataset.
 *
 * @since 0.1.0
 */
import { readFileSync } from "node:fs"

const count = (text) => {
  const digits = text.trim().replace(/,/gu, "")
  return /^\d+$/u.test(digits) ? Number(digits) : undefined
}

/**
 * Reads the footer's token total out of a codex transcript.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readTokens = (text) => {
  const lines = text.split("\n")
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim()
    // The one-line spelling: `tokens used: 46,469`.
    const inline = /^tokens used:\s*(.+)$/u.exec(line)
    if (inline !== null) {
      const total = count(inline[1])
      if (total !== undefined) return total
      continue
    }
    // The two-line spelling: a bare `tokens used`, then the number.
    if (line !== "tokens used") continue
    const total = count(lines[index + 1] ?? "")
    if (total !== undefined) return total
  }
  return null
}

/**
 * Reads the footer out of a transcript file, tolerating a file that is not there.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readTokensFile = (path) => {
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
  return readTokens(text)
}

const main = () => {
  const [, , path] = process.argv
  if (path === undefined) {
    console.error("usage: node lib/codex-tokens.mjs <run.log>")
    process.exit(2)
  }
  const total = readTokensFile(path)
  if (total !== null) process.stdout.write(`${total}\n`)
}

if (import.meta.filename === process.argv[1]) main()
