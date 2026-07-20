# Add monitor light/dark theme integration coverage

GitHub: https://github.com/smithersai/smithers/issues/1036

Parent: smithers/gh-850-apply-the-shared-smithers-orchestrator-ui-design-s.md

Context: The shared UI package has light/dark token tests, but the monitor has no component-level theme verification and its bespoke CSS can diverge from the shared system. Acceptance criteria: test the monitor under explicit data-theme=light and data-theme=dark plus OS preference fallback; verify shell, controls, statuses, cards, alerts, progress, dialogs, empty states, and terminal surfaces use theme-resolved tokens without hard-coded theme-specific colors; include a repeatable monitor UI integration or static contract test in the CLI test suite.
