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

const cwd = "apps/site"

/** The pages, docs content, components, layouts, styles, scripts, and the Astro config. */
const sources = [
  Smithers.glob("//apps/site/src/**/*"),
  Smithers.glob("//apps/site/scripts/**/*"),
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

/** `astro build`: the static site, docs included, into `apps/site/dist`. */
const build = Smithers.ToolBuild({
  tool: "astro",
  command: "pnpm",
  args: ["run", "build"],
  inputs: sources,
  outputs: ["dist"],
  deps: [],
  env: {},
  cache: true,
  cwd
})

export const Package = Smithers.Package({ targets: { check, build } })
