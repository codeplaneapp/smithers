# Expand rendered coverage for workflow UI surfaces

GitHub: https://github.com/smithersai/smithers/issues/1053

Parent: smithers/smithers-gh-856-add-responsive-accessibili-1wvv7n1--add-rendered-coverage-for-major-monitor-surfaces.md

Context: workflow-ui.spec.ts and create-workflow-ui.spec.ts cover selected custom UIs but not a broad state matrix. Acceptance criteria: Cover representative populated and empty run states, live connection status, run selection/event rendering, tabbed custom UI states, disabled/enabled launch controls, and uncaught runtime-error detection for registered workflow UIs.


> Closed by ticket-fleet sync: apps/smithers/tests/e2e/workflow-ui.spec.ts covers populated and empty states, live Connected/online status, run selection and event frames, launch controls, and page errors for every registered hasUi workflow. apps/smithers/tests/e2e/create-workflow-ui.spec.ts covers all tabs, selected-state switching, empty/populated content surfaces, disabled-to-enabled Build controls, gateway registration, and uncaught errors. apps/smithers/tests/e2e/globalSetup.ts seeds the real gateway via launchRun/listRuns/listApprovals, while playwright.config.ts runs these against the real app and gateway without mocks.
