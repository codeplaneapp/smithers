/**
 * The review-docs production line: builds and maintains the repo-shaped
 * review tree in `<repo>/website` so reviewing the docs equals reviewing the
 * code. Deterministic steps run in-process (package manifest, vocs sidebar);
 * per-package maintenance runs as waves of parallel `AgentTask` steps; the
 * vocs build with dead-link checking runs as a `ShellTask` gate.
 *
 * Launch: `bun factory/flows/review-docs.ts`
 *         `--packages a,b,c` limits the agent wave, `--skip-agents` runs only
 *         the deterministic steps and the build gate, `--skip-build` skips
 *         the gate.
 * Progress: tail factory/reports/review-docs/<package>.log
 * Result:   factory/reports/REVIEW-DOCS.md
 */
import * as Schema from "effect/Schema"
import * as fs from "node:fs"
import * as path from "node:path"
import { Flow } from "../../packages/flow/src/index.ts"
import { Node } from "../../packages/plan/src/index.ts"
import {
  AgentTask,
  chunk,
  FLOWS_ROOT,
  listPackages,
  REPO_ROOT,
  REPORTS_DIR,
  runFlow,
  selectPackages,
  ShellTask,
  type TaskResult
} from "./harness.ts"

const WAVE_SIZE = 8
const MODEL = "claude-fable-5"
const AGENT_TIMEOUT_MS = 45 * 60_000
const BUILD_TIMEOUT_MS = 20 * 60_000

const WEBSITE = path.join(REPO_ROOT, "website")
const PAGES = path.join(WEBSITE, "docs/pages")
const MANIFEST = path.join(WEBSITE, ".review-docs-manifest.json")
const logDir = path.join(REPORTS_DIR, "review-docs")
const reportPath = path.join(REPORTS_DIR, "REVIEW-DOCS.md")

// ---------------------------------------------------------------------------
// Deterministic step 1: the package manifest. Deps and reverse deps from
// package.json, which target pages exist, and the prior-art api page in the
// flows docs site. Every agent prompt anchors to this file.
// ---------------------------------------------------------------------------
interface ManifestEntry {
  dir: string
  npmName: string
  description: string
  deps: Array<string>
  usedBy: Array<string>
  pagesPresent: Array<string>
  priorArtPath: string | null
}

const buildManifest = (packages: ReadonlyArray<string>): Record<string, ManifestEntry> => {
  const entries = new Map<string, ManifestEntry>()
  for (const pkg of packages) {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(FLOWS_ROOT, "packages", pkg, "package.json"), "utf8")
    ) as {
      name?: string
      description?: string
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const deps = [
      ...new Set(
        Object.keys({
          ...pkgJson.dependencies,
          ...pkgJson.devDependencies,
          ...pkgJson.peerDependencies
        })
      )
    ]
      .filter((dep) => dep.startsWith("@smthrs/"))
      .sort()
    const priorArt = path.join(FLOWS_ROOT, "docs/pages/api", `${pkg}.md`)
    entries.set(pkg, {
      dir: pkg,
      npmName: String(pkgJson.name ?? `@smthrs/${pkg}`),
      description: String(pkgJson.description ?? ""),
      deps,
      usedBy: [],
      pagesPresent: ["index", "api", "internals", "tests"].filter((page) =>
        fs.existsSync(path.join(PAGES, "flows/packages", pkg, `${page}.md`))
      ),
      priorArtPath: fs.existsSync(priorArt) ? priorArt : null
    })
  }
  const byNpm = new Map([...entries.values()].map((entry) => [entry.npmName, entry]))
  for (const entry of entries.values()) {
    for (const dep of entry.deps) {
      const target = byNpm.get(dep)
      if (target && target.dir !== entry.dir) target.usedBy.push(entry.dir)
    }
  }
  for (const entry of entries.values()) entry.usedBy.sort()
  const manifest = {
    root: FLOWS_ROOT,
    site: WEBSITE,
    pagesRoot: PAGES,
    packages: Object.fromEntries([...entries.entries()])
  }
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`)
  return manifest.packages
}

// ---------------------------------------------------------------------------
// Deterministic step 2: the vocs sidebar. Regenerated from the pages that
// exist on disk, with dead-link checking pinned on, so the sidebar can never
// drift from the tree and a dead link fails the build gate.
// ---------------------------------------------------------------------------
interface SidebarItem {
  text: string
  link?: string
  collapsed?: boolean
  items?: Array<SidebarItem>
}

const routeExists = (route: string): boolean => {
  const rel = route === "/" ? "index" : route.replace(/^\//, "").replace(/\/$/, "")
  return [`${rel}.md`, `${rel}.mdx`, `${rel}/index.md`, `${rel}/index.mdx`].some((candidate) =>
    fs.existsSync(path.join(PAGES, candidate))
  )
}

const buildSidebar = (): number => {
  const linkItems = (pairs: ReadonlyArray<readonly [string, string]>): Array<SidebarItem> =>
    pairs.filter(([, link]) => routeExists(link)).map(([text, link]) => ({ text, link }))

  const overview: SidebarItem = {
    text: "Overview",
    items: linkItems([
      ["Documentation index", "/"],
      ["Repo map", "/repo-map"],
      ["Architecture", "/architecture"],
      ["Data structures", "/data-structures"],
      ["Package structure", "/package-structure"],
      ["Public API", "/api"],
      ["Internals", "/internals"],
      ["Test contract", "/test-contract"],
      ["Observability", "/observability"],
      ["Examples", "/examples"],
      ["Design decisions", "/design-decisions"],
      ["External", "/external"],
      ["Methodology", "/contributing/methodology"],
      ["Epics", "/contributing/epics"],
      ["Reproducible media", "/contributing/media"]
    ])
  }

  const pkgsDir = path.join(PAGES, "flows/packages")
  const pkgDirs = fs.existsSync(pkgsDir)
    ? fs
      .readdirSync(pkgsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    : []
  const pkgItems: Array<SidebarItem> = pkgDirs
    .filter((pkg) => routeExists(`/flows/packages/${pkg}`))
    .map((pkg) => ({
      text: pkg,
      link: `/flows/packages/${pkg}`,
      collapsed: true,
      items: (
        [
          ["Public API", "api"],
          ["Internals", "internals"],
          ["Tests", "tests"]
        ] as const
      )
        .filter(([, stem]) => routeExists(`/flows/packages/${pkg}/${stem}`))
        .map(([text, stem]) => ({
          text,
          link: `/flows/packages/${pkg}/${stem}`
        }))
    }))

  const flowsGroup: SidebarItem = {
    text: "flows",
    items: [
      ...linkItems([
        ["Overview", "/flows"],
        ["Other code", "/flows/other-code"]
      ]),
      { text: "Packages", items: pkgItems }
    ]
  }

  const submodules = linkItems([
    ["agent", "/agent"],
    ["plugins", "/plugins"],
    ["mvp", "/mvp"],
    ["ui", "/ui"]
  ])

  const sidebar: Array<SidebarItem> = [overview, flowsGroup, ...submodules]
  const config = `import { defineConfig } from "vocs/config"

// Generated by flows/factory/flows/review-docs.ts: the sidebar mirrors the
// tree of pages that exist under docs/pages. Edit the factory flow, not this
// file, or the next run overwrites your change.
export default defineConfig({
  title: "flows",
  description:
    "A coding-agent harness where every unit of work is a reviewable, reusable flow with declared permissions.",
  srcDir: "docs",
  renderStrategy: "full-static",
  checkDeadlinks: true,
  sidebar: ${JSON.stringify(sidebar, null, 2).split("\n").join("\n  ")},
})
`
  fs.writeFileSync(path.join(WEBSITE, "vocs.config.ts"), config)
  return pkgItems.length
}

// ---------------------------------------------------------------------------
// The agent contract: idempotent per-package maintenance. Ensure the four
// pages exist, are complete, and match today's source; fix what drifted.
// ---------------------------------------------------------------------------
const promptFor = (pkg: string): string =>
  [
    `You maintain the review docs for ONE subpackage of the flows monorepo so a human can review the CODE purely by reading the DOCS. Faithfulness is everything: every claim must match today's source. Package: ${FLOWS_ROOT}/packages/${pkg}. Pages: ${PAGES}/flows/packages/${pkg}/{index,api,internals,tests}.md.`,
    `Read first: the "${pkg}" entry in ${MANIFEST} (npm name, deps, usedBy, which pages exist, priorArtPath), then the package source (package.json exports map, all of src/, every test file), then the four pages.`,
    "Ensure, fixing or writing whatever falls short:",
    "index.md holds the package's role, entry points, and Depends on / Used by lists matching the manifest, each name linking to /flows/packages/NAME.",
    "api.md enumerates the COMPLETE public API: every export of every entry point in the exports map, following re-export chains, in tables (Export | Kind | Notes) with GitHub source links (https://github.com/smithersai/flows/blob/main/packages/" +
    pkg +
    "/...). Delete rows for exports that no longer exist; add rows for new ones.",
    "internals.md covers the core data structures public AND private, their invariants, and a walkthrough of the main code path; correct anything the source contradicts.",
    "tests.md catalogs every test file with what it proves and keeps an honest Coverage gaps section.",
    "Rules: plain .md, one H1, every type expression or generic inside backticks (a bare angle bracket kills the MDX build), docs-to-docs links are root-absolute routes, only link packages present in the manifest.",
    `Write ONLY under ${PAGES}/flows/packages/${pkg}/. Never edit source code, never touch anything under ${FLOWS_ROOT} or reference/, never run git or jj, never commit.`,
    "When finished, print DONE followed by one line: exports documented, test files cataloged, corrections made."
  ].join(" ")

// ---------------------------------------------------------------------------
// The driver: manifest, agent waves, sidebar, build gate, report.
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const skipAgents = args.includes("--skip-agents")
const skipBuild = args.includes("--skip-build")

const allPackages = listPackages().filter((pkg) =>
  fs.existsSync(path.join(FLOWS_ROOT, "packages", pkg, "package.json"))
)
const packages = selectPackages(args, allPackages)

const startedAt = new Date().toISOString()
const initialManifest = buildManifest(allPackages)
console.log(
  `review-docs: manifest for ${Object.keys(initialManifest).length} packages, ` +
    `${skipAgents ? "agents skipped" : `${packages.length} maintenance seats`} `
)

const results: Array<TaskResult> = []
if (!skipAgents) {
  const waves = chunk(packages, WAVE_SIZE)
  for (let index = 0; index < waves.length; index++) {
    const wave = waves[index]!
    const WaveFlow = Flow.make(`factory/ReviewDocsWave${index}`, {
      payload: { run: Schema.String },
      success: Schema.Record(Schema.String, Schema.Unknown),
      body: () =>
        Node.all(
          Object.fromEntries(
            wave.map((pkg) => [
              pkg,
              AgentTask.call({
                id: pkg,
                prompt: promptFor(pkg),
                cwd: REPO_ROOT,
                model: MODEL,
                timeoutMs: AGENT_TIMEOUT_MS,
                logDir,
                completionMarker: "DONE",
                allowedPaths: [path.join(PAGES, "flows/packages", pkg)]
              })
            ])
          )
        )
    })
    console.log(`wave ${index + 1}/${waves.length}: ${wave.join(" ")}`)
    const waveResult = (await runFlow(
      WaveFlow,
      { run: startedAt },
      `review-docs-wave${index}-${startedAt}`
    )) as Record<string, TaskResult>
    for (const pkg of wave) {
      const result = waveResult[pkg]!
      results.push(result)
      console.log(`  ${pkg}: exit ${result.exitCode}`)
    }
  }
}

const manifest = buildManifest(allPackages)
const packagesListed = buildSidebar()
console.log(`sidebar: ${packagesListed} package entries, checkDeadlinks on`)

let build: TaskResult | null = null
if (!skipBuild) {
  const BuildFlow = Flow.make("factory/ReviewDocsBuild", {
    payload: { run: Schema.String },
    success: Schema.Record(Schema.String, Schema.Unknown),
    body: () =>
      Node.all({
        build: ShellTask.call({
          id: "vocs-build",
          command: "pnpm",
          args: ["run", "build"],
          cwd: WEBSITE,
          timeoutMs: BUILD_TIMEOUT_MS,
          logDir
        })
      })
  })
  const buildResult = (await runFlow(
    BuildFlow,
    { run: startedAt },
    `review-docs-build-${startedAt}`
  )) as Record<string, TaskResult>
  build = buildResult["build"]!
  console.log(`build gate: exit ${build.exitCode}`)
}

const lines = [
  "# Review docs tree",
  "",
  `Started ${startedAt}. ${Object.keys(manifest).length} packages in the manifest, ` +
  `${
    skipAgents ? "agent wave skipped" : `${results.length} maintenance seats (wave size ${WAVE_SIZE}, model ${MODEL})`
  }, ` +
  `${packagesListed} package entries in the sidebar, ` +
  `build gate ${build === null ? "skipped" : `exit ${build.exitCode}`}.`,
  "",
  "| Package | Exit | Log |",
  "| --- | --- | --- |",
  ...results.map(
    (result) => `| ${result.id} | ${result.exitCode} | ${path.relative(FLOWS_ROOT, result.logPath)} |`
  ),
  "",
  `Review the tree: \`cd ${path.relative(REPO_ROOT, WEBSITE)} && pnpm run dev\` (from the outer repo).`,
  ""
]
fs.mkdirSync(REPORTS_DIR, { recursive: true })
const failedAgents = results.filter((result) => result.exitCode !== 0)
const gateFailed = build !== null && build.exitCode !== 0
if (failedAgents.length > 0 || gateFailed) {
  process.exitCode = 1
  console.error(
    `review-docs failed: ${failedAgents.length} agent seat(s) and ${
      gateFailed ? 1 : 0
    } build gate(s) failed. No current report was published.`
  )
} else {
  fs.writeFileSync(reportPath, lines.join("\n"))
  console.log(`review-docs done. Report: ${reportPath}`)
}
