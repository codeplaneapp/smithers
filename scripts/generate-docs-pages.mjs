#!/usr/bin/env node
/**
 * Generates the reference pages that must never be hand-written.
 *
 *   docs/pages/cli/**        one page per command the `smithers` binary offers
 *   docs/pages/control/**    one page per control RPC, from `ControlRpcs`
 *   docs/pages/migration/1.0 the removed-command block, from contract 4.2
 *
 * Three sources, no fourth copy: the binary's own `--help`, the Effect Schema
 * definitions in `@smthrs/control` and `@smthrs/gateway`, and the frozen
 * release contract. A verb that changes in any of them changes here, and
 * `--check` fails the build when the committed pages disagree.
 *
 * Run: node scripts/generate-docs-pages.mjs [--check]
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import {
  availableCommands,
  contractPath,
  removedCommands,
  removedFlags,
  removedRpcs,
  removedForms,
  exclusions,
  publishedPackages,
  releaseNotes,
  runtimes,
  supportedRunControl,
  unsupportedFeatures,
  repoRoot,
  shippedCommands,
  survivingAliases
} from "./docs-contract.mjs"
import { cliCatalog } from "./docs-help.mjs"
import {
  cell,
  contractProse,
  errorTags,
  exitCodes,
  frontmatter,
  isOptional,
  mdxText,
  renderAst,
  replaceRegion,
  variantRows,
  variantTag
} from "./docs-render.mjs"
import { routePlan } from "./docs-routes.mjs"
import { rewrite as normalizeInvocations } from "./normalize-bunx.ts"
import { rewrite as normalizePlaceholders } from "./normalize-placeholders.ts"

const CHECK = process.argv.includes("--check")

const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()

const contractSource = readFileSync(contractPath, "utf8")
const shipped = shippedCommands(contractSource)
const removed = removedCommands(contractSource)
const forms = removedForms(contractSource)
const flags = removedFlags(contractSource)
const aliases = survivingAliases(contractSource)
const available = availableCommands(contractSource)
const retiredRpcs = removedRpcs(contractSource)

const pages = new Map()

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const catalog = cliCatalog()

const documentedCommands = [...catalog.commands.values()]
  .filter((command) => shipped.has(command.name))
  .sort((left, right) => left.name.localeCompare(right.name))

for (const command of documentedCommands) {
  const contract = shipped.get(command.name)
  const body = [
    frontmatter(command.description),
    "",
    `# smithers ${command.name}`,
    "",
    `${mdxText(command.description)}.`,
    "",
    "## Usage",
    "",
    "```sh",
    ...command.help.usage,
    "```",
    ""
  ]
  if (contract.forms.length > 1) {
    body.push("## Forms", "")
    for (const form of contract.forms) body.push(`- \`smithers ${form}\``)
    body.push("")
  }
  body.push("## Behavior", "", contractProse(contract.behavior), "")
  const commandFlags = command.help.flags.filter((flag) => !catalog.root.flags.some((shared) => shared.name === flag.name))
  if (commandFlags.length > 0) {
    body.push("## Flags", "", "| Flag | Meaning |", "| --- | --- |")
    for (const flag of commandFlags) {
      body.push(`| \`${cell(flag.signature)}\` | ${cell(flag.description) || "See the behavior above."} |`)
    }
    body.push("")
  }
  const parentFlags = flags.filter((flag) => flag.parent === command.name)
  if (parentFlags.length > 0) {
    body.push(
      "## Removed flags",
      "",
      `These flags existed in Smithers 0.x. \`smithers ${command.name}\` declares each one so it fails with a migration message instead of a usage error, and exits 1.`,
      "",
      "| Flag | Reason |",
      "| --- | --- |"
    )
    for (const flag of parentFlags) body.push(`| \`${cell(flag.flag)}\` | ${cell(contractProse(flag.reason))} |`)
    body.push("")
  }
  body.push(
    "## Source",
    "",
    "This page is generated from the binary's `--help` output and section 4.1 of the",
    "[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).",
    "Run `pnpm docs:pages` after changing either.",
    ""
  )
  pages.set(`docs/pages/cli/${command.name}.md`, `${body.join("\n").replace(/\n{3,}/g, "\n\n")}`)
}

{
  const undocumented = [...catalog.commands.values()].filter((command) => !shipped.has(command.name))
  const body = [
    frontmatter("Every command the smithers binary offers in 1.0.0-rc.0, with its flags, aliases, and exit codes."),
    "",
    "# CLI",
    "",
    "`smithers` is the command line for the control plane. It plans a flow, takes the",
    "approval decision, runs the plan, and reads back what the run recorded. Every",
    "command talks to the control services in `@smthrs/control`; none of them reads a",
    "database table directly, so the same command works against a local project and",
    "against a remote `smithers serve` with `--remote`.",
    "",
    "## Commands",
    "",
    "| Command | Summary |",
    "| --- | --- |"
  ]
  for (const command of documentedCommands) {
    body.push(`| [\`smithers ${command.name}\`](/cli/${command.name}) | ${cell(command.description)} |`)
  }
  body.push("")
  if (undocumented.length > 0) {
    body.push(
      "The binary also registers the reserved system verbs " +
        undocumented.map((command) => `\`${command.name}\``).join(", ") +
        ". Section 4.2 of the release contract removes them; see the",
      "[migration guide](/migration/1.0#removed-commands).",
      ""
    )
  }
  body.push("## Aliases", "", "| Alias | Command |", "| --- | --- |")
  const aliasTargets = new Map([
    ["inspect", "status"],
    ["why", "status"],
    ["events", "logs"],
    ["resume", "run"],
    ["gateway", "serve"],
    ["workflow list", "ls"]
  ])
  for (const alias of [...aliases].sort()) {
    const target = aliasTargets.get(alias)
    if (target === undefined) throw new Error(`generate-docs-pages: no command for alias ${alias}`)
    body.push(`| \`smithers ${alias}\` | [\`smithers ${target}\`](/cli/${target}) |`)
  }
  body.push("", "## Global flags", "", "| Flag | Meaning |", "| --- | --- |")
  for (const flag of [...catalog.root.flags, ...catalog.root.globalFlags]) {
    body.push(`| \`${cell(flag.signature)}\` | ${cell(flag.description) || "See the command pages."} |`)
  }
  body.push("", "## Exit codes", "", "| Code | Meaning |", "| --- | --- |")
  for (const row of exitCodes()) body.push(`| ${row.code} | ${cell(contractProse(row.meaning))} |`)
  body.push(
    "",
    "## Removed commands",
    "",
    "Smithers 1.0.0-rc.0 removed the 0.x verbs that depended on the JSX runtime, the",
    "old gateway, or a deferred feature. Each one exits 1 with a message naming what",
    "to use instead; the [migration guide](/migration/1.0#removed-commands) lists every",
    "verb and its replacement.",
    "",
    "## Source",
    "",
    "This page is generated from the binary's `--help` output and section 4 of the",
    "[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).",
    "Run `pnpm docs:pages` after changing either.",
    ""
  )
  pages.set("docs/pages/cli/index.md", body.join("\n").replace(/\n{3,}/g, "\n\n"))
}

// -----------------------------------------------------------------------------
// Control plane
// -----------------------------------------------------------------------------

const importSource = async (path) => import(pathToFileURL(join(repoRoot, path)).href)

const Unsupported = await importSource("packages/cli/src/Unsupported.ts")

/**
 * The exact refusal each removed verb prints, keyed by verb.
 *
 * `verbError` anchors on the verb's own name, so the link a reader follows from
 * their terminal is the heading this file writes.
 */
const refusals = new Map(
  Unsupported.removedVerbs.map((verb) => [verb.name, Unsupported.message(verb.name, verb.reason, verb.name)])
)

const { ControlRpcs } = await importSource("packages/control/src/ControlRpcs.ts")
const GatewaySchema = await importSource("packages/gateway/src/GatewaySchema.ts")

const fieldRows = (schema) => {
  const fields = schema?.fields
  if (fields === undefined) return undefined
  return Object.entries(fields).map(([name, field]) => ({
    name,
    type: renderAst(field.ast, 1),
    optional: isOptional(field.ast)
  }))
}

const rpcEntries = [...ControlRpcs.requests.entries()]
  .filter(([name]) => !retiredRpcs.has(name))
  .sort(([left], [right]) => left.localeCompare(right))

for (const [name, rpc] of rpcEntries) {
  const payload = fieldRows(rpc.payloadSchema)
  const success = fieldRows(rpc.successSchema)
  const errors = errorTags(rpc.errorSchema?.ast)
  const body = [
    frontmatter(`The ${name} control RPC: its payload, its receipt, and the errors it can answer with.`),
    "",
    `# Control.${name}`,
    "",
    `\`${name}\` is one of the ${rpcEntries.length} requests in the \`ControlRpcs\` group. A client reaches it`,
    "through `ControlClient` over `/rpc` and `/rpc/ws`, and `smithers serve` hosts it.",
    "",
    "## Payload",
    ""
  ]
  const payloadVariants = payload === undefined ? variantRows(rpc.payloadSchema?.ast) : undefined
  const successVariants = success === undefined ? variantRows(rpc.successSchema?.ast) : undefined
  if (payloadVariants !== undefined) {
    body.push("| Form | Fields |", "| --- | --- |")
    for (const row of payloadVariants) {
      body.push(`| \`${cell(row.tag)}\` | ${row.fields.map((field) => `\`${field}\``).join(", ") || "none"} |`)
    }
    body.push("")
  } else if (payload === undefined) {
    body.push(`\`${renderAst(rpc.payloadSchema?.ast)}\``, "")
  } else {
    body.push("| Field | Type | Required |", "| --- | --- | --- |")
    for (const row of payload) {
      body.push(`| \`${row.name}\` | \`${cell(row.type)}\` | ${row.optional ? "no" : "yes"} |`)
    }
    body.push("")
  }
  body.push("## Success", "")
  if (successVariants !== undefined) {
    body.push("| Receipt | Fields |", "| --- | --- |")
    for (const row of successVariants) {
      body.push(`| \`${cell(row.tag)}\` | ${row.fields.map((field) => `\`${field}\``).join(", ") || "none"} |`)
    }
    body.push("")
  } else if (success === undefined) {
    body.push(`\`${renderAst(rpc.successSchema?.ast)}\``, "")
  } else {
    body.push("| Field | Type | Required |", "| --- | --- | --- |")
    for (const row of success) {
      body.push(`| \`${row.name}\` | \`${cell(row.type)}\` | ${row.optional ? "no" : "yes"} |`)
    }
    body.push("")
  }
  body.push("## Errors", "")
  if (errors.length === 0) {
    body.push("This request has no failure channel.", "")
  } else {
    body.push("| Error | Code |", "| --- | --- |")
    for (const error of errors) body.push(`| \`${cell(error.tag)}\` | ${error.code === "" ? "" : `\`${error.code}\``} |`)
    body.push("")
  }
  body.push(
    "## Source",
    "",
    "Generated from `packages/control/src/ControlRpcs.ts`. Run `pnpm docs:pages` after",
    "changing the schema.",
    ""
  )
  pages.set(`docs/pages/control/${kebab(name)}.md`, body.join("\n").replace(/\n{3,}/g, "\n\n"))
}

{
  const projections = GatewaySchema.ProjectionName.literals ?? GatewaySchema.ProjectionName.ast?.literals ?? []
  const body = [
    frontmatter("The control RPCs smithers serve hosts, and the gateway projections a UI subscribes to."),
    "",
    "# Control plane",
    "",
    "The control plane is the boundary between a caller and a run. `@smthrs/control`",
    "declares the requests, `ControlServer` hosts them, `ControlClient` calls them, and",
    "[`smithers serve`](/cli/serve) mounts both over HTTP and WebSocket. Every CLI",
    "command and every UI reaches a run through this surface, never through the run",
    "store or the journal tables.",
    "",
    "## Requests",
    "",
    "| Request | Payload | Answer |",
    "| --- | --- | --- |"
  ]
  for (const [name, rpc] of rpcEntries) {
    const payload = fieldRows(rpc.payloadSchema)
    body.push(
      `| [\`${name}\`](/control/${kebab(name)}) | ${
        payload === undefined
          ? `\`${cell(renderAst(rpc.payloadSchema?.ast))}\``
          : payload.map((row) => `\`${row.name}\``).join(", ")
      } | \`${cell(renderAst(rpc.successSchema?.ast))}\` |`
    )
  }
  body.push(
    "",
    "## Projections",
    "",
    "`smithers serve` streams these read models over `/projections/ws`. A projection is",
    "a derived view of the journal: subscribing to one never claims a run and never",
    "writes.",
    "",
    "| Projection | Subscribed over |",
    "| --- | --- |"
  )
  for (const projection of projections) body.push(`| \`${projection}\` | \`/projections/ws\` |`)
  body.push(
    "",
    "## Transports",
    "",
    "| Path | Carries |",
    "| --- | --- |",
    "| `/rpc` | one control request per HTTP call |",
    "| `/rpc/ws` | the same requests plus `Watch`, which streams |",
    "| `/sync` and `/sync/ws` | read-only journal replication for followers |",
    "| `/projections/ws` | the projections above |",
    "| `/health` | `GatewayHealth`: workspace hash, gateway id, protocol version |",
    "",
    "## Source",
    "",
    "Generated from `packages/control/src/ControlRpcs.ts` and",
    "`packages/gateway/src/GatewaySchema.ts`. Run `pnpm docs:pages` after changing",
    "either.",
    ""
  )
  pages.set("docs/pages/control/index.md", body.join("\n").replace(/\n{3,}/g, "\n\n"))
}

// -----------------------------------------------------------------------------
// Removed commands, inside the migration guide
// -----------------------------------------------------------------------------

{
  const guide = join(repoRoot, "docs/pages/migration/1.0.md")
  const source = readFileSync(guide, "utf8")
  const names = [...removed.keys()].sort()
  const lines = [
    "| Verb | Use instead |",
    "| --- | --- |"
  ]
  for (const name of names) {
    lines.push(`| [\`smithers ${name}\`](#${name}) | ${cell(contractProse(removed.get(name).reason))} |`)
  }
  lines.push("")
  for (const form of forms) {
    lines.push(`\`smithers ${form.form}\` is removed; \`smithers ${form.parent}\` keeps its other form.`, "")
  }
  lines.push("### Removed flags", "", "| Command | Flag | Reason |", "| --- | --- | --- |")
  for (const flag of flags) {
    lines.push(`| \`${cell(flag.parent)}\` | \`${cell(flag.flag)}\` | ${cell(contractProse(flag.reason))} |`)
  }
  lines.push("")
  for (const name of names) {
    const entry = removed.get(name)
    // Byte for byte what the binary prints. The contract decides which verbs are
    // removed; the binary owns the sentence it puts on a terminal, and the two
    // spell the same reasons with different code marks. An operator pastes this
    // line from their shell, so a block that quietly differs is not a quotation.
    const refusal = refusals.get(name)
    if (refusal === undefined) throw new Error(`generate-docs-pages: the binary does not refuse ${name}`)
    lines.push(`### ${name}`, "", "```", refusal, "```", "")
    if (entry.spellings.some((spelling) => spelling !== name)) {
      lines.push(`Removed forms: ${entry.spellings.map((spelling) => `\`${spelling}\``).join(", ")}.`, "")
    }
  }
  pages.set("docs/pages/migration/1.0.md", replaceRegion(source, "removed-commands", lines.join("\n")))
}

// -----------------------------------------------------------------------------
// Release pages
// -----------------------------------------------------------------------------

{
  const page = join(repoRoot, "docs/pages/release/support-matrix.md")
  const lines = ["## Runtimes", "", "| Runtime | Status | Minimum |", "| --- | --- | --- |"]
  for (const row of runtimes()) {
    lines.push(`| ${cell(row.runtime)} | ${cell(contractProse(row.status))} | ${cell(contractProse(row.minimum))} |`)
  }
  lines.push(
    "",
    "## Databases",
    "",
    "SQLite only. PostgreSQL and PGlite exit with `unsupported_database`; see",
    "[databases](/databases) for the files, the ladder, and the operating limits.",
    "",
    "## Commands",
    "",
    "| Command | Behavior |",
    "| --- | --- |"
  )
  for (const [name, command] of [...shipped].sort(([left], [right]) => left.localeCompare(right))) {
    const link = pages.has(`docs/pages/cli/${name}.md`) ? `[\`smithers ${name}\`](/cli/${name})` : `\`smithers ${name}\``
    lines.push(`| ${link} | ${cell(contractProse(command.behavior))} |`)
  }
  lines.push("", "## Run control", "", "| Feature | Contract |", "| --- | --- |")
  for (const row of supportedRunControl()) {
    lines.push(`| ${cell(row.feature)} | ${cell(contractProse(row.contract))} |`)
  }
  lines.push(
    "",
    "## Published packages",
    "",
    "All of them carry version `1.0.0-rc.0`. The browser column is the bundling",
    "claim [browser support](/architecture/browser-support) executes, not a durable",
    "execution claim.",
    "",
    "| Package | Purpose | Browser |",
    "| --- | --- | --- |"
  )
  for (const row of publishedPackages()) {
    const link = pages.has(`docs/pages/api/${row.name.replace("@smthrs/", "")}.md`)
      ? `[\`${row.name}\`](/api/${row.name.replace("@smthrs/", "")})`
      : `\`${row.name}\``
    lines.push(`| ${link} | ${cell(contractProse(row.purpose))} | ${cell(row.browser)} |`)
  }
  pages.set("docs/pages/release/support-matrix.md", replaceRegion(readFileSync(page, "utf8"), "support-matrix", lines.join("\n")))
}

{
  const page = join(repoRoot, "docs/pages/release/known-limitations.md")
  const notes = releaseNotes()
  const excluded = exclusions()
  const lines = ["## Release notes", ""]
  for (const note of notes) {
    const ids = excluded.filter((exclusion) => exclusion.titles.includes(note.title))
    lines.push(`### ${note.title}`, "", note.line, "")
    if (ids.length > 0) {
      lines.push(
        `Exclusions: ${ids.map((exclusion) => `${exclusion.id} (${exclusion.disposition})`).join(", ")}.`,
        ""
      )
    }
  }
  lines.push(
    "## How each exclusion is enforced",
    "",
    "A dropped feature is removed, and a deferred one fails with a typed error. The",
    "state column is what the release does today.",
    "",
    "| Feature | State in 1.0.0-rc.0 |",
    "| --- | --- |"
  )
  for (const row of unsupportedFeatures()) {
    lines.push(`| ${cell(row.feature)} | ${cell(contractProse(row.state))} |`)
  }
  pages.set("docs/pages/release/known-limitations.md", replaceRegion(readFileSync(page, "utf8"), "release-notes", lines.join("\n")))
}

// -----------------------------------------------------------------------------
// Changelog index and the route plan
// -----------------------------------------------------------------------------

{
  const versions = readdirSync(join(repoRoot, "docs/pages/changelogs"))
    .filter((name) => /^0\.\d+\.\d+\.mdx?$/.test(name))
    .map((name) => name.replace(/\.mdx?$/, ""))
    .sort((left, right) => {
      const parse = (value) => value.split(".").map(Number)
      const [leftMajor, leftMinor, leftPatch] = parse(left)
      const [rightMajor, rightMinor, rightPatch] = parse(right)
      return rightMajor - leftMajor || rightMinor - leftMinor || rightPatch - leftPatch
    })
  const body = [
    frontmatter("The Smithers 0.x release notes, kept as history, and the policy that governs what a release reports."),
    "",
    "# Changelogs",
    "",
    "The notes below are the Smithers 0.x release history. They describe the JSX",
    "workflow runtime, its CLI, and its gateway, none of which exist in 1.0.0-rc.0.",
    "They are kept because a 0.x project still reads them while it migrates; read",
    "[migrating from 0.x](/migration/1.0) for what replaced each of those surfaces.",
    "",
    "The 1.0.0-rc.0 notes are the release-note paragraphs in",
    "[known limitations](/release/known-limitations), and",
    "[the compatibility policy](/changelogs/compatibility-policy) states what every",
    "release has to report.",
    "",
    "## Smithers 0.x",
    ""
  ]
  for (const version of versions) body.push(`- [${version}](/changelogs/${version})`)
  body.push("")
  pages.set("docs/pages/changelogs/index.md", body.join("\n").replace(/\n{3,}/g, "\n\n"))
}

{
  const plan = routePlan()
  if (plan.problems.length > 0) {
    for (const problem of plan.problems) console.error(`  route plan: ${problem}`)
    throw new Error(`generate-docs-pages: ${plan.problems.length} route-plan problem(s)`)
  }
  const families = [
    { title: "Release images", prefix: "docs/public/images/" },
    { title: "Changelogs", prefix: "docs/pages/changelogs/" },
    { title: "Model registry", prefix: "docs/data/" }
  ]
  const body = [
    frontmatter("Where every asset the Mintlify-era documentation left behind lives now, and how a reader reaches it."),
    "",
    "# Route plan",
    "",
    "The documentation moved from Mintlify to vocs in Smithers 1.0. Pages were",
    "rewritten, but three families of asset were kept rather than replaced: the",
    "release image trees, the Smithers 0.x changelogs, and the SOTA model registry.",
    "This page says where each one is now.",
    "",
    `It covers ${plan.entries.length} kept assets and ${plan.deletions.length} deletion rules. The table is generated from`,
    "`docs/migration/disposition-ledger.json` and the tree itself, and `check-docs`",
    "fails when an asset the ledger keeps has no place here or a file the ledger",
    "deletes is still present.",
    ""
  ]
  for (const family of families) {
    const rows = plan.entries.filter((entry) => entry.path.startsWith(family.prefix))
    if (rows.length === 0) continue
    body.push(`## ${family.title}`, "", `${rows.length} files. ${rows[0].note}.`, "", "| Was | Is | Route |", "| --- | --- | --- |")
    for (const row of rows) {
      // The route is printed rather than linked: a Markdown link to a static
      // asset is a dead link to vocs's checker, which only resolves pages.
      body.push(`| \`${row.before}\` | \`${row.path}\` | ${row.route === undefined ? "not routed" : `\`${row.route}\``} |`)
    }
    body.push("")
  }
  body.push(
    "## Deleted, with the reason",
    "",
    "Each rule below names assets the ledger deletes. Nothing in the tree matches",
    "them; the rule stays here so a file that comes back is caught.",
    "",
    "| Rule | Reason |",
    "| --- | --- |"
  )
  const seen = new Set()
  for (const deletion of plan.deletions) {
    if (seen.has(deletion.label)) continue
    seen.add(deletion.label)
    body.push(`| \`${cell(deletion.glob)}\` | ${cell(deletion.label)} |`)
  }
  body.push("")
  pages.set("docs/pages/routes.md", body.join("\n").replace(/\n{3,}/g, "\n\n"))
}

// -----------------------------------------------------------------------------
// Write or check
// -----------------------------------------------------------------------------

// The generated pages answer to the same prose gates as the hand-written ones,
// so they are normalized here rather than fixed afterwards, which would leave
// `--check` reporting drift against its own output.
for (const [path, content] of [...pages]) {
  pages.set(path, normalizePlaceholders(normalizeInvocations(content)))
}

let drifted = 0
for (const [path, content] of [...pages].sort(([left], [right]) => left.localeCompare(right))) {
  const absolute = join(repoRoot, path)
  const current = (() => {
    try {
      return readFileSync(absolute, "utf8")
    } catch {
      return undefined
    }
  })()
  if (current === content) continue
  drifted += 1
  if (CHECK) {
    console.error(`  ${current === undefined ? "missing" : "stale"}: ${path}`)
    continue
  }
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
  console.log(`  ${current === undefined ? "created" : "updated"} ${relative(repoRoot, absolute)}`)
}

if (CHECK) {
  if (drifted > 0) {
    console.error(`\n✗ ${drifted} generated docs page(s) are out of date. Run \`pnpm docs:pages\`.`)
    process.exit(1)
  }
  console.log(`✓ ${pages.size} generated docs pages are current`)
} else {
  console.log(`\n${pages.size} generated page(s), ${drifted} written.`)
}
