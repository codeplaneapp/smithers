#!/usr/bin/env node
/**
 * Builds the agent-facing documentation bundles from the vocs page tree.
 *
 *   docs/llms.txt                   the index an agent fetches first
 *   docs/llms-full.txt              every included page in one file
 *   docs/llms-<topic>.txt           one file per topic, the sections of the full bundle
 *   packages/cli/docs/llms.txt      the copy `smithers docs` prints
 *   packages/cli/docs/llms-full.txt the copy `smithers docs --full` prints
 *   packages/cli/docs/SKILL.md      the curated skill the CLI installs
 *   skills/smithers/llms-full.txt   the copy the installed skill carries
 *
 * The tree is the manifest. Every route under `docs/pages` belongs to exactly
 * one topic or to the recorded exclusion list, so a page cannot be added and
 * silently left out of the bundles. Nothing here reads a date or a clock: two
 * runs over one tree produce identical bytes.
 *
 * Run: node scripts/generate-llms.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { repoRoot } from "./docs-shared.mjs"
import { pages } from "./docs-pages.mjs"
import { assertRegenerable, checkVersionRelease, packageVersion, versionStamp } from "./llms-version-guard.ts"
import { optimize } from "./optimize-llms-full.ts"

/** One bundle: the routes it carries, in the order a reader should meet them. */
export interface Topic {
  readonly name: string
  readonly title: string
  readonly header: string
  readonly leading: ReadonlyArray<string>
  readonly matches: (route: string) => boolean
}

const startsWith = (...prefixes: ReadonlyArray<string>) => (route: string) =>
  prefixes.some((prefix) => route === prefix || route.startsWith(`${prefix}/`))

/**
 * The topics, in bundle order.
 *
 * A route is claimed by the first topic that matches it, so the order below is
 * also the precedence: `/api/...` reaches `api` before the `core` catch-all
 * would see it.
 */
export const topics: ReadonlyArray<Topic> = [
  {
    name: "core",
    title: "Smithers",
    header:
      "The everyday surface: what a flow is, how to write one, how to run one, and what the command line does.",
    leading: ["/", "/installation", "/guides/writing-a-flow", "/guides/running-flows", "/guides/getting-started"],
    matches: (route) =>
      route === "/" ||
      route === "/installation" ||
      route === "/package-structure" ||
      startsWith("/guides", "/concepts", "/cli", "/architecture")(route)
  },
  {
    name: "api",
    title: "Smithers API",
    header: "One page per published package: its exports, its layers, and its contracts.",
    leading: ["/api/flow", "/api/engine", "/api/flows"],
    matches: startsWith("/api")
  },
  {
    name: "control",
    title: "Smithers control plane",
    header: "The control requests a client sends, the projections a UI reads, and the transports that carry them.",
    leading: ["/control"],
    matches: startsWith("/control")
  },
  {
    name: "operations",
    title: "Smithers operations",
    header: "Running Smithers in production: storage, limits, recovery, telemetry, and what the release excludes.",
    leading: ["/release/support-matrix", "/release/known-limitations", "/databases"],
    matches: startsWith(
      "/release",
      "/databases",
      "/sqlite-operating-envelope",
      "/disaster-recovery",
      "/telemetry",
      "/observability",
      "/compaction",
      "/artifact-gc",
      "/selection",
      "/reference",
      "/routes"
    )
  },
  {
    name: "migration",
    title: "Smithers migration",
    header: "Moving a Smithers 0.x project to 1.0, and the compatibility promise that governs the move.",
    leading: ["/migration/1.0"],
    matches: (route) => startsWith("/migration")(route) || route === "/changelogs/compatibility-policy"
  },
  {
    name: "internals",
    title: "Smithers internals",
    header: "How the engine is built and why: the data structures, the decisions, and the comparisons.",
    leading: ["/architecture", "/data-structures"],
    matches: startsWith(
      "/internals",
      "/code-design",
      "/data-structures",
      "/design-decisions",
      "/comparisons",
      "/external",
      "/api-tests",
      "/examples",
      "/contributing"
    )
  }
]

/**
 * Routes that belong in no bundle.
 *
 * The Smithers 0.x changelogs are release history for a runtime this release
 * removed. An agent operating Smithers 1.0 is misled by them, and the migration
 * bundle already carries what replaced each surface.
 */
export const excluded = (route: string): boolean => route === "/changelogs" || /^\/changelogs\/0\./.test(route)

const separator = "\n\n---\n\n"

/**
 * Demotes every heading in a page body by one level, leaving code blocks alone.
 *
 * A bundle nests pages under a section heading, so a page's own `##` sections
 * have to sit below its title rather than beside it.
 */
export const demoteHeadings = (body: string): string => {
  let fenced = false
  return body
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced
        return line
      }
      if (fenced) return line
      return /^#{1,5} /.test(line) ? `#${line}` : line
    })
    .join("\n")
}

/** Renders one page as a bundle section: title, route, description, body. */
export const renderPage = (page: {
  readonly route: string
  readonly title?: string
  readonly description?: string
  readonly body: string
}): string => {
  const title = page.title ?? page.route
  const description = page.description === undefined ? "" : `> ${page.description}\n\n`
  const body = demoteHeadings(page.body.replace(/^#\s+.+\n+/, ""))
  return `## ${title}\n\nRoute: ${page.route}\n\n${description}${body.trimEnd()}\n`
}

/** Orders a topic's routes: its leading routes first, then the rest by route. */
export const orderRoutes = (topic: Topic, routes: ReadonlyArray<string>): ReadonlyArray<string> => {
  const leading = topic.leading.filter((route) => routes.includes(route))
  const rest = routes.filter((route) => !leading.includes(route)).sort((left, right) => left.localeCompare(right))
  return [...leading, ...rest]
}

/**
 * Builds every artifact from the current tree.
 *
 * Returns the artifact map rather than writing it, so a caller can compare
 * before deciding, and so importing this module for its helpers runs nothing.
 */
export const build = (): { readonly artifacts: Map<string, string>; readonly report: ReadonlyArray<string> } => {
  const version = packageVersion()

  const all = pages()
  const byRoute = new Map(all.map((page) => [page.route, page]))
  const assigned = new Map<string, string>()
  const orphans: Array<string> = []

  for (const page of all) {
    if (excluded(page.route)) continue
    const topic = topics.find((candidate) => candidate.matches(page.route))
    if (topic === undefined) {
      orphans.push(page.route)
      continue
    }
    assigned.set(page.route, topic.name)
  }

  if (orphans.length > 0) {
    throw new Error(
      `generate-llms: ${orphans.length} route(s) belong to no topic: ${orphans.join(", ")}.\n` +
        "Add the route to a topic in scripts/generate-llms.ts, or record it in `excluded`."
    )
  }

  const missingDescription = all.filter((page) => !excluded(page.route) && page.description === undefined)
  if (missingDescription.length > 0) {
    throw new Error(
      `generate-llms: ${missingDescription.length} page(s) have no frontmatter description: ` +
        `${missingDescription.map((page) => page.path).join(", ")}`
    )
  }

  const bundles = topics.map((topic) => {
    const routes = orderRoutes(topic, [...assigned].filter(([, name]) => name === topic.name).map(([route]) => route))
    const sections = routes.map((route) => renderPage(byRoute.get(route)!))
    const head = `# ${topic.title}\n\n> ${topic.header}\n${versionStamp(version)}\n`
    return { topic, routes, content: optimize(`${head}${separator}${sections.join(separator)}`) }
  })

  const fullHeader = [
    "# Smithers, complete documentation",
    "",
    `> Smithers is an Effect-based durable-execution engine. This file is every documentation page in one document, for an agent operating Smithers on someone's behalf.`,
    versionStamp(version),
    "",
    "Sections, in order:",
    ...bundles.map((bundle, index) => `  ${index + 1}. ${bundle.topic.title}: ${bundle.topic.header}`),
    "",
    "The Smithers 0.x changelogs are not included. Smithers 1.0 removed the runtime they describe; read the migration section instead.",
    ""
  ].join("\n")

  const full = optimize(`${fullHeader}${separator}${bundles.map((bundle) => bundle.content).join(separator)}`)

  const index = [
    "# Smithers",
    "",
    "> An Effect-based durable-execution engine: typed flows that replay from a journal, content-addressed action results, capability-checked host access, and a control plane that runs them.",
    versionStamp(version),
    "",
    "## The whole thing in one file",
    "",
    // A file reference, not a site path. This index ships beside its siblings in
    // three places (`docs/`, `packages/cli/docs/`, `skills/smithers/`), and the
    // site's own `/llms-full.txt` is a different document that vocs generates.
    "Read `llms-full.txt` beside this file. It contains every section below.",
    "",
    "## Sections",
    "",
    ...bundles.map((bundle) => `- ${bundle.topic.title}: ${bundle.topic.header}`),
    "",
    "## Where to start",
    "",
    "- Install and the release-candidate warning: /installation",
    "- Write a flow: /guides/writing-a-flow",
    "- Run one: /guides/running-flows",
    "- What the release does not do: /release/known-limitations",
    "- Move a 0.x project: /migration/1.0",
    "",
    "## Pointers",
    "",
    "- npm: @smthrs/cli, @smthrs/flow, @smthrs/engine, @smthrs/flows",
    "- github: github.com/smithersai/smithers",
    "- The Smithers 0.x changelogs are on the site at smithers.sh/changelogs and are not part of these bundles.",
    ""
  ].join("\n")

  const indexContent = optimize(index)

  const skillSource = join(repoRoot, "skills", "smithers", "SKILL.md")
  const artifacts = new Map<string, string>()
  for (const bundle of bundles) artifacts.set(`docs/llms-${bundle.topic.name}.txt`, bundle.content)
  artifacts.set("docs/llms-full.txt", full)
  artifacts.set("docs/llms.txt", indexContent)
  artifacts.set("packages/cli/docs/llms.txt", indexContent)
  artifacts.set("packages/cli/docs/llms-full.txt", full)
  artifacts.set("skills/smithers/llms-full.txt", full)

  let skill: string | undefined
  try {
    skill = readFileSync(skillSource, "utf8")
  } catch {
    skill = undefined
  }
  if (skill !== undefined) artifacts.set("packages/cli/docs/SKILL.md", skill)

  const report = [
    ...bundles.map((bundle) =>
      `  ${bundle.topic.name.padEnd(10)} ${String(bundle.routes.length).padStart(3)} pages  ${
        bundle.content.length.toLocaleString()
      } bytes`
    ),
    `  ${"full".padEnd(10)} ${String(assigned.size).padStart(3)} pages  ${full.length.toLocaleString()} bytes`,
    ...(skill === undefined
      ? ["  skills/smithers/SKILL.md is absent, so packages/cli/docs/SKILL.md was not written"]
      : [])
  ]

  return { artifacts, report }
}

/** Writes what {@link build} produced, refusing to rewrite a released bundle. */
export const main = (): void => {
  const { artifacts, report } = build()
  const changed: Array<string> = []
  for (const [path, content] of artifacts) {
    const absolute = join(repoRoot, path)
    let current: string | undefined
    try {
      current = readFileSync(absolute, "utf8")
    } catch {
      current = undefined
    }
    if (current !== content) changed.push(path)
  }

  assertRegenerable(
    packageVersion(),
    changed,
    changed.length === 0 ? "unreleased" : checkVersionRelease(packageVersion())
  )

  for (const [path, content] of artifacts) {
    const absolute = join(repoRoot, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }

  for (const line of report) console.log(line)
  console.log(`\n${artifacts.size} artifact(s) written, ${changed.length} changed.`)
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
}
