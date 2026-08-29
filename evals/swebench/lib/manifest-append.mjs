/**
 * Appends one row to a JSONL ledger and flushes it to the platter.
 *
 *   node lib/manifest-append.mjs <file.jsonl> '<json object>'
 *
 * The full-benchmark driver's manifest is the only thing that survives a crash,
 * so a row that is in the page cache and not on disk is a row that does not
 * exist. Every append opens the file `a`, writes the line, `fsync`s the
 * descriptor, and closes it: a single `write(2)` to an `O_APPEND` descriptor is
 * atomic against the other worker's writes, and the `fsync` is what makes the
 * row survive the kill the resume test performs.
 *
 * The argument is parsed before it is written, so a malformed row is refused
 * rather than appended and discovered by the next reader.
 */
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs"

const [, , file, json] = process.argv
if (file === undefined || json === undefined) {
  console.error("usage: node lib/manifest-append.mjs <file.jsonl> '<json object>'")
  process.exit(2)
}

let row
try {
  row = JSON.parse(json)
} catch (error) {
  console.error(`manifest-append.mjs: not a JSON row: ${error.message}`)
  process.exit(2)
}
if (row === null || typeof row !== "object" || Array.isArray(row)) {
  console.error("manifest-append.mjs: a row must be a JSON object")
  process.exit(2)
}

const descriptor = openSync(file, "a")
try {
  writeSync(descriptor, `${JSON.stringify(row)}\n`)
  fsyncSync(descriptor)
} finally {
  closeSync(descriptor)
}
