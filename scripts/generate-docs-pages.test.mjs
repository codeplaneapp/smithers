import assert from "node:assert/strict"
import test from "node:test"
import { helpBlock, helpEntry, parseHelp } from "./docs-help.mjs"

const help = [
  "DESCRIPTION",
  "  List durable runs",
  "",
  "USAGE",
  "  smithers ps [flags]",
  "",
  "FLAGS",
  "  --json                 ",
  "  --status string        ",
  "",
  "GLOBAL FLAGS",
  "  --help, -h                    Show help information",
  "",
  "SUBCOMMANDS",
  "  plan       Render a flow plan",
  "  run        Run an approved plan payload",
  ""
].join("\n")

test("reads one indented block and stops at the next heading", () => {
  assert.deepEqual(helpBlock(help, "USAGE"), ["smithers ps [flags]"])
  assert.deepEqual(helpBlock(help, "NOTHING"), [])
})

test("splits an entry on the column gap, keeping the type in the signature", () => {
  assert.deepEqual(helpEntry("--status string        "), {
    signature: "--status string",
    name: "--status",
    description: ""
  })
  assert.deepEqual(helpEntry("--help, -h                    Show help information"), {
    signature: "--help, -h",
    name: "--help",
    description: "Show help information"
  })
})

test("parses a help page into its blocks", () => {
  const parsed = parseHelp(help)
  assert.equal(parsed.description, "List durable runs")
  assert.deepEqual(parsed.flags.map((flag) => flag.name), ["--json", "--status"])
  assert.deepEqual(parsed.globalFlags.map((flag) => flag.name), ["--help"])
  assert.deepEqual(parsed.subcommands.map((command) => command.name), ["plan", "run"])
  assert.equal(parsed.subcommands[0].description, "Render a flow plan")
})

test("a help page with no subcommands reports none", () => {
  assert.deepEqual(parseHelp("DESCRIPTION\n  Something\n").subcommands, [])
})
