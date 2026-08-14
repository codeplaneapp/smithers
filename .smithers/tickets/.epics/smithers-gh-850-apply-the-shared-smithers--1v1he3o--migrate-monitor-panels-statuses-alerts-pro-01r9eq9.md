# Migrate monitor panels, statuses, alerts, progress, and empty states

GitHub: https://github.com/smithersai/smithers/issues/1034

Parent: smithers/gh-850-apply-the-shared-smthrs-ui-design-s.md

Context: Monitor cards, status pills, banners, statistics, loading states, and progress indicators are currently custom mon-* markup and CSS. Acceptance criteria: use Card/CardHeader/CardContent, Badge/StatusPill, Alert, Progress, EmptyState, and Skeleton for the corresponding surfaces; preserve existing status tones, loading/error semantics, and data-testid attributes; ensure all surfaces consume shared tokens in light and dark themes; add component tests for representative populated, loading, empty, and failure states.
