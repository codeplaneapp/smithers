# Docs driven development

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Improve quality

The docs-driven-development system maintains this living spec: `features.json` is the source of truth, overview.md is editable product narrative, build.ts regenerates derived feature docs and UI modules, and the DDD workflow audits, triages, implements, and reviews gaps.

## What you can do

Keep an honest, code-backed product spec and turn open gaps into prioritized agent work without losing the product narrative.

## Capabilities

### Build gate

`bun .smithers/lib/ddd/build.ts validates features.json and regenerates derived docs and UI modules`.

### Improvement loop

`bootstrap`, `metaTicket`, `audit`, `spec-update`, `triage`, `materialize-tickets`, `work`, `cycle-review`, `round-summary`.

### Strict feature schema

featuresSchema.ts validates ids, statuses, priority, tier, endpoints, capabilities, and evidence ledger arrays.

### Derived docs

generateSpecDocs rebuilds one markdown doc per feature from `features.json` and never edits overview.md.

### UI modules

generateUiModules bundles features, docs content, backlog tickets, and workflow source for the DDD workflow UI.

### Durable improvement loop

docs-driven-development.tsx runs bootstrap, metaTicket, audit, spec update, triage, materialize tickets, implementation, review, and summary tasks.

## Endpoints and commands

- `SCRIPT bun .smithers/lib/ddd/build.ts` ([docs](.smithers/lib/ddd/build.ts))
- `WORKFLOW docs-driven-development` ([docs](.smithers/workflows/docs-driven-development.tsx))
- `UI .smithers/ui/docs-driven-development.tsx` ([docs](.smithers/ui/docs-driven-development.tsx))

## Related docs

- [Product overview](.smithers/spec/content/overview.md)
- [Feature source](.smithers/spec/features.json)

## Test cases

- `.smithers/tests/ddd-scripts.test.ts`
- `.smithers/tests/ddd-ui-parsers.test.ts`
- `.smithers/tests/docs-driven-development-run.e2e.test.ts`
- `.smithers/tests/docs-driven-development-workflow.test.ts`
- `.smithers/ui/ddd-tabs.test.tsx`
- `bun .smithers/lib/ddd/build.ts`

## Observability

- The DDD UI exposes feature matrix, docs, tickets, workflow source, and run state from generated modules and gateway data.
- Backlog tickets are generated from open feature statuses and missing\[\] entries so gaps stay visible.

## Debugging

- Run `bun .smithers/lib/ddd/build.ts after any features.json or overview.md change`; fix schema errors before committing.
- Do not hand-edit `.smithers/spec/content/features/`<id>.md or `.smithers/ui/ddd-*.generated.ts`; regenerate them.
- Do not edit running orchestration workflow files while using this generation task; record `workflow/script` bugs in feature missing\[\] instead.

## Architecture

- `.smithers/lib/ddd/featuresSchema.ts` is the strict zod schema for the spec source.
- `.smithers/lib/ddd/build.ts` validates `features.json`, regenerates derived feature docs, and regenerates UI content modules.
- `.smithers/workflows/docs-driven-development.tsx` defines the long-running improvement workflow and context constraints.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- 2026-07-06 adversarial review: reran `bun .smithers/lib/ddd/build.ts after spec corrections`; it validated 22 features and regenerated derived `docs/UI` modules.
- `.smithers/spec/features.json`
- `.smithers/spec/content/overview.md`
- `.smithers/lib/ddd/*.ts`
- `.smithers/ui/docs-driven-development.tsx`
- `.smithers/tests/ddd-*.test.ts`

## Open gaps

- Image upload target: Crepe ImageBlock needs an asset server; v1 wires ?assetBaseUrl passthrough but ships no asset server, so uploads are disabled when absent.
- Spec statuses can drift if refresh tasks do not run the `package/e2e` tests they cite; keep missing\[\] explicit when proof is absent.
