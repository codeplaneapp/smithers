---
status: landed
anchor: head
priority: p1
---

# Repo-shaped review docs tree, built by the factory

Make the code reviewable purely through the vocs docs: a tree in the outer
repo's `website/` site shaped like the repo itself. Repo-wide pages at the
root, one section per submodule, and one directory per workspace package with
one `index` plus exactly three leaves: `api` (every export of every entry point), `internals`
(core data structures, public and private, with their invariants), and
`tests` (every test file and what it proves). Every package page carries
Depends on / Used by lists from the dependency graph, and primary exports
cite the files that consume them. Reviewing the docs is equivalent to
reviewing the code; divergence is a defect.

## Landed

`factory/flows/review-docs.ts` owns the tree:

- Deterministic manifest (deps, reverse deps, page inventory) written to
  `website/.review-docs-manifest.json`; every agent prompt anchors to it.
- Waves of per-package maintenance agents keep the four pages complete and
  faithful to today's source; the contract is idempotent, so a run against a
  clean tree is a no-op wave.
- The vocs sidebar in `website/vocs.config.ts` is generated from the pages
  on disk with `checkDeadlinks: true` pinned; the config file is owned by the
  flow, never edited by hand.
- A `ShellTask` build gate runs the vocs build; a dead link or a bare
  angle-bracket generic in prose fails the run.
- Report: `factory/reports/REVIEW-DOCS.md`; per-package logs under
  `factory/reports/review-docs/`.

The initial tree (45 packages, 201 pages) was bootstrapped 2026-08-19 by the
outer repo's orchestration; this flow supersedes that machinery for all
maintenance. Run `bun factory/flows/review-docs.ts` for a full sweep,
`--packages a,b,c` for a targeted repair, `--skip-agents` for the
deterministic steps and build gate only.
