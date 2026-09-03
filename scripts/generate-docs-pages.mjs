#!/usr/bin/env node
/**
 * Generates the reference pages that must never be hand-written.
 *
 *   docs/pages/cli/**        one page per command the `smithers` binary offers
 *   docs/pages/control/**    one page per control RPC, from `ControlRpcs`
 *   docs/pages/migration/1.0 the removed-command block, from the CLI registry
 *
 * The binary's own `--help`, its removal registry, and the Effect Schema
 * definitions in `@smthrs/control` and `@smthrs/gateway` are the sources.
 * `--check` fails when the committed pages disagree.
 *
 * Run: node scripts/generate-docs-pages.mjs [--check]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { repoRoot } from "./docs-shared.mjs"
import { cliCatalog } from "./docs-help.mjs"
import {
  cell,
  errorTags,
  frontmatter,
  isOptional,
  mdxText,
  renderAst,
  replaceRegion,
  variantRows,
  variantTag
} from "./docs-render.mjs"
import { rewrite as normalizeInvocations } from "./normalize-bunx.ts"
import { rewrite as normalizePlaceholders } from "./normalize-placeholders.ts"

const CHECK = process.argv.includes("--check")

const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()

/** Imports a TypeScript source module of this workspace by repository path. */
const importSource = async (path) => import(pathToFileURL(join(repoRoot, path)).href)

/** The CLI's own removal registry: the refusals and reasons a terminal prints. */
const Unsupported = await importSource("packages/cli/src/Unsupported.ts")

const aliases = new Set(["events", "gateway", "inspect", "resume", "why", "workflow list"])
const parentSurvives = Unsupported.removedVerbs.filter((entry) => entry.name === "gateway" || entry.name === "workflow")
const removed = new Map(
  Unsupported.removedVerbs
    .filter((entry) => !parentSurvives.includes(entry))
    .map((entry) => [entry.name, entry])
)
const forms = parentSurvives.map((entry) => ({
  parent: entry.name,
  form: `${entry.name} ${entry.subcommands.join("|")}`,
  reason: entry.reason
}))
const flags = Unsupported.removedFlags.map((entry) => ({ ...entry, flag: `--${entry.flag}` }))
const retiredRpcs = new Set()

/**
 * The removal rows whose parent command the shipped-command contract keeps, such as the
 * `gateway status|stop` row under the surviving `gateway` alias.
 *
 * They are not removed verbs and get no row in the verb table, but their
 * refusals link to `#<parent>`, so the guide owes each one a heading and the
 * sentences printed under it.
 */
const survivingParents = parentSurvives

const pages = new Map()

/**
 * The reason the binary prints when a removed flag is used.
 *
 * The registry stores a flag name without its leading dashes and files the
 * global `--backend` under an empty parent, so the lookup is by name with the
 * parent as a tiebreak.
 */
const spokenFlagReason = (parent, flag) => {
  const name = flag.replace(/^--/, "").split(/[\s|]/)[0]
  const matches = Unsupported.removedFlags.filter((entry) => entry.flag === name)
  const exact = matches.find((entry) => entry.parent === parent)
  return (exact ?? matches[0])?.reason
}


// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const catalog = cliCatalog()

const sectionBody = (source, heading) => {
  const start = source.indexOf(`\n${heading}\n`)
  if (start < 0) return ""
  const rest = source.slice(start + heading.length + 2)
  return rest.slice(0, /^## /m.exec(rest)?.index ?? rest.length).trim()
}

const commandPage = (name) => join(repoRoot, `docs/pages/cli/${name}.md`)
const commandContract = (command) => {
  const source = readFileSync(commandPage(command.name), "utf8")
  const forms = [...sectionBody(source, "## Forms").matchAll(/^- `smithers ([^`]+)`$/gm)].map((match) => match[1])
  return {
    forms: forms.length === 0 ? [command.name] : forms,
    behavior: sectionBody(source, "## Behavior") || command.description
  }
}

const documentedCommands = [...catalog.commands.values()]
  .filter((command) => existsSync(commandPage(command.name)))
  .sort((left, right) => left.name.localeCompare(right.name))

const shipped = new Map(documentedCommands.map((command) => [command.name, commandContract(command)]))

for (const command of documentedCommands) {
  const commandDocs = shipped.get(command.name)
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
  if (commandDocs.forms.length > 1) {
    body.push("## Forms", "")
    for (const form of commandDocs.forms) body.push(`- \`smithers ${form}\``)
    body.push("")
  }
  body.push("## Behavior", "", commandDocs.behavior, "")
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
    for (const flag of parentFlags) {
      const reason = spokenFlagReason(flag.parent, flag.flag) ?? flag.reason
      body.push(`| \`${cell(flag.flag)}\` | ${cell(reason)} |`)
    }
    body.push("")
  }
  body.push(
    "## Source",
    "",
    "This page is generated from the binary's `--help` output. Run",
    "`pnpm docs:pages` after changing the command.",
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
        ". The upgrade guide documents why they were removed; see the",
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
  for (const row of [
    { code: "0", meaning: "success" },
    { code: "1", meaning: "runtime or command failure" },
    { code: "2", meaning: "usage error" },
    { code: "3", meaning: "migration refused before changing the project" },
    { code: "130", meaning: "interrupted by SIGINT" },
    { code: "143", meaning: "interrupted by SIGTERM" }
  ]) body.push(`| ${row.code} | ${cell(row.meaning)} |`)
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
    "This page is generated from the binary's `--help` output and removal registry.",
    "Run `pnpm docs:pages` after changing either.",
    ""
  )
  pages.set("docs/pages/cli/index.md", body.join("\n").replace(/\n{3,}/g, "\n\n"))
}

// -----------------------------------------------------------------------------
// Control plane
// -----------------------------------------------------------------------------

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
    // The reason a reader is given is the binary's, the same string the block
    // below quotes.
    const reason = Unsupported.removedVerbs.find((verb) => verb.name === name)?.reason
    if (reason === undefined) throw new Error(`generate-docs-pages: the binary does not refuse ${name}`)
    lines.push(`| [\`smithers ${name}\`](#${name}) | ${cell(reason)} |`)
  }
  lines.push("")
  for (const form of forms) {
    lines.push(`\`smithers ${form.form}\` is removed; \`smithers ${form.parent}\` keeps its other form.`, "")
  }
  lines.push("### Removed flags", "", "| Command | Flag | Reason |", "| --- | --- | --- |")
  for (const flag of flags) {
    // Same rule as the verbs: the binary owns the sentence a reader is given.
    const reason = spokenFlagReason(flag.parent, flag.flag) ?? flag.reason
    lines.push(`| \`${cell(flag.parent || "global")}\` | \`${cell(flag.flag)}\` | ${cell(reason)} |`)
  }
  lines.push("")
  // A flag refusal links to an anchor of its own when the flag is not attached
  // to a removed verb, and an anchor with no heading drops the reader at the
  // top of the guide with no sentence to read. Each one gets a section here,
  // and a new anchor with no prose is a generator failure rather than a silent
  // hole in the page.
  const flagAnchorProse = new Map([
    [
      "supervision",
      "`up --force`, `up --steal-ownership`, `up --resume-claim-owner`, `up --resume-claim-heartbeat`, " +
      "`up --resume-restore-owner`, and `up --resume-restore-heartbeat` are removed. Ownership recovery is not " +
      "an operator decision in 1.0.0-rc.0: the run driver's heartbeat sweep reclaims a run whose owner stopped " +
      "renewing its lease, and a second process that tries to drive the same run is refused rather than allowed " +
      "to steal it. Run `smithers up` again and let the sweep do it."
    ],
    [
      "plan-admission",
      "`up --max-concurrency <n>` is removed. Parallelism is declared by the flow, and the plan the control " +
      "plane admits carries the bound. A flow that should run fewer steps at once says so in its own body."
    ],
    [
      "init",
      "`init --global` is removed. 1.0.0-rc.0 has no global pack and reads no `~/.smithers`: state is the " +
      "project's `.flows/` directory and nothing else, and seats resolve from environment keys. Run " +
      "`smithers init` in the project."
    ]
  ])
  const headedElsewhere = new Set([...names, ...survivingParents.map((verb) => verb.name), "databases"])
  for (const anchor of [...new Set(Unsupported.removedFlags.map((flag) => flag.anchor))].sort()) {
    if (headedElsewhere.has(anchor)) continue
    const prose = flagAnchorProse.get(anchor)
    if (prose === undefined) {
      throw new Error(`generate-docs-pages: no migration-guide section for the flag anchor #${anchor}`)
    }
    lines.push(`#### ${anchor}`, "", prose, "")
  }
  for (const name of [...names, ...survivingParents.map((verb) => verb.name)].sort()) {
    const parent = survivingParents.find((verb) => verb.name === name)
    if (parent !== undefined) {
      // The parent command remains available while these subcommands do not.
      // The heading exists because every one of those refusals links to
      // `#<parent>`, and an operator who follows the
      // link from their terminal has to land on the sentence they were shown.
      const kept = [...aliases].filter((alias) => alias.split(/\s+/)[0] === name)
      lines.push(
        `### ${name}`,
        "",
        `${(kept.length > 0 ? kept : [name]).map((form) => `\`smithers ${form}\``).join(" and ")} remains available.` +
          " These forms are removed, and each prints its own sentence:",
        "",
        "```",
        ...parent.subcommands.map((sub) => Unsupported.message(`${name} ${sub}`, parent.reason, name)),
        "```",
        ""
      )
      continue
    }
    const entry = removed.get(name)
    // Byte for byte what the binary prints. An operator pastes this line from
    // their shell, so a block that quietly differs is not a quotation.
    const refusal = refusals.get(name)
    if (refusal === undefined) throw new Error(`generate-docs-pages: the binary does not refuse ${name}`)
    lines.push(`### ${name}`, "", "```", refusal, "```", "")
    if (entry.subcommands !== undefined) {
      lines.push(
        `Removed forms: ${entry.subcommands.map((subcommand) => `\`${name} ${subcommand}\``).join(", ")}.`,
        ""
      )
    }
  }
  pages.set("docs/pages/migration/1.0.md", replaceRegion(source, "removed-commands", lines.join("\n")))
}

// -----------------------------------------------------------------------------
// Changelog index
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
