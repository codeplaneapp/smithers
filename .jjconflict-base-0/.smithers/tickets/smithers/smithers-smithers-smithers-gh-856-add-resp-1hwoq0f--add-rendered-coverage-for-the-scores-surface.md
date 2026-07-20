# Add rendered coverage for the scores surface

GitHub: https://github.com/smithersai/smithers/issues/1159

Parent: smithers/smithers-smithers-gh-856-add-responsive-ac-174ebeo--add-rendered-coverage-for-scores-crons-and-prompts.md

Context: navigation.spec.ts currently verifies only that /scores mounts. Add real browser coverage for the scores monitor surface. Acceptance criteria: cover the empty state; a populated state with score content; switching Summary, Metrics, and Recent tabs; and selecting a different run from the run selector, asserting the displayed content updates.
