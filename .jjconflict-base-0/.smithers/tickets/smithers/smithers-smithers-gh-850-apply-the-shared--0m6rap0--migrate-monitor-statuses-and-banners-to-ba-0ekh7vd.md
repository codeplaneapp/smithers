# Migrate monitor statuses and banners to Badge, StatusPill, and Alert

GitHub: https://github.com/smithersai/smithers/issues/1142

Parent: smithers/smithers-gh-850-apply-the-shared-smithers--1v1he3o--migrate-monitor-panels-statuses-alerts-pro-01r9eq9.md

Context: Run and cron statuses, connection states, and result banners still use custom mon-pill, mon-conn, and mon-banner markup. Acceptance criteria: use Badge or StatusPill for status surfaces and Alert anatomy for banners; preserve status-tone mapping, labels, data-status and data-testid attributes, connection guidance, and dismissal or recovery actions.
