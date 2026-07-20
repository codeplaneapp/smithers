# Add rendered coverage for the logs surface

GitHub: https://github.com/smithersai/smithers/issues/1156

Parent: smithers/smithers-smithers-gh-856-add-responsive-ac-174ebeo--add-rendered-coverage-for-logs-timeline-an-1ynrbl6.md

Context: The logs surface has populated transcript rendering and Follow, Hide noise, and Redact controls in apps/smithers/src/logs/LogsCanvas.tsx; the gateway logs route also has populated, empty, and error states. Acceptance criteria: Add browser-rendered coverage for the intended routed/component surface; cover representative agent, tool, noise, and secret-bearing lines plus the applicable empty/error state; exercise Follow, Hide noise, and Redact and assert their visible effects; assert no uncaught page errors.
