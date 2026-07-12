# Migrate monitor shell, filters, and actions to shared UI primitives

GitHub: https://github.com/smithersai/smithers/issues/1033

Parent: smithers/gh-850-apply-the-shared-smithers-orchestrator-ui-design-s.md

Context: The monitor currently uses WorkflowUiStyles plus bespoke mon-* controls and native input, select, and button markup. Replace the shell, topbar filters, rail rows, pagination, chips, and lifecycle actions with smithers-orchestrator/ui primitives. Acceptance criteria: render SmithersUiStyles at the monitor root; use Button, Input, Select, RowButton, and shared table primitives where applicable; preserve existing monitor behavior and data-testid attributes; remove duplicate control styling; add tests for focus, disabled, active, and keyboard states.
