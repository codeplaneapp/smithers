#!/usr/bin/env node
/**
 * Validates an externally sourced SWE-bench instance identifier before it is
 * used in a path, container name, or image name.
 */
import { readFileSync } from "node:fs"

const [datasetPath, instanceId] = process.argv.slice(2)
const grammar = /^[A-Za-z0-9][A-Za-z0-9._-]*__[A-Za-z0-9][A-Za-z0-9._-]*$/u

if (datasetPath === undefined || instanceId === undefined || !grammar.test(instanceId)) {
  console.error("instance id must match <repo>__<issue> using only ASCII letters, digits, '.', '_' and '-'")
  process.exit(2)
}

let rows
try {
  rows = JSON.parse(readFileSync(datasetPath, "utf8"))
} catch (error) {
  console.error(`could not read SWE-bench dataset: ${String(error)}`)
  process.exit(2)
}

if (!Array.isArray(rows)) {
  console.error("SWE-bench dataset must be an array")
  process.exit(2)
}

const matches = rows.filter((row) => row?.instance_id === instanceId)
if (matches.length !== 1 || typeof matches[0]?.base_commit !== "string" || matches[0].base_commit.length === 0) {
  console.error(`instance id ${instanceId} is not a unique dataset member with a base commit`)
  process.exit(2)
}

process.stdout.write(matches[0].base_commit)
