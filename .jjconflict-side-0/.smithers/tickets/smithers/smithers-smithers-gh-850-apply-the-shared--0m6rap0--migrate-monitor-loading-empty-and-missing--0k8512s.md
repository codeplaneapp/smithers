# Migrate monitor loading, empty, and missing-data states to Skeleton and EmptyState

GitHub: https://github.com/smithersai/smithers/issues/1144

Parent: smithers/smithers-gh-850-apply-the-shared-smithers--1v1he3o--migrate-monitor-panels-statuses-alerts-pro-01r9eq9.md

Context: Runs rail, runs table, run detail, crons, metrics, and related surfaces use custom mon-empty and inline loading or error markup. Acceptance criteria: use Skeleton for loading surfaces and EmptyState for empty or missing-data surfaces; preserve loading, failure, last-known-data, and no-results semantics, messages, actions, and data-testid attributes.
