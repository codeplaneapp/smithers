# Docs driven development

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Author workflows

This workflow: a living product spec (`.smithers/spec/features.json` plus WYSIWYG content) with an audit, spec-update, triage, implement, review improvement loop and a five-tab custom UI.

## What you can do

Keep an honest, always-current spec of the product, review what changed across docs, audits, tickets, and live runs, then let agents burn down the highest-value gaps without losing the product narrative.

## Capabilities

### Build gate

`bun .smithers/lib/ddd/build.ts` validates `features.json` and regenerates derived docs and UI modules.

### Improvement loop

`bootstrap`, `metaTicket`, `audit`, `spec-update`, `triage`, `materialize-tickets`, `work`, `cycle-review`, `round-summary`.

## Test cases

- `.smithers/tests/ddd-bug-scan-run.e2e.test.ts`
- `.smithers/tests/ddd-generate-bug-scan.test.ts`
- `.smithers/tests/ddd-generate-docs-run.e2e.test.ts`
- `.smithers/tests/ddd-scripts.test.ts`
- `.smithers/tests/ddd-ui-parsers.test.ts`
- `.smithers/tests/docs-driven-development-run.e2e.test.ts`
- `.smithers/tests/docs-driven-development-ui.e2e.test.tsx`
- `.smithers/tests/docs-driven-development-workflow.test.ts`
- `.smithers/ui/ddd-tabs.test.tsx`

## Open gaps

- Image upload target: Crepe ImageBlock needs an asset server; v1 wires ?assetBaseUrl passthrough but ships no asset server (uploads disabled when absent)
