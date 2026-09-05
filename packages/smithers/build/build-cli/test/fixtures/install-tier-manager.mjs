#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("11.21.0\n")
} else if (
  ["fetch", "install"].includes(args[0]) &&
  args.includes("--frozen-lockfile") && args.includes("--ignore-scripts") &&
  (args[0] !== "install" || args.includes("--offline"))
) {
  appendFileSync("manager-calls.txt", `${args[0]}\n`)
  if (args[0] === "install") {
    mkdirSync("node_modules", { recursive: true })
    writeFileSync("node_modules/.modules.yaml", "layoutVersion: 5\n")
    writeFileSync("node_modules/fixture.txt", "installed\n")
  }
} else {
  process.exitCode = 40
}
