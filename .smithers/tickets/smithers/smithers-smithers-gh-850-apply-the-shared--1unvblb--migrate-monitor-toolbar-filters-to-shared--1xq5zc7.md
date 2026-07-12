# Migrate monitor toolbar filters to shared Input and Select

GitHub: https://github.com/smithersai/smithers/issues/1147

Parent: smithers/smithers-gh-850-apply-the-shared-smithers--1v1he3o--migrate-monitor-shell-filters-and-actions--03o1ftc.md

Context: The monitor toolbar contains search, status, and workflow filters whose behavior and data-testid attributes must remain stable while adopting shared UI primitives. Acceptance criteria: use shared Input for monitor-filter and shared Select primitives for monitor-status-filter and monitor-workflow-filter; preserve filtering, counts, refresh, and Metrics behavior; preserve all existing data-testid attributes; verify focus, disabled, and keyboard open/select/escape states with tests.
