# Migrate monitor cards, panels, and statistics to shared Card anatomy

GitHub: https://github.com/smithersai/smithers/issues/1141

Parent: smithers/smithers-gh-850-apply-the-shared-smithers--1v1he3o--migrate-monitor-panels-statuses-alerts-pro-01r9eq9.md

Context: Monitor panels and statistics still use custom mon-panel and mon-stat markup. Acceptance criteria: use Card, CardHeader, and CardContent for representative monitor panels and statistic surfaces; preserve existing content, layout, data-testid attributes, and populated-state behavior; consume shared light and dark theme tokens.
