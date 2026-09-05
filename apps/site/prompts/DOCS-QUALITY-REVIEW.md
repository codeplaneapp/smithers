# Documentation quality review

Reviewed 2026-09-04 against the docs-skills collection and its Turborepo, Starlight, React, Stripe, and Nx exemplars. This report covers `apps/site`, its documentation generators, and the sources those generators publish. Changes elsewhere in the working tree were already in progress and are not part of this review.

## Editorial standard

The working standard combines Diátaxis with the collection's plain-language and source-verification rules:

- Tutorials lead to an observable result with stated prerequisites.
- Guides solve a named task and explain how to verify it.
- Concepts explain behavior and boundaries; references describe the actual contract.
- Code examples identify their files or make clear when they are excerpts.
- Claims about defaults, persistence, permissions, and failure behavior follow implementation evidence.
- Diagrams explain relationships or state transitions. They have useful captions and remain readable on phones.
- Navigation, search, headings, tables, and code blocks use the documentation framework's built-in conventions.
- Generated pages link to their editable source, and a reproducible check catches drift.

Primary skill material: `canonical--documentation-diataxis`, `mblode--docs-writing` (voice, clarity, scanning, structure, and procedure rules), and `guard-skills--docs-guard` in `~/docs-skills`. Existing `prompts/NOTES.md` supplied the site's authoring constraints.

## Preserved opening pages

The homepage, Overview, Installation, Quickstart, and `src/data/project.json` are byte-identical to the initial snapshot. Quickstart was protected as well as the first two documentation pages to avoid interpreting the requested boundary too narrowly.

Their design is deliberate: establish the product's value, show a concrete workflow, and let readers start without learning the package architecture. The homepage and Overview use a short scaffold-and-run path. Quickstart uses a project-specific suggestion to connect the product to work the reader already cares about. Installation isolates setup and version requirements. Those paths should remain short; moving reference details into them would weaken the opening.

The rest of the navigation now offers a model-free target tutorial and explicit task guides after that introduction.

## Substantive corrections

- Distinguished target caching from durable action caching, recovery from historical replay, and run identity from step identity.
- Corrected the claim that all side effects are journaled atomically. A remote request can complete before its outcome is recorded and can repeat after a crash.
- Corrected cancellation guarantees: recording descendant cancellation requests is atomic; every child is not necessarily stopped at that instant. Detached children have a separate lifetime policy.
- Corrected approval defaults and remembered-policy scope. Explicit approval defaults to `once`; `flow start` grants run scope.
- Updated guides and references for canonical `flow`, `runs`, and `approvals` commands. Retained compatibility routes, labeled them, and removed their duplication from the sidebar.
- Replaced the obsolete MCP tool list with the unified discovery and dispatch contract.
- Corrected seat-route documentation, including the false assertion that Cerebras had no resolver.
- Explained that budget enforcement estimates the next call and cannot guarantee an exact spending ceiling.
- Corrected follower cursor, application, and compaction guidance. A sync checkpoint does not contain an application's projection snapshot.
- Replaced the incomplete backup recipe with a stopped-writer copy of the complete state directory, including any SQLite WAL files.
- Rewrote example introductions at their TypeScript source and fixed the moved `TestHost` import and its package dependency.
- Removed internal development anecdotes, repetitive summaries, fake terminal output, and unsupported absolutes from current instructional pages.
- Repaired 53 historical release-note links against files present in the matching Git tags.

## Structure and Starlight

Added a guide hub, a target/cache tutorial, target-selection and remote-cache guides, a target-cache concept, and canonical command-group reference pages.

Eleven pages now use a shared static diagram component: durable execution, flow planning, content addressing, ownership, time travel, agent execution, capabilities, sync, target caching, child flows, and sandbox placement. Desktop diagrams use SVG with accessible descriptions. Narrow screens receive readable text cards with the same information. The diagrams do not require a client-side rendering library.

The review also uses Starlight Steps and FileTree where they clarify procedures and layouts, replaces an oversized reference card grid with a table, collapses long navigation groups, removes duplicate CLI overview navigation, labels compatibility pages, and excludes archived 0.x releases from the search index. Historical releases remain available through navigation and direct links.

Browser checks covered light and dark themes, desktop and 390-pixel layouts, search results, mobile step layout, code-copy controls, and console errors. Neither inspected mobile page overflowed the viewport.

## Generated content and sources

| Published output | Editable source | Generator or check |
| --- | --- | --- |
| Package API pages | Package `docs/api.md` | `scripts/sync-api-docs.mjs` |
| Flow, engine, and target reference pages | Package `docs/reference/*.md` | `scripts/ingest-reference.mjs` |
| Example pages | `examples/src/*.ts`; dedicated tests determine the test command | `scripts/gen-examples.mjs` |
| CLI help and command manifest | CLI declarations and package versions | `scripts/gen-cli-data.mjs` |
| Machine-readable documentation | The MDX pages, imported help, and shared project/version data | `scripts/generate-llms.mjs` and `scripts/docs-text.mjs` |
| Opening description and animation | `src/data/project.json` | Existing project-copy generator; source and outputs preserved |
| Archived release notes | Authored `src/content/docs/changelogs/*.mdx` | Built-site link and asset check |

Generated edit links point to their sources. `PACKAGE.ts` includes the added generator inputs and the machine-text regression test. CLI captures normalize the current directory to `<cwd>` instead of committing a checkout-specific path. The text exporter preserves imports inside example fences and expands imported help, version values, links, and diagram captions.

`check:docs` now checks the text exporter, page rules, package import subpaths, internal links and anchors, CLI captures, API/reference generation, examples, and machine-text drift. The build checks links and assets across every rendered page, including archived releases that the original content checker omitted.

## Verification

- All eight existing tutorial code-block targets passed against the workspace packages.
- The module-flow guide's complete program executed and printed `Hello, Ada.`.
- The target tutorial was executed in a separate initialized workspace: preview, first execution, repeat cache hit, changed-input miss, and a failing command with nonzero exit status. The successful input was restored afterward.
- A real CLI plan returned the documented `.approval` object used by the plan/approve guide.
- The offline example run passed 59 assertions; after fixing its missing helper import and dependency, the remaining host-adapter example passed its assertion. The live-provider test was skipped in the offline run. An earlier run with ambient credentials timed out on that live test; no live-provider success is claimed.
- The five machine-text regression tests passed.
- The docs-only Astro check returned zero errors and zero warnings, with one existing inline-script hint in the demo page.
- The static build produced 238 pages, and its full rendered link/asset check reported zero failures. The content check covered 191 current documentation pages with zero violations. The final command outputs are recorded in `/tmp/smithers-docs-review/`.

The full package `astro check` still reports two errors in untouched `alchemy.run.ts`: the installed Alchemy version has no default export and cannot resolve `alchemy/cloudflare`. That deployment configuration is outside the documentation edits. The successful site build is not a successful deployment check.

Remote-cache declaration and client guidance were checked against source; no deployed cache endpoint or production provider was exercised. Tutorial checks used the workspace packages, not a fresh install of every published release candidate.

## Turborepo comparison

The benchmark is the quality of a reader's path, not the number of pages or features.

| Criterion | Result of this review |
| --- | --- |
| Complete path from setup to a cache hit | Added and executed the target tutorial, including input invalidation and failure. |
| Explain what is cached and why a hit can be wrong | Target caching now covers key material, declared outputs, undeclared inputs, environment differences, and concrete diagnosis. |
| Configure shared reuse | Added a workspace declaration, read/write credential separation, and verification on a second checkout. |
| Explain dependencies visually | Added task/state diagrams where prose alone hid the relationship. |
| Recover from failure | Guides distinguish status from command exit, quota waits from crashes, cancellation requests from completed cancellation, and recovery from historical inspection. |
| Keep reference tied to implementation | Source links, captured CLI help, checked imports, generated-output checks, and compiled tutorials are part of the repository workflow. |
| Keep navigation and search relevant | Current task guides are discoverable; archived releases no longer compete with current instructions in search. |

Turborepo's [caching guide](https://turborepo.dev/docs/crafting-your-repository/caching) clearly distinguishes files from logs and explains missing output declarations. Its [environment guide](https://turborepo.dev/docs/crafting-your-repository/using-environment-variables) covers hashing, strict mode, and `.env` files. These were substantive standards to match, not weaknesses to invent. The local exemplar also has a strong machine-readable prerequisite/related-page graph.

My assessment: the reviewed Smithers execution and recovery paths now have strong operational explanations and direct verification, and the target/cache path meets the practical standard set by the benchmark. A blanket claim that every part of this site is better than Turborepo would exceed the evidence. Turborepo still has broader framework-specific guidance, and we have not measured independent readers' task completion. More diagrams or pages alone would not establish superiority.

## Suggestions for the protected opening, left unapplied

1. **Quickstart: update command spelling at the final step.** It currently sends targets to `smithers-build` and flows to `up`. Show canonical `smthrs <kind> <label>` and `smthrs flow start <flow>` while keeping the suggestion-driven sequence. This is the highest-priority consistency correction.
2. **Homepage and Overview: keep the short path, update shared copy once.** If adopting `flow start` there, edit `src/data/project.json` and run the existing project-copy generator so the homepage, Overview, and README stay aligned. Do not expand the opening into an architecture lesson.
3. **Overview: make the relationship to Quickstart explicit.** The two-command scaffold path and suggestion-driven Quickstart are useful alternatives, but they are not the same steps. Adjust the linking sentence. Consider a small link to the model-free target tutorial for readers evaluating caching first.
4. **Animation accessibility: shorten the image alternative text.** Keep a concise image description and move the long sequence description into nearby text or an accessible expanded description. Claims such as documentation that can “never drift” should be scoped to declared dependencies and checks.
5. **Installation: no substantive rewrite recommended.** Keep setup and exact runtime compatibility separate from workflow authoring.
