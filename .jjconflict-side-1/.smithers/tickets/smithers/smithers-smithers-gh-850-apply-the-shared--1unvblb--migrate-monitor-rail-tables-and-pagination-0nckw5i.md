# Migrate monitor rail, tables, and pagination controls

GitHub: https://github.com/smithersai/smithers/issues/1148

Parent: smithers/smithers-gh-850-apply-the-shared-smithers--1v1he3o--migrate-monitor-shell-filters-and-actions--03o1ftc.md

Context: The monitor runs rail and landing overview use selectable run rows, shared tables, and paginated results. Acceptance criteria: use RowButton for rail rows with active-state semantics; use shared Table primitives for applicable run and cron tables; use shared Button for pagination while preserving page boundaries, row selection, data-testid attributes, and existing data; add active, focus, keyboard, and disabled-state tests.
