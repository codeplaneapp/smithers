# Apply the shared Smithers UI design system and themes to the monitor

GitHub: https://github.com/smithersai/smithers/issues/990

Parent: smithers/gh-643-make-smithers-monitor-truly-beautiful-matc-00hgmat.md

Context: smithers monitor currently uses bespoke mon-* markup and CSS despite the shared @smithers-orchestrator/ui component library and ui-styleguide tokens used by the other gateway surfaces. Acceptance criteria: refactor the monitor shell and common controls to shared UI components where applicable; use shared anatomy, spacing, typography, borders, shadows, and status treatments; verify light mode, dark mode, OS theme detection, and explicit theme overrides; add tests that validate the monitor bundle uses the shared themed component styles and contains no theme-pinning raw colors.
