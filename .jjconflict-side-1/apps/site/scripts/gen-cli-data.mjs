/**
 * Generates the CLI data the docs import instead of retyping it.
 *
 *   bun apps/site/scripts/gen-cli-data.mjs          # write
 *   bun apps/site/scripts/gen-cli-data.mjs --check  # fail on drift, write nothing
 *
 * Outputs, all committed:
 *   apps/site/src/data/versions.json           cli, effect, and node versions from packages/smithers/package.json
 *   apps/site/src/data/removed-commands.json   every removed 0.x verb and flag
 *                                              with the anchor its CLI error links to
 *   apps/site/src/data/help/<verb>.txt         `smthrs <verb> --help`, verbatim
 *   apps/site/src/data/help/<verb>/<sub>.txt   the same for each subcommand
 *   apps/site/src/data/help/smthrs.txt       `smthrs --help`, verbatim
 *
 * The removed-command list and the anchors come from
 * packages/smithers/src/Unsupported.ts, which is also what the CLI reads when it
 * refuses a 0.x spelling. A page that renders this JSON therefore carries every
 * anchor the shipped error messages link to.
 *
 * The migration page's "Removed commands and flags" section is rendered from the
 * JSON between two marker comments; this script rewrites that region too, so the
 * anchors on the page and the anchors in the binary cannot drift apart.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "../../..")
const site = resolve(here, "..")
const dataDir = join(site, "src/data")
const helpDir = join(dataDir, "help")
const migrationPage = join(site, "src/content/docs/docs/migration/1.0.mdx")
const check = process.argv.includes("--check")

const unsupported = await import(join(root, "packages/smithers/src/Unsupported.ts"))

// One entry per anchor. Verbs anchor on their own name; flags carry an
// explicit anchor; reserved flow ids link to #flows.
const verbs = unsupported.removedVerbs.map((verb) => ({
  kind: "verb",
  anchor: verb.name,
  name: verb.name,
  group: verb.group,
  reason: verb.reason,
  subcommands: verb.subcommands ?? [],
  spellings: verb.subcommands === undefined
    ? [`smthrs ${verb.name}`]
    : verb.subcommands.map((sub) => `smthrs ${verb.name} ${sub}`)
}))
const flags = unsupported.removedFlags.map((flag) => ({
  kind: "flag",
  anchor: flag.anchor,
  name: flag.flag,
  parent: flag.parent,
  reason: flag.reason,
  spellings: [flag.parent === "" ? `--${flag.flag}` : `smthrs ${flag.parent} --${flag.flag}`]
}))
// Anchors written as literals elsewhere in the CLI (Legacy.ts and Project.ts
// link #run-data by hand). Scanning the source keeps the contract complete
// without a registry that someone has to remember to update.
const literalAnchors = new Set()
const scan = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) scan(path)
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      for (const m of readFileSync(path, "utf8").matchAll(/migration\/1\.0#([a-z0-9-]+)|\$\{migrationUrl\}#([a-z0-9-]+)/g)) {
        literalAnchors.add(m[1] ?? m[2])
      }
    }
  }
}
scan(join(root, "packages/smithers/src"))
const removedAnchors = [...new Set([...verbs.map((v) => v.anchor), ...flags.map((f) => f.anchor), "flows"])]
const removed = {
  migrationUrl: unsupported.migrationUrl,
  source: "packages/smithers/src/Unsupported.ts",
  verbs,
  flags,
  reservedFlows: { anchor: "flows", prefix: "system/" },
  anchors: [...new Set([...removedAnchors, ...literalAnchors])].sort(),
  removedAnchors
}

const cli = join(root, "packages/smithers/bin/smithers.mjs")
const help = (args) => {
  const result = spawnSync("node", [cli, ...args, "--help"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } })
  if (result.status !== 0) throw new Error(`smthrs ${args.join(" ")} --help exited ${result.status}\n${result.stderr}`)
  return result.stdout.trimEnd() + "\n"
}
const topHelp = help([])
const verbNames = [...topHelp.matchAll(/^  ([a-z][a-z-]*)(?:, [a-z-]+)*\s{2,}/gm)].map((m) => m[1])

// Versions the prose quotes: the CLI's own, the Effect pin, and the Node floor.
const cliManifest = JSON.parse(readFileSync(join(root, "packages/smithers/package.json"), "utf8"))
const versions = {
  cli: cliManifest.version,
  effect: cliManifest.dependencies?.effect ?? cliManifest.peerDependencies?.effect,
  node: (cliManifest.engines?.node ?? "").replace(/^[^0-9]*/, "")
}
for (const [name, value] of Object.entries(versions)) {
  if (!value) throw new Error(`could not read the ${name} version from packages/smithers/package.json`)
}

const outputs = new Map()
outputs.set(join(dataDir, "versions.json"), JSON.stringify(versions, null, 2) + "\n")
outputs.set(join(dataDir, "removed-commands.json"), JSON.stringify(removed, null, 2) + "\n")
outputs.set(join(helpDir, "smthrs.txt"), topHelp)
const subcommandsOf = (text) => {
  const block = text.split(/^SUBCOMMANDS\n/m)[1]
  if (block === undefined) return []
  return [...block.split(/\n\n/)[0].matchAll(/^  ([a-z][a-z-]*)(?:, [a-z-]+)*\s{2,}/gm)].map((m) => m[1])
}
for (const verb of verbNames) {
  const text = help([verb])
  outputs.set(join(helpDir, `${verb}.txt`), text)
  // One level of subcommands: `smthrs memory get --help` lands at help/memory/get.txt.
  for (const sub of subcommandsOf(text)) outputs.set(join(helpDir, verb, `${sub}.txt`), help([verb, sub]))
}

// The generated region of the migration page: one `###` per anchor. Reason
// and spellings come from the source; the "1.0 path" sentence is hand-written
// in migration-paths.json, and a missing entry fails the run so a new removal
// cannot ship without its replacement named.
const pathsFile = join(dataDir, "migration-paths.json")
const { paths, flagGroups } = JSON.parse(readFileSync(pathsFile, "utf8"))
const missingPaths = removedAnchors.filter((anchor) => !(anchor in paths))
if (missingPaths.length > 0) {
  throw new Error(`migration-paths.json has no "1.0 path" for: ${missingPaths.join(", ")}`)
}
const start = "{/* generated:removed-commands start. Run `bun apps/site/scripts/gen-cli-data.mjs`; do not edit. */}"
const end = "{/* generated:removed-commands end */}"
const sentence = (text) => `${text[0].toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`
const list = (items) =>
  items.length === 1 ? items[0] : items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`
const code = (items) => items.map((item) => `\`${item}\``)
const ordered = []
const groupOf = new Map()
for (const verb of verbs) {
  if (!ordered.includes(verb.anchor)) ordered.push(verb.anchor)
  groupOf.set(verb.anchor, verb.group)
}
for (const flag of flags) if (!ordered.includes(flag.anchor)) ordered.push(flag.anchor)
ordered.push("flows")
for (const anchor of ordered) if (!groupOf.has(anchor)) groupOf.set(anchor, flagGroups[anchor] ?? "Removed flags")
const section = [start, ""]
let group
for (const anchor of ordered) {
  if (groupOf.get(anchor) !== group) {
    group = groupOf.get(anchor)
    section.push(`**${group}.**`, "")
  }
  section.push(`### ${anchor}`, "")
  if (anchor === "flows") {
    section.push(paths[anchor], "")
    continue
  }
  const verbEntries = verbs.filter((v) => v.anchor === anchor)
  const flagEntries = flags.filter((f) => f.anchor === anchor)
  const reason = verbEntries[0]?.reason ?? flagEntries[0].reason
  const parts = []
  if (verbEntries.length > 0) parts.push(list(code(verbEntries.flatMap((v) => v.spellings))))
  if (flagEntries.length > 0) {
    const flagText = flagEntries.length === 1 ? "the flag " : "the flags "
    // A flag whose reason differs from the entry's reason carries its own, in parentheses.
    const spelled = flagEntries.map((f) =>
      f.reason === reason ? code(f.spellings)[0] : `${code(f.spellings)[0]} (${f.reason.replace(/ \((.+)\)$/, "; $1")})`
    )
    parts.push(flagText + list(spelled))
  }
  const line = `**Reason:** ${sentence(reason)} **Removed:** ${parts.join(", and ")}. **1.0 path:** ${paths[anchor]}`
  section.push(line, "")
}
section.push(end)
const region = section.join("\n")

if (existsSync(migrationPage)) {
  const page = readFileSync(migrationPage, "utf8")
  const a = page.indexOf(start)
  const b = page.indexOf(end)
  if (a === -1 || b === -1) {
    throw new Error(`${migrationPage} has no generated region; add the start and end markers under the removed-commands heading`)
  }
  const next = page.slice(0, a) + region + page.slice(b + end.length)
  const headings = new Set([...next.matchAll(/^### ([a-z0-9-]+)\s*$/gm)].map((m) => m[1]))
  const absent = removed.anchors.filter((anchor) => !headings.has(anchor))
  if (absent.length > 0) {
    throw new Error(`the CLI links to anchors the migration page does not carry: ${absent.map((x) => "#" + x).join(", ")}`)
  }
  outputs.set(migrationPage, next)
}

// The compatibility page quotes the frozen policy wording. README.md is the
// one place that wording lives, so the quoted paragraphs are copied from it.
const compatibilityPage = join(site, "src/content/docs/docs/migration/compatibility.mdx")
if (existsSync(compatibilityPage)) {
  const readme = readFileSync(join(root, "README.md"), "utf8")
  const block = readme.split(/^## Compatibility\s*$/m)[1]?.split(/^## /m)[0]
  if (block === undefined) throw new Error("README.md has no ## Compatibility section")
  const paragraphs = block.trim().split(/\n\n+/).map((p) => p.replace(/\n/g, " ").trim())
  const policy = paragraphs.filter((p) => /^Smithers 1\.0\.0-rc\.0 is a source migration|^Storage in rc\.0/.test(p))
  if (policy.length !== 2) throw new Error(`expected the two policy paragraphs in README.md, found ${policy.length}`)
  const startC = "{/* generated:compatibility-policy start. Quoted from README.md by `bun apps/site/scripts/gen-cli-data.mjs`; do not edit. */}"
  const endC = "{/* generated:compatibility-policy end */}"
  const page = readFileSync(compatibilityPage, "utf8")
  const a = page.indexOf(startC)
  const b = page.indexOf(endC)
  if (a === -1 || b === -1) throw new Error(`${compatibilityPage} has no generated region`)
  const quoted = policy.map((p) => `> ${p}`).join("\n\n")
  outputs.set(compatibilityPage, page.slice(0, a) + `${startC}\n\n${quoted}\n\n${endC}` + page.slice(b + endC.length))
}

let drift = 0
for (const [path, content] of outputs) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined
  if (current === content) continue
  drift += 1
  if (check) {
    console.error(`drift: ${path.replace(root + "/", "")} ${current === undefined ? "is missing" : "differs"}`)
  } else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    console.log(`wrote ${path.replace(root + "/", "")}`)
  }
}
if (check && drift > 0) process.exit(1)
if (drift === 0) console.log(check ? "up to date" : "nothing to write")
