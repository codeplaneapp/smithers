/**
 * Targets for smithers.sh: the Astro site with the landing page, the
 * download page, and the Starlight documentation under /docs.
 *
 * The media the hero plays (public/media) is recorded, not built:
 * `scripts/record-tape.sh` runs real flows through vhs, and
 * `scripts/record-ui.mjs` drives the product UI under Playwright. Both need a
 * provider and a display, so neither is a target; the build ships whatever
 * recordings the tree carries.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"
import { Package as examplesPackage } from "../../examples/PACKAGE.ts"
import { Package as errorsPackage } from "../../packages/errors/PACKAGE.ts"
import { Package as chainPackage } from "../../packages/smithers/agent/chain/PACKAGE.ts"
import { Package as evalsPackage } from "../../packages/smithers/agent/evals/PACKAGE.ts"
import { Package as fsPackage } from "../../packages/smithers/agent/fs/PACKAGE.ts"
import { Package as harnessPackage } from "../../packages/smithers/agent/harness/PACKAGE.ts"
import { Package as integrationsPackage } from "../../packages/smithers/agent/integrations/PACKAGE.ts"
import { Package as memoryPackage } from "../../packages/smithers/agent/memory/PACKAGE.ts"
import { Package as modelPackage } from "../../packages/smithers/agent/model/PACKAGE.ts"
import { Package as agentPackage } from "../../packages/smithers/agent/PACKAGE.ts"
import { Package as pluginPackage } from "../../packages/smithers/agent/plugin/PACKAGE.ts"
import { Package as registryPackage } from "../../packages/smithers/agent/registry/PACKAGE.ts"
import { Package as scorersPackage } from "../../packages/smithers/agent/scorers/PACKAGE.ts"
import { Package as stdPackage } from "../../packages/smithers/agent/std/PACKAGE.ts"
import { Package as triggersPackage } from "../../packages/smithers/agent/triggers/PACKAGE.ts"
import { Package as targetsPackage } from "../../packages/smithers/build/targets/PACKAGE.ts"
import { Package as controlPackage } from "../../packages/smithers/control/PACKAGE.ts"
import { Package as createAppPackage } from "../../packages/smithers/create-app/PACKAGE.ts"
import { Package as artifactsPackage } from "../../packages/smithers/flows/artifacts/PACKAGE.ts"
import { Package as canonicalPackage } from "../../packages/smithers/flows/canonical/PACKAGE.ts"
import { Package as capabilityPackage } from "../../packages/smithers/flows/capability/PACKAGE.ts"
import { Package as corePackage } from "../../packages/smithers/flows/core/PACKAGE.ts"
import { Package as cryptoPackage } from "../../packages/smithers/flows/crypto/PACKAGE.ts"
import { Package as databasePackage } from "../../packages/smithers/flows/database/PACKAGE.ts"
import { Package as engineStorePackage } from "../../packages/smithers/flows/engine-store/PACKAGE.ts"
import { Package as enginePackage } from "../../packages/smithers/flows/engine/PACKAGE.ts"
import { Package as flowPackage } from "../../packages/smithers/flows/flow/PACKAGE.ts"
import { Package as jjPackage } from "../../packages/smithers/flows/jj/PACKAGE.ts"
import { Package as journalPackage } from "../../packages/smithers/flows/journal/PACKAGE.ts"
import { Package as kernelPackage } from "../../packages/smithers/flows/kernel/PACKAGE.ts"
import { Package as keysPackage } from "../../packages/smithers/flows/keys/PACKAGE.ts"
import { Package as observabilityPackage } from "../../packages/smithers/flows/observability/PACKAGE.ts"
import { Package as flowsPackage } from "../../packages/smithers/flows/PACKAGE.ts"
import { Package as patternsPackage } from "../../packages/smithers/flows/patterns/PACKAGE.ts"
import { Package as planPackage } from "../../packages/smithers/flows/plan/PACKAGE.ts"
import { Package as platformBrowserPackage } from "../../packages/smithers/flows/platform-browser/PACKAGE.ts"
import { Package as platformBunPackage } from "../../packages/smithers/flows/platform-bun/PACKAGE.ts"
import { Package as platformNodePackage } from "../../packages/smithers/flows/platform-node/PACKAGE.ts"
import { Package as runStorePackage } from "../../packages/smithers/flows/run-store/PACKAGE.ts"
import { Package as sandboxPackage } from "../../packages/smithers/flows/sandbox/PACKAGE.ts"
import { Package as stepCachePackage } from "../../packages/smithers/flows/step-cache/PACKAGE.ts"
import { Package as syncPackage } from "../../packages/smithers/flows/sync/PACKAGE.ts"
import { Package as timeTravelPackage } from "../../packages/smithers/flows/time-travel/PACKAGE.ts"
import { Package as gatewayPackage } from "../../packages/smithers/gateway/PACKAGE.ts"
import { Package as mcpPackage } from "../../packages/smithers/mcp/PACKAGE.ts"
import { Package as migratePackage } from "../../packages/smithers/migrate/PACKAGE.ts"
import { Package as notificationsPackage } from "../../packages/smithers/notifications/PACKAGE.ts"
import { Package as cliPackage } from "../../packages/smithers/PACKAGE.ts"
import { Package as testingPackage } from "../../packages/testing/PACKAGE.ts"
import { sites as docsSites } from "../docs/shared/manifest.mjs"

const cwd = "apps/site"

const supportDocs = Smithers.Generate({
  summary: "Project the RC support reference and entry pages from colocated docs.",
  script: Smithers.file("scripts/sync-support-docs.mjs"),
  data: [Smithers.glob("docs/**/*")],
  changes: [
    "src/content/docs/docs/reference/support-matrix.mdx",
    "src/content/docs/docs/reference/api/index.mdx",
    "src/content/docs/docs/installation.mdx",
    "src/content/docs/changelogs/1.0.0-rc.0.mdx"
  ]
})

/** The pages, docs content, components, layouts, styles, scripts, public assets, and Astro config. */
const sources = [
  Smithers.glob("//apps/site/src/**/*"),
  Smithers.glob("//apps/site/scripts/**/*"),
  Smithers.glob("//apps/site/public/**/*"),
  Smithers.file("//apps/server/src/publicRepoCatalog.ts"),
  Smithers.file("//apps/site/astro.config.mjs"),
  Smithers.file("//apps/site/package.json")
]

/** `astro check`: the pages and components typecheck against the package tsconfig. */
const check = Smithers.ToolRun({
  command: "pnpm",
  args: ["run", "check"],
  inputs: sources,
  deps: [],
  cwd
})

/** Build the site and verify its links against the CLI and release changelog. */
const build = Smithers.ToolBuild({
  tool: "astro",
  command: "pnpm",
  args: ["run", "build"],
  inputs: [...sources, Smithers.file("//CHANGELOG.md")],
  outputs: ["dist"],
  deps: [cliPackage.docsSources],
  env: {},
  cache: true,
  cwd
})

// --- reference docs pipeline ----------------------------------------------
// Generated reference pages. Each documented package writes its own
// `docs/reference/*.md` (its `referenceDocs` Agent.Diff target); this target
// is the deterministic ingest that copies them into
// src/content/docs/docs/reference/<area>/ with Starlight frontmatter. The
// committed copy is the cache: `smithers-build lint //apps/site:referenceIngest`
// fails on drift, `smithers-build target //apps/site:referenceIngest --write`
// applies. The data edges are the packages' `referencePages` filegroups, not
// their agent targets, so no verb here ever spawns a model.
const referenceIngest = Smithers.Generate({
  summary: "Copy colocated package reference pages into the docs tree; check drift under lint.",
  script: Smithers.file("scripts/ingest-reference.mjs"),
  data: [flowPackage.referencePages, enginePackage.referencePages, targetsPackage.referencePages],
  changes: ["src/content/docs/docs/reference/api/**", "src/content/docs/docs/reference/targets/**"]
})
// --- end reference docs pipeline ------------------------------------------

// --- CLI data --------------------------------------------------------------
// The CLI facts the docs quote instead of retyping: verbatim `--help` for
// every verb and subcommand, the version pins, the removed-command anchor
// contract (every `smithers.sh/migration/1.0#<anchor>` the binary links), and
// The script splices the anchor entries into the migration page, so
// `smithers-build lint //apps/site:cliData` fails the moment a removed verb or
// help string moves without the docs.
const cliData = Smithers.Generate({
  summary:
    "Regenerate CLI help captures, version pins, and the removed-command anchor contract; check drift under lint.",
  script: Smithers.file("scripts/gen-cli-data.mjs"),
  // `cliPackage.docsSources` is the CLI's src tree, README, docs, and
  // package.json by label. A `//packages/smithers/src/**` glob declared here
  // expands to nothing: input globs are package scoped, so a start inside
  // another package yields no files and the edge is vacuous.
  data: [
    cliPackage.docsSources,
    Smithers.file("src/data/migration-paths.json")
  ],
  changes: [
    "src/data/versions.json",
    "src/data/cli-commands.json",
    "src/data/removed-commands.json",
    "src/data/help/**",
    "src/content/docs/docs/migration/1.0.mdx"
  ]
})
// --- end CLI data ----------------------------------------------------------

// --- API reference pages ---------------------------------------------------
// One page per published package, stitched from its colocated docs/api.md by
// scripts/sync-api-docs.mjs. The script discovers packages off disk (a
// public @smthrs/* manifest beside a docs/api.md); this map is the same set
// as declared edges, keyed by the page slug the script writes. Each entry is
// the package's `docsFiles` filegroup (docs/**\/*.md, README, package.json),
// which is what makes `smithers-build lint //apps/site:apiDocs` rerun when a
// package's api.md or description moves. flow, engine, and targets are
// absent on purpose: ingest-reference.mjs owns their pages through
// `referenceIngest`, and the sync script skips those slugs.
const apiPackages = {
  agent: agentPackage,
  artifacts: artifactsPackage,
  canonical: canonicalPackage,
  capability: capabilityPackage,
  chain: chainPackage,
  cli: cliPackage,
  control: controlPackage,
  core: corePackage,
  "create-app": createAppPackage,
  crypto: cryptoPackage,
  database: databasePackage,
  "engine-store": engineStorePackage,
  errors: errorsPackage,
  evals: evalsPackage,
  flows: flowsPackage,
  fs: fsPackage,
  gateway: gatewayPackage,
  harness: harnessPackage,
  integrations: integrationsPackage,
  jj: jjPackage,
  journal: journalPackage,
  kernel: kernelPackage,
  keys: keysPackage,
  mcp: mcpPackage,
  memory: memoryPackage,
  migrate: migratePackage,
  model: modelPackage,
  notifications: notificationsPackage,
  observability: observabilityPackage,
  patterns: patternsPackage,
  plan: planPackage,
  "platform-browser": platformBrowserPackage,
  "platform-bun": platformBunPackage,
  "platform-node": platformNodePackage,
  plugin: pluginPackage,
  registry: registryPackage,
  "run-store": runStorePackage,
  sandbox: sandboxPackage,
  scorers: scorersPackage,
  std: stdPackage,
  "step-cache": stepCachePackage,
  sync: syncPackage,
  testing: testingPackage,
  "time-travel": timeTravelPackage,
  triggers: triggersPackage
}
const apiDocs = Smithers.Generate({
  summary: "Stitch every published package's docs/api.md into a reference page; check drift under lint.",
  script: Smithers.file("scripts/sync-api-docs.mjs"),
  data: Object.values(apiPackages).map((pkg) => pkg.docsFiles),
  changes: Object.keys(apiPackages).map((slug) => `src/content/docs/docs/reference/api/${slug}.mdx`)
})
// --- end API reference pages -----------------------------------------------

/**
 * One page per example program: its leading doc comment as prose and its
 * source as a fence, from `examples/src`. The examples are the tested programs
 * behind `pnpm run test:examples`, so the pages show code proven to run at
 * this commit. `lint` fails on drift; `--write` regenerates.
 */
const examplesPages = Smithers.Generate({
  summary: "Generate one docs page per example in examples/src; check drift under lint.",
  script: Smithers.file("scripts/gen-examples.mjs"),
  // The examples package's `docs` filegroup, not a glob: a glob declared here
  // never expands into examples/, so the label is the edge.
  data: [examplesPackage.docs],
  changes: ["src/content/docs/docs/examples/[0-9]*.mdx"]
})

/**
 * The compact agent index and full plain-text documentation bundle. Both read
 * the same project.json description as the rendered site and root README, so
 * the machine-facing one-sentence explanation cannot drift either.
 */
const llms = Smithers.Generate({
  summary: "Generate the compact and full LLM documentation bundles; check drift under lint.",
  script: Smithers.file("scripts/generate-llms.mjs"),
  data: [
    Smithers.glob("src/content/docs/**/*.mdx"),
    Smithers.file("src/data/project.json"),
    Smithers.file("src/data/versions.json"),
    Smithers.glob("src/data/help/**/*.txt"),
    Smithers.file("scripts/docs-text.mjs")
  ],
  changes: ["public/llms.txt", "public/llms-full.txt"]
})

/**
 * Checks documentation text extraction and built release URL resolution,
 * including redirects and migration anchors.
 */
const docsTextTest = Smithers.Shell.Test({
  shell: "node --test --test-concurrency=1 scripts/docs-text.test.mjs scripts/built-site.test.mjs",
  data: [
    Smithers.file("scripts/docs-text.mjs"),
    Smithers.file("scripts/docs-text.test.mjs"),
    Smithers.file("scripts/check-built-site.mjs"),
    Smithers.file("scripts/built-site.test.mjs")
  ]
})

/** Execute exact tutorial files and validate deployment entry points offline. */
const docsRuntimeTests = Smithers.Shell.Test({
  shell: "node --test --test-concurrency=1 scripts/tutorials.test.mjs scripts/deployment.test.mjs",
  data: [
    Smithers.file("scripts/tutorials.test.mjs"),
    Smithers.file("scripts/deployment.test.mjs"),
    Smithers.glob("src/content/docs/docs/tutorials/*.mdx"),
    Smithers.file("src/content/docs/docs/guides/child-flows.mdx"),
    Smithers.file("alchemy.run.ts"),
    Smithers.file("package.json"),
    Smithers.file("//apps/docs/shared/alchemy-site.mjs"),
    Smithers.file("//apps/docs/shared/alchemy-site.d.ts"),
    Smithers.file("//apps/docs/shared/manifest.mjs"),
    Smithers.file("//apps/docs/shared/package.json"),
    ...docsSites.map((site) => Smithers.file(`//apps/docs/${site.slug}/alchemy.run.ts`)),
    examplesPackage.docs,
    cliPackage.docsSources,
    flowPackage.docsSources,
    enginePackage.docsSources,
    agentPackage.lib,
    flowsPackage.lib,
    targetsPackage.lib
  ]
})

const docsLint = Smithers.Shell.Test({
  script: Smithers.file("scripts/check-docs.mjs"),
  data: [
    Smithers.glob("//apps/site/src/content/**/*"),
    Smithers.glob("//apps/site/src/pages/**/*"),
    Smithers.file("//apps/site/src/data/versions.json")
  ]
})

/**
 * Every `ts` fence on the hand-written tutorial pages compiles against the
 * real packages, so a tutorial cannot teach an API that does not ship. A
 * fence's `title="<file>"` names the file it is or extends; same-title fences
 * concatenate. The pages that continue the first tutorial's project list it
 * as `context`, so their `import "./durable-layer.ts"` resolves.
 */
const tutorialPage = (page: string) => Smithers.file(`src/content/docs/docs/tutorials/${page}.mdx`)
const tutorialTargetName = (page: string) =>
  `tutorial${page.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}CodeBlocks`
const tutorialCodeBlocks = Object.fromEntries(
  (
    [
      ["first-flow", []],
      ["crash-and-resume", ["first-flow"]],
      ["retry-policy", ["first-flow"]],
      ["human-approval", ["first-flow"]],
      ["time-travel", []],
      ["first-agent-flow", []],
      ["agent-outputs", []],
      ["memory", []]
    ] as const
  ).map(([page, context]) => [
    tutorialTargetName(page),
    Smithers.Markdown.CodeBlocks({ file: tutorialPage(page), lang: ["ts"], context: context.map(tutorialPage) })
  ])
)

/**
 * Build and documentation targets for the public site.
 *
 * @since 1.0.0
 * @category packages
 */
export const Package = Smithers.Package({
  targets: {
    check,
    build,
    supportDocs,
    referenceIngest,
    cliData,
    apiDocs,
    docsLint,
    docsTextTest,
    docsRuntimeTests,
    examplesPages,
    llms,
    ...tutorialCodeBlocks
  }
})
