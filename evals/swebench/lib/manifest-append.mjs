/**
 * Appends one row to a JSONL ledger and flushes it to the platter.
 *
 *   node lib/manifest-append.mjs <file.jsonl> '<json object>'
 *
 * The full-benchmark driver's manifest is the only thing that survives a crash,
 * so a row that is in the page cache and not on disk is a row that does not
 * exist. Every append opens the file `a+`, writes the line, `fsync`s the
 * descriptor, and closes it: a single `write(2)` to an `O_APPEND` descriptor is
 * atomic against the other worker's writes, and the `fsync` is what makes the
 * row survive the kill the resume test performs.
 *
 * A kill can also land in the middle of a `write(2)` and leave the last record
 * half-written and unterminated, which the reader tolerates as a torn tail.
 * Writing this row straight after those bytes would fuse the fragment and the
 * row into one line that parses as neither, and the reader would then drop the
 * row that was just `fsync`ed rather than the fragment — a graded instance or a
 * paid attempt silently absent from the ledger after a resume. So the append
 * closes an unterminated fragment with one leading newline first: the fragment
 * keeps its own line, where `lib/fullbench-manifest.mjs` reports it as a
 * malformed row, and this row keeps its own line, where it is read.
 *
 * The argument is parsed before it is written, so a malformed row is refused
 * rather than appended and discovered by the next reader.
 */
import { closeSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from "node:fs"

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

const NEWLINE = 0x0a

/**
 * The newline that closes a torn record, or "" when the file already ends in one.
 *
 * Two workers racing here both read the same missing newline and both write
 * one, which leaves an empty line between the fragment and the two rows; the
 * reader skips empty lines. A complete append always ends in a newline, so an
 * unterminated tail is only ever left by a process that is already dead.
 */
const delimiter = (descriptor) => {
  const size = fstatSync(descriptor).size
  if (size === 0) return ""
  const last = Buffer.alloc(1)
  readSync(descriptor, last, 0, 1, size - 1)
  return last[0] === NEWLINE ? "" : "\n"
}

/** `write(2)` is allowed to be short, and a half-written row is the defect this file exists to avoid. */
const writeAll = (descriptor, buffer) => {
  let written = 0
  while (written < buffer.length) {
    written += writeSync(descriptor, buffer, written, buffer.length - written)
  }
}

// `a+` rather than `a` so the tail can be read; every write still goes to the end.
const descriptor = openSync(file, "a+")
try {
  writeAll(descriptor, Buffer.from(`${delimiter(descriptor)}${JSON.stringify(row)}\n`))
  fsyncSync(descriptor)
} finally {
  closeSync(descriptor)
}
