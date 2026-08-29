import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { repoRoot } from "./docs-contract.mjs"
import { helpBlock, helpEntry, parseHelp } from "./docs-help.mjs"
import { pages } from "./docs-pages.mjs"

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

test("no generated CLI page interpolates help text MDX would read as a tag", () => {
  // `smithers init` describes itself as "Scaffold flows/<name>/flow.mdx". Copied
  // into a page unescaped, that is an unclosed JSX element and `vocs build`
  // dies on it, so the escape belongs in the generator rather than in a
  // hand-edit of one page.
  const offenders = []
  for (const page of pages()) {
    if (!page.route.startsWith("/cli")) continue
    let fenced = false
    for (const line of page.body.split("\n")) {
      if (/^\s*`{3,}/.test(line)) {
        fenced = !fenced
        continue
      }
      if (fenced) continue
      const prose = line.replace(/`[^`]*`/g, "")
      if (/<[A-Za-z/]/.test(prose)) offenders.push(`${page.path}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test("the support matrix links every published package this repository documents", () => {
  const matrix = readFileSync(join(repoRoot, "docs/pages/release/support-matrix.md"), "utf8")
  // The migration tool joined the release as the fortieth name. It has no API
  // page, so an unguarded generator prints it as bare text and a reader has no
  // way to find out what it does.
  assert.match(matrix, /\| \[`@smthrs\/migrate`\]\(\/migration\/migrate-tool\) \|/)
  assert.match(matrix, /\| \[`@smthrs\/cli`\]\(\/cli\) \|/)
  assert.match(matrix, /\| \[`@smthrs\/engine`\]\(\/api\/engine\) \|/)
})

test("the removed-verb table gives the reason the binary gives", () => {
  const guide = readFileSync(join(repoRoot, "docs/pages/migration/1.0.md"), "utf8")
  // The table and the block under it describe the same removal. Rendering the
  // table from the contract instead of the binary put the migration's own
  // record ("follows apps/review's Phase 4 disposition") in front of a reader
  // whose terminal had just said "not an rc.0 verb".
  assert.match(guide, /\| \[`smithers review`\]\(#review\) \| not an rc\.0 verb \|/)
  assert.match(guide, /\| \[`smithers test`\]\(#test\) \| not an rc\.0 verb \|/)
})

test("no removal table cell is blank and none cites a migration phase", () => {
  const guide = readFileSync(join(repoRoot, "docs/pages/migration/1.0.md"), "utf8")
  const rows = guide.split("\n").filter((line) => /^\| (\[`smithers |`)/.test(line))
  assert.ok(rows.length > 60, `expected the removal tables, found ${rows.length} rows`)
  for (const row of rows) {
    const cells = row.split("|").slice(1, -1).map((entry) => entry.trim())
    assert.ok(cells.every((entry) => entry !== ""), `blank cell: ${row}`)
    assert.doesNotMatch(row, /Phase [1-9]|disposition|ledger/, `internal record in a reader's table: ${row}`)
  }
})

test("a removed flag is given the reason the binary prints", () => {
  const guide = readFileSync(join(repoRoot, "docs/pages/migration/1.0.md"), "utf8")
  const page = readFileSync(join(repoRoot, "docs/pages/cli/migrate.md"), "utf8")
  // `--to` and `--backend` both refuse with a database sentence. The contract
  // adds its own section and error-code citation; the terminal does not.
  assert.match(guide, /\| `global` \| `--backend pglite\\\|postgres` \| SQLite only \(`--backend sqlite` is accepted as a no-op\) \|/)
  assert.match(page, /\| `--to &lt;backend&gt;` \| SQLite only; the 0\.x database move is removed \|/)
})
