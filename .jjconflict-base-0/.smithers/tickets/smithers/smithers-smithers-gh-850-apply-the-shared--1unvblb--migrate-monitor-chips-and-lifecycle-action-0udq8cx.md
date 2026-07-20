# Migrate monitor chips and lifecycle actions to shared primitives

GitHub: https://github.com/smithersai/smithers/issues/1149

Parent: smithers/smithers-gh-850-apply-the-shared-smithers--1v1he3o--migrate-monitor-shell-filters-and-actions--03o1ftc.md

Context: Monitor chips and lifecycle or navigation actions still include native buttons and monitor-specific control styling in connection recovery, run-id copying, approvals, tree navigation, timeline rows, frame scrubbing, and run lifecycle actions. Acceptance criteria: replace applicable native interactive controls with Button, RowButton, Input, or other shared primitives; preserve behavior, accessibility semantics, keyboard interaction, disabled states, and existing data-testid attributes; retain monitor-only styling only for visual accents; add regression tests for focus, active, disabled, and keyboard states.
