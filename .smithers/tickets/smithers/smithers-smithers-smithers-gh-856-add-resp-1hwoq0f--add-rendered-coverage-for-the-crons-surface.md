# Add rendered coverage for the crons surface

GitHub: https://github.com/smithersai/smithers/issues/1160

Parent: smithers/smithers-smithers-gh-856-add-responsive-ac-174ebeo--add-rendered-coverage-for-scores-crons-and-prompts.md

Context: navigation.spec.ts currently verifies only that /crons mounts. Add real browser coverage for the cron/triggers surface. Acceptance criteria: cover empty and populated list states; opening and completing the create flow; required-field and invalid-pattern validation; enabling and disabling a cron; requesting and confirming deletion; and asserting the resulting list/detail state.
