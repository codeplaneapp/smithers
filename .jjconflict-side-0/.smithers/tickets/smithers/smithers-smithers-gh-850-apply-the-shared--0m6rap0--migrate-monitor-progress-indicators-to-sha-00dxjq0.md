# Migrate monitor progress indicators to shared Progress

GitHub: https://github.com/smithersai/smithers/issues/1143

Parent: smithers/smithers-gh-850-apply-the-shared-smithers--1v1he3o--migrate-monitor-panels-statuses-alerts-pro-01r9eq9.md

Context: RunProgressCell currently renders textual completion counts and failure text directly. Acceptance criteria: use the shared Progress component for run progress; preserve done, failed, total, and missing-summary semantics, accessible value information, existing row behavior, and any existing test identifiers; add representative progress tests.
