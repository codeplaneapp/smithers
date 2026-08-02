# Render shared UI styles for the monitor root

GitHub: https://github.com/smithersai/smithers/issues/1146

Parent: smithers/smithers-gh-850-apply-the-shared-smithers--1v1he3o--migrate-monitor-shell-filters-and-actions--03o1ftc.md

Context: The monitor currently combines WorkflowUiStyles with monitor-local styling, while shared smthrs/ui components require SmithersUiStyles. Acceptance criteria: render SmithersUiStyles exactly once at the monitor root; preserve the existing theme behavior; ensure shared primitives receive their focus, disabled, hover, and active styles; remove any duplicate global control rules from monitor CSS; add a root-rendering style contract test.
