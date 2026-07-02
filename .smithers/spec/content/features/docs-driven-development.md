# Docs driven development

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Author workflows

This workflow: a living product spec (`.smithers/spec/features.json` plus WYSIWYG content) with an audit, spec-update, triage, implement, review improvement loop and a five-tab custom UI.

## What you can do

Keep an honest, always-current spec of the product and let agents burn down its gaps.

## Capabilities

### Build gate

`bun .smithers/lib/ddd/build.ts` validates `features.json` and regenerates derived docs and UI modules.

### Improvement loop

`bootstrap`, `metaTicket`, `audit`, `spec-update`, `triage`, `materialize-tickets`, `work`, `cycle-review`, `round-summary`.

## Open gaps

- Mermaid diagram preview in the Docs tab
- Image upload target: Crepe ImageBlock needs an asset server; v1 wires ?assetBaseUrl passthrough but ships no asset server (uploads disabled when absent)
- Only work:1 single-agent wave, matching multi's SQLite-fanout caution
