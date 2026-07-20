# @smithers-orchestrator/ui-styleguide — src

Shipped-as-source `.ts` module: the package's exports map points straight at
`src/index.ts` (no build step, no dependencies).

Exports three CSS strings:

- `workflowUiThemeCss` — design tokens plus base element/primitive classes
  (buttons, inputs, pills/badges, cards, tables, code/livelog). Light theme by
  default, dark via `@media (prefers-color-scheme: dark)` PLUS
  `:root[data-theme='dark']` / `:not([data-theme='light'])` overrides so an
  explicit theme toggle wins in both directions.
- `workflowUiLayoutCss` — the `.workflow-*` shell/dashboard grid classes.
- `workflowUiStyles` — both joined, for one-tag embedding.

Token aliases like `--panel`/`--line`/`--ok`/`--err` map legacy names onto the
canonical tokens so older workflow UI CSS keeps working — extend the alias
list, don't remove entries.
