/**
 * The route plan for the assets the disposition ledger keeps.
 *
 * The Mintlify-era documentation tree left three kinds of asset behind that the
 * ledger keeps rather than replaces: the release image trees, the 0.x
 * changelogs, and the SOTA model registry. Every one of them has to end up
 * somewhere a reader can reach, or be recorded as deleted with a reason. This
 * module derives that table from the ledger and the tree, so the plan cannot
 * drift from either.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { repoRoot } from "./docs-contract.mjs"

/** The machine-readable disposition ledger. */
export const ledgerPath = join(repoRoot, "docs", "migration", "disposition-ledger.json")

/** The three asset families the ledger keeps and this plan has to place. */
export const assetPrefixes = ["docs/images/", "docs/changelogs/", "docs/data/"]

/** Where Phase 4 moved each kept asset, and how a reader reaches it. */
export const placements = [
  {
    from: "docs/images/",
    to: "public/images/",
    route: (path) => `/${path.slice("public/".length)}`,
    note:
      "vocs resolves static assets as `<rootDir>/public`, and its rootDir is the repository root, so the changelog image links resolve unchanged"
  },
  {
    from: "docs/changelogs/",
    to: "docs/pages/changelogs/",
    route: (path) => `/${path.slice("docs/pages/".length).replace(/\.mdx?$/, "")}`,
    note: "a vocs page in the changelogs section"
  },
  {
    from: "docs/data/",
    to: "docs/data/",
    route: () => undefined,
    note:
      "retained at its committed path: an installed Smithers 0.x CLI fetches this file from the repository's main branch in its update check"
  }
]

/**
 * Files Phase 4 adds inside an asset family that no ledger row can claim.
 *
 * The ledger records what the Smithers 0.x tree held. A page this migration
 * writes into one of those directories is not a kept asset and not a deleted
 * one, so it is listed here rather than silently tolerated.
 */
export const additions = [
  {
    path: "docs/pages/changelogs/index.md",
    reason: "new in 1.0: the changelog index the sidebar links to, generated from the directory"
  }
]

/**
 * The Mintlify-era page roots, and where vocs publishes them now.
 *
 * vocs serves `docs/pages` and nothing else, so a page written to one of the
 * old roots builds no route, joins no sidebar section, and reaches no llms
 * bundle. It does not fail either: it just disappears. Recording the moves here
 * gives a reader the new path and gives `check-docs` something to fail on.
 */
export const movedTrees = [
  {
    from: "docs/reference/",
    to: "docs/pages/api/",
    route: "/api/<name>",
    note: "the per-package API reference, one page per published package",
    exceptions: [
      {
        from: "docs/reference/{go-targets,local-repositories,nix,package-workspace,stamps}.md",
        to: "docs/internal/build/",
        note: "build-system notes for this repository's own contributors, not part of the published site"
      },
      {
        from: "docs/reference/migrate.md",
        to: "docs/pages/migration/migrate-tool.md",
        note: "the migration tool is documented on the upgrade path a reader arrives by, not in the API reference"
      }
    ]
  },
  {
    from: "docs/concepts/",
    to: "docs/pages/concepts/",
    route: "/concepts/<name>",
    note: "the execution-model pages, page for page",
    exceptions: []
  },
  {
    from: "docs/guides/",
    to: "docs/pages/guides/",
    route: "/guides/<name>",
    note: "the task guides, page for page",
    exceptions: [
      {
        from: "docs/guides/migrating-from-0x.md",
        to: "docs/pages/migration/1.0.md",
        note: "rewritten as the 1.0 migration guide, which the removed-verb generator writes into"
      }
    ]
  },
  {
    from: "docs/architecture/",
    to: "docs/pages/architecture/",
    route: "/architecture/<name>",
    note: "the three architecture pages the release still describes",
    exceptions: [
      {
        from: "docs/architecture/design-decisions.md",
        to: "docs/pages/design-decisions.md",
        note: "a top-level page: the decisions are read on their own, not as a subsection"
      },
      {
        from: "docs/architecture/implementation-status.md",
        to: "docs/pages/release/support-matrix.md",
        note: "rewritten as the rc.0 support matrix, generated from contract section 3.1"
      },
      {
        from: "docs/architecture/{smithers-replacement-gaps,smithers-applicability-audit-2026-08-13}.md",
        to: "docs/migration/",
        note: "migration records rather than product pages; the gap ledger seeds the release known-limitations page"
      }
    ]
  }
]

/**
 * Routes this documentation links before the page answering them exists.
 *
 * One page of the site is written by the release-enforcement work from the
 * frozen contract's exclusion table. This lane links to its route and does not
 * author a second copy, so the link checker is told about the gap here instead
 * of being switched off. The entry expires by failing: once the page lands, the
 * route resolves and `deferredRouteProblems` asks for this list to shrink.
 */
export const deferredRoutes = [
  {
    route: "/release/known-limitations",
    owner: "release enforcement",
    reason:
      "the exclusion table is generated from release contract section 7 by its owning work, and two writers on one path collide at landing"
  }
]

/**
 * Deferred entries that have outlived their gap, given the routes that exist.
 *
 * A deferred route whose page has landed is no longer deferred, and leaving the
 * entry in place would hide the next broken link behind it.
 */
export const deferredRouteProblems = (routes) =>
  deferredRoutes
    .filter((entry) => routes.has(entry.route))
    .map((entry) => `${entry.route} exists now: drop it from the deferred routes in scripts/docs-routes.mjs`)

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else out.push(relative(repoRoot, path))
  }
  return out
}

/**
 * The stand-in a `**` becomes while the single-star rule runs.
 *
 * It is spelled as an escape rather than written literally: a raw NUL in the
 * source makes git treat this file as binary and stop diffing it.
 */
const sentinel = "\u0000"

/**
 * Turns a ledger glob into a regular expression over repository paths.
 *
 * `**` is converted in two passes through the sentinel above so the
 * single-star rule cannot rewrite half of it.
 */
export const globToRegExp = (glob) => {
  const escaped = glob.replace(/[.+^${}()[\]]/g, (character) => `\\${character}`)
  const pattern = escaped.replace(/\*\*\/?/g, sentinel).replace(/\*/g, "[^/]*").replaceAll(sentinel, ".*")
  return new RegExp(`^${pattern}$`)
}

/** The ledger rows that name one of the asset families, by disposition. */
export const assetRows = (ledger = JSON.parse(readFileSync(ledgerPath, "utf8"))) =>
  ledger.entries
    .filter((entry) => Array.isArray(entry.path))
    .map((entry) => ({
      label: entry.label,
      disposition: entry.disposition,
      globs: entry.path.filter((glob) => assetPrefixes.some((prefix) => glob.startsWith(prefix)))
    }))
    .filter((entry) => entry.globs.length > 0)

/** The old path of an asset Phase 4 moved, or the path itself. */
export const originalPath = (path) => {
  for (const placement of placements) {
    if (placement.to !== placement.from && path.startsWith(placement.to)) {
      return `${placement.from}${path.slice(placement.to.length)}`
    }
  }
  return path
}

/** Every kept asset in the tree today, with where it lives and how it is read. */
export const routePlan = (ledger = JSON.parse(readFileSync(ledgerPath, "utf8"))) => {
  const rows = assetRows(ledger)
  // A `keep` row survives unchanged and a `migrate` row is rewritten in place;
  // both must end up on a route. A `delete` or `replace` row must be gone.
  const kept = rows.filter((row) => row.disposition === "keep" || row.disposition === "migrate")
  const dropped = rows.filter((row) => row.disposition === "delete" || row.disposition === "replace")
  const keptPatterns = kept.flatMap((row) => row.globs.map(globToRegExp))
  const droppedPatterns = dropped.flatMap((row) => row.globs.map(globToRegExp))

  const present = placements.flatMap((placement) => walk(join(repoRoot, placement.to)))
  const entries = []
  const problems = []

  for (const path of present.sort()) {
    const placement = placements.find((candidate) => path.startsWith(candidate.to))
    if (placement === undefined) continue
    if (additions.some((addition) => addition.path === path)) continue
    const before = originalPath(path)
    // A page rewritten from Mintlify MDX to vocs Markdown keeps its name and
    // changes its extension, so both spellings answer for the same asset.
    const spellings = [before, before.replace(/\.mdx$/, ".md"), before.replace(/\.md$/, ".mdx")]
    const matches = (pattern) => spellings.some((spelling) => pattern.test(spelling))
    const isKept = keptPatterns.some(matches)
    const isDropped = droppedPatterns.some(matches)
    if (!isKept && isDropped) {
      problems.push(`${path} is present although the ledger deletes it (${before})`)
      continue
    }
    if (!isKept) {
      problems.push(`${path} is present although no ledger keep row claims it (${before})`)
      continue
    }
    entries.push({ path, before, route: placement.route(path), note: placement.note })
  }

  for (const row of kept) {
    for (const glob of row.globs) {
      const pattern = globToRegExp(glob)
      const covered = entries.some((entry) =>
        [entry.before, entry.before.replace(/\.mdx$/, ".md"), entry.before.replace(/\.md$/, ".mdx")].some((spelling) =>
          pattern.test(spelling)
        )
      )
      if (covered) continue
      problems.push(`the ledger keeps ${glob} but nothing in the tree matches it`)
    }
  }

  const deletions = []
  for (const row of dropped) {
    for (const glob of row.globs) {
      const pattern = globToRegExp(glob)
      const survivors = present.filter((path) => pattern.test(originalPath(path)))
      deletions.push({ glob, label: row.label, disposition: row.disposition, survivors })
      for (const survivor of survivors) problems.push(`${survivor} matches the ${row.disposition} glob ${glob}`)
    }
  }

  return { entries, deletions, problems }
}

/** Files left in a page root vocs does not publish. */
export const movedTreeProblems = () => {
  const problems = []
  for (const moved of movedTrees) {
    for (const path of walk(join(repoRoot, moved.from)).sort()) {
      problems.push(`${path} is not published: this tree moved to ${moved.to} (${moved.route})`)
    }
  }
  return problems
}
